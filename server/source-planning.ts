import { join } from "node:path";
import { z } from "zod";
import {
  type CreativePlan,
  CreativePlanResponseSchema,
  type LearningSignal,
  PlanCritiqueSchema,
  type ReferenceAnalysis,
  ReferenceAnalysisResponseSchema,
} from "../shared/creative-plan";
import { MediaAnalysisStatusSchema } from "../shared/media-analysis";
import { ArtifactModelSchema, type ModelResult } from "../shared/models";
import { normalizePlanTargets } from "../shared/persuasion-chain";
import type { Strategy } from "../shared/planning";
import type { Job } from "../shared/schema";
import type { ProjectSource } from "../shared/sources";
import { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { BlockedError, StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import {
  fillSection,
  type InstructionsSnapshot,
  instructionsEventMessage,
  instructionsStamp,
  loadInstructions,
  sectionOf,
} from "./instructions";
import { snapshotModels } from "./model-settings";
import type { OpenAIConnection } from "./provider-transport";
import { saveArtifactOnce } from "./render-state-helpers";
import { planStructureProblems, validatePlanEvidence } from "./source-evidence";
import type { JobStore } from "./store";
import { generateTextResult } from "./text-provider";

// 자료 기획 3개 프롬프트(reference_structure·source_creative_plan·creative_plan_critique)의 문구는 instructions/planning.md 의 절이다.
// 공통 머리(SOURCE_PLAN_GUARD)와 본문은 호출 때 읽은 스냅샷에서 가져온다(고친 파일은 다음 생성부터 반영).
const guardOf = (instructions: InstructionsSnapshot) =>
  sectionOf(instructions, "SOURCE_PLAN_GUARD");
const CachedSchema = z.object({
  value: ReferenceAnalysisResponseSchema,
  model: ArtifactModelSchema,
});
const mediaAnalysisRowSchema = z.object({
  asset_body: z.string(),
  analysis_body: z.string(),
});
const sqliteTableRowSchema = z.object({ name: z.string() });
type PlanningMediaAnalysis = {
  readonly assetId: string;
  readonly kind: "image" | "video";
  readonly sourceUrl: string;
  readonly sampling: string;
  readonly cuts: {
    readonly startSec: number;
    readonly endSec: number;
    readonly screenComposition: string;
    readonly onScreenText: string;
    readonly messageText: string;
  }[];
  readonly transcript: {
    readonly startSec: number;
    readonly endSec: number;
    readonly text: string;
  }[];
  readonly limitations: string[];
};
// Meta 도움말: 광고 세트가 크게 수정된 뒤 약 1주일에 50회 전후의 최적화 결과를 얻으면 학습이 안정되는 경우가 일반적이다.
// 권장 예산이 아니라 "이 예산으로 주 50건이 가능하려면 결과당 비용이 얼마 이하여야 하는가"의 단순 계산이다.
export function learningSignal(job: Job, conceptCount: number): LearningSignal | null {
  if (!job.dailyBudget) return null;
  const weeklyBudget = job.dailyBudget * 7;
  return {
    optimizationResult: job.objective === "sales" ? "purchase" : "link_click",
    dailyBudget: job.dailyBudget,
    weeklyBudget,
    currency: job.currency,
    weeklyResultsReference: 50,
    maxCostPerResultFor50: weeklyBudget / 50,
    conceptCount,
  };
}
export class SourcePlanner {
  constructor(
    readonly store: JobStore,
    readonly connection?: OpenAIConnection,
  ) {
    store.db.run(
      "CREATE TABLE IF NOT EXISTS reference_analysis_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }
  async plan(
    job: Job,
    strategy: Strategy,
    signal: AbortSignal,
  ): Promise<ModelResult<CreativePlan>> {
    const snapshot = job.sourceSnapshot;
    if (!snapshot || !evidencePack(snapshot).facts.length)
      throw new BlockedError(
        "프로젝트에 확인된 제품 사실 또는 오퍼 본문을 추가한 새 작업이 필요합니다.",
      );
    const models = job.executionModels ?? snapshotModels(this.store.root);
    const imageCount =
      job.automation?.policy.mode === "creative" ? (job.automation.policy.imageCount ?? 3) : 3;
    const directory = join(this.store.root, "cli", job.id);
    let instructions = loadInstructions();
    const pack = evidencePack(snapshot);
    const references = pack.references;
    const referenceAnalyses: ReferenceAnalysis[] = [];
    this.store.agent(job.id, "creative", {
      status: "running",
      action: `레퍼런스 ${references.length}개 구조 관찰 · 추정과 미확인 항목 분리 중`,
    });
    for (const source of references) {
      signal.throwIfAborted();
      const mediaAnalyses = this.completedMediaAnalyses(source);
      const key = contentDigest(
        JSON.stringify({
          version: 2,
          digest: source.digest,
          mediaAnalyses,
          provider: models.textProvider,
          model:
            models.textProvider === "codex"
              ? models.codexModel
              : models.textProvider === "claudeCode"
                ? models.claudeCodeModel
                : models.textModel,
        }),
      );
      const cached = this.store.db
        .query("SELECT body FROM reference_analysis_cache WHERE key = ?")
        .get(key);
      this.store.agent(job.id, "creative", {
        status: "running",
        action: `${source.title} · ${cached ? "저장된 구조 관찰 재사용" : "본문 구조 관찰 중"}`,
      });
      const analysis = cached
        ? CachedSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(cached).body))
        : await generateTextResult(
            {
              name: "reference_structure",
              schema: ReferenceAnalysisResponseSchema,
              directory,
              signal,
              models,
              maxOutputTokens: 1400,
              prompt: `${guardOf(instructions)}\n${sectionOf(instructions, "SOURCE_REFERENCE_STRUCTURE")}\nREFERENCE DATA:\n${JSON.stringify({ sourceId: source.id, content: source.content, mediaAnalyses })}`,
            },
            this.connection,
          );
      if (!cached)
        this.store.db
          .query("INSERT OR REPLACE INTO reference_analysis_cache (key, body) VALUES (?, ?)")
          .run(key, JSON.stringify(analysis));
      referenceAnalyses.push({ ...analysis.value, sourceId: source.id });
    }
    const facts = pack.facts.map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      content: source.content,
    }));
    const voices = pack.voices.map((source) => ({
      sourceId: source.id,
      content: source.content,
      reviewOf: source.reviewOf ?? "unknown",
      // 후기 사용 경계(경쟁·우리·출처 불명)는 planning.md SOURCE_VOICE_ROLE_* 절.
      role: sectionOf(
        instructions,
        source.reviewOf === "competitor"
          ? "SOURCE_VOICE_ROLE_COMPETITOR"
          : source.reviewOf === "own"
            ? "SOURCE_VOICE_ROLE_OWN"
            : "SOURCE_VOICE_ROLE_UNKNOWN",
      ),
    }));
    const factIds = new Set(facts.map((source) => source.sourceId));
    const voiceIds = new Set(voices.map((source) => source.sourceId));
    const referenceIds = new Set(references.map((source) => source.id));
    const context = JSON.stringify({
      facts,
      voices,
      strategy,
      audience: job.audience,
      objective: job.objective,
      referenceAnalyses,
      // 같은 문구의 변형끼리 묶은 결과. variantCount 가 클수록 경쟁사가 밀고 있는 메시지다.
      // 변형 ID 목록은 넘기지 않는다: 분석하지 않은 변형을 근거로 적으면 검증이 거부한다.
      referenceGroups: pack.referenceGroups.map(({ representativeId, variantCount }) => ({
        representativeId,
        variantCount,
      })),
      mediaAnalysesByReference: references.map((source) => ({
        sourceId: source.id,
        mediaAnalyses: this.completedMediaAnalyses(source),
      })),
    });
    let feedback: readonly string[] = [];
    // 구조 오류(근거 ID·타겟·광고안 수·사슬·인식 단계) 재작성 최대 3회와 기획 검토 수정 1회를 따로 센다. 한쪽이 다른 쪽의 기회를 쓰지 않는다.
    // 실측(2026-10-06): 규칙이 많아져 시도마다 다른 오류에 걸렸고 2회로는 모자랐다(생성 1회 ≈ 1분, gpt-5-mini 기준 저렴).
    let structuralRetries = 0;
    // 기획 검토 수정은 2회(실측 2026-10-06: 더 꼼꼼한 모델은 사슬이 일반적이라며 첫 수정도 거부했다).
    let critiqueRevisions = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      // 지시 파일은 생성 호출마다 다시 읽는다(고친 파일은 다음 시도부터).
      instructions = loadInstructions();
      this.store.agent(job.id, "creative", {
        status: "running",
        action: `사는 이유·망설임·확인 기준 정리 후 서로 다른 구매 질문에 답하는 가설 ${imageCount}개 설계${attempt ? ` · 다시 쓰기 ${attempt}회` : ""}`,
      });
      const generated = await generateTextResult(
        {
          name: "source_creative_plan",
          schema: CreativePlanResponseSchema,
          directory,
          signal,
          models,
          maxOutputTokens: 22000,
          prompt: `${guardOf(instructions)}\n${fillSection(sectionOf(instructions, "SOURCE_CREATIVE_PLAN"), { imageCount })}\nDATA:\n${context}\nREVISION FEEDBACK:\n${JSON.stringify(feedback)}`,
        },
        this.connection,
      );
      const plan: CreativePlan = normalizePlanTargets({
        ...generated.value,
        customerQuestions: normalizeCustomerQuestions(generated.value.customerQuestions, {
          facts: factIds,
          voices: voiceIds,
          references: referenceIds,
        }),
        learningSignal: learningSignal(job, imageCount),
        sourceDigest: snapshot.digest,
        referenceAnalyses,
        sourceCoverage: pack.coverage,
      });
      // 검증 전 초안을 남긴다: 거부된 기획도 무엇을 썼는지 볼 수 있어야 규칙을 고칠 수 있다(2026-10-06).
      await new Artifacts(this.store).save(job.id, {
        name: `plan-draft-${attempt + 1}.json`,
        kind: "json",
        agentId: "creative",
        content: JSON.stringify(generated.value),
        model: generated.model,
      });
      try {
        validatePlanEvidence(plan, snapshot, imageCount);
      } catch (error) {
        if (
          !(error instanceof StudioError) ||
          !["customer_questions", "plan_targets", "diversity", "funnel"].includes(error.code) ||
          structuralRetries >= 3
        )
          throw error;
        // 걸린 구조 오류를 모두 모아 한 번에 돌려준다(첫 오류만 고치면 다음 시도가 다른 오류에 걸린다).
        const problems = planStructureProblems(plan, snapshot, imageCount);
        const codes = new Set([error.code, ...problems.map((item) => item.code)]);
        const messages = [...new Set([error.message, ...problems.map((item) => item.message)])];
        feedback = [
          `${messages.length}개 문제를 한 번에 고치세요:\n- ${messages.join("\n- ")}`,
          JSON.stringify({
            code: error.code,
            allowedSourceIds: {
              FACTS: facts.map((source) => source.sourceId),
              VOICES: voices.map((source) => source.sourceId),
              REFERENCES: references.map((source) => source.id),
            },
            fieldRules: {
              product_fact: "FACTS",
              customer_voice: "VOICES",
              inferred: [],
              answeredByReferences: "REFERENCES",
            },
          }),
          ...(codes.has("diversity")
            ? [
                `광고안(hypotheses)은 정확히 ${imageCount}개여야 합니다. 타겟이 더 많아도 광고안은 ${imageCount}개만 고르고, 나머지 타겟은 targets 에만 남기세요. 광고안끼리 angle·타깃·상황·문제·메시지·시각 구성·훅이 겹치면 안 됩니다.`,
              ]
            : []),
          ...(codes.has("plan_targets")
            ? [
                "조각·타겟·해결 과정·설득 사슬을 위 문제에 맞게 고치세요. 출처 ID는 위 목록의 ID만 쓰고, mechanism·verification 단계와 사슬의 productFact·reasonWhy 는 FACTS 를 인용하세요. 사슬의 outcome 은 타겟 조각의 desire/pain 낱말을 그대로 되받으세요. exclusivity 가 any_product 로 끝나는 타겟이면 reasonWhy 를 한 칸 더 내려가 우리 상품만의 FACTS(원재료 100%·섞지 않음·냉압착·제조사)에 닿게 하거나, 점수가 높은 다른 타겟으로 바꾸세요.",
              ]
            : []),
          ...(codes.has("funnel")
            ? [
                "인식 단계와 소재 유형을 고치세요: 타겟 조각에 failedAttempt·alternative·believedCause 가 있으면 decisionRole 은 comparison(MOFU) 또는 final_decision(BOFU)입니다(need_awareness 금지). format 은 단계에 맞춥니다 — comparison 은 mechanism_explainer(이때 cardSlides 2~4장 필수: 사슬의 진짜 원인·해결 조건·우리 상품의 사실·가능한 이유를 한 장씩) 또는 review_proof(우리 상품 후기 VOICES 가 있을 때만). final_decision 은 FACTS 에 오퍼 자료가 있을 때만 benefit_offer/risk_reversal 이고, 오퍼 자료가 없으면 final_decision 을 쓰지 마세요. 다른 format 은 cardSlides [].",
              ]
            : []),
          ...(codes.has("customer_questions")
            ? [
                "고객 질문의 sourceIds와 answeredByReferences를 위 목록의 ID만 사용해 수정하세요. 근거가 없으면 basis=inferred, sourceIds=[]로 두고 가설의 customerQuestionId도 고객 질문 ID와 연결하세요.",
              ]
            : []),
        ];
        structuralRetries++;
        continue;
      }
      this.store.agent(job.id, "creative", {
        status: "running",
        action: `${imageCount}개 가설의 차이와 제품 주장 근거를 교차 검토 중`,
      });
      const critique = await generateTextResult(
        {
          name: "creative_plan_critique",
          schema: PlanCritiqueSchema,
          directory,
          signal,
          models,
          maxOutputTokens: 14000,
          prompt: `${guardOf(instructions)}\n${fillSection(sectionOf(instructions, "SOURCE_PLAN_CRITIQUE"), { imageCount, singleConceptNote: imageCount === 1 ? `${sectionOf(instructions, "SOURCE_PLAN_CRITIQUE_SINGLE_CONCEPT")} ` : "" })}\nDATA:\n${JSON.stringify({ facts, plan })}`,
        },
        this.connection,
      );
      await new Artifacts(this.store).save(job.id, {
        name: `plan-critique-${attempt + 1}.json`,
        kind: "json",
        agentId: "creative",
        content: JSON.stringify(critique.value),
        model: critique.model,
      });
      if (critique.value.status === "pass" && critique.value.issues.length === 0) {
        await this.stampInstructions(job, instructions);
        return { value: plan, model: generated.model };
      }
      if (critiqueRevisions >= 2) {
        // 구조 검사는 통과했고 검토만 남은 기획은 멈추지 않고 받아들인다(2026-10-06, gpt-6-astra 검토가 카피 세부로 계속 revise).
        // 남은 지적은 '분석의 한계'에 적어 사용자가 기획 승인 때 본다.
        const unresolved = critique.value.issues.map((issue) => `검토 미해결: ${issue}`);
        this.store.agent(job.id, "creative", {
          status: "review",
          action: `기획 검토 미해결 ${unresolved.length}건 — 승인 전에 '근거와 분석의 한계'를 확인하세요`,
        });
        await this.stampInstructions(job, instructions);
        return {
          value: {
            ...plan,
            limitations: [...plan.limitations, ...unresolved].slice(0, 15),
          },
          model: generated.model,
        };
      }
      critiqueRevisions++;
      feedback = [
        ...critique.value.issues,
        // 사슬이 어느 제품에나 맞는다는 지적은 사양을 덧붙여서 고쳐지지 않는다. 타겟을 바꾸는 쪽이 답이다.
        sectionOf(instructions, "SOURCE_PLAN_RETRY_HINT"),
      ];
    }
    throw new StudioError(
      "plan_rejected",
      "기획을 만들지 못했습니다. 자료를 보완해 새 작업을 만드세요.",
    );
  }

  // 기획 산출물 옆에 그때 읽은 지시 파일 해시를 남긴다(D5). creativePlan 안에 넣으면 approvedPlanDigest 가 달라지므로 별도 산출물
  // instructions-plan.json 과 이벤트("지시 파일 xxxxxxxx 적용")에만 적는다. 같은 작업이 다시 기획하면 같은 이름을 덮어쓴다.
  private async stampInstructions(job: Job, instructions: InstructionsSnapshot): Promise<void> {
    await saveArtifactOnce(new Artifacts(this.store), job.id, {
      name: "instructions-plan.json",
      kind: "json",
      agentId: "creative",
      content: JSON.stringify({
        ...instructionsStamp(instructions),
        warnings: instructions.warnings,
      }),
    });
    this.store.change(job.id, (draft) => {
      this.store.event(
        draft,
        "creative",
        "info",
        `기획 · ${instructionsEventMessage(instructions)}`,
      );
    });
  }
  private completedMediaAnalyses(source: ProjectSource): PlanningMediaAnalysis[] {
    const availableTables = new Set(
      this.store.db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
        .all("project_media", "project_media_analysis")
        .map((row) => sqliteTableRowSchema.parse(row).name),
    );
    if (!availableTables.has("project_media") || !availableTables.has("project_media_analysis"))
      return [];
    return this.store.db
      .query(
        `SELECT pm.body AS asset_body, pma.body AS analysis_body
         FROM project_media pm
         JOIN project_media_analysis pma ON pma.asset_id = pm.id
         WHERE pm.project_id = ? AND pm.source_id = ?`,
      )
      .all(source.projectId, source.id)
      .map((row) => {
        const parsed = mediaAnalysisRowSchema.parse(row);
        const asset = z
          .object({
            id: z.string(),
            kind: z.enum(["image", "video"]),
            sourceUrl: z.string(),
          })
          .parse(JSON.parse(parsed.asset_body));
        const status = MediaAnalysisStatusSchema.parse(JSON.parse(parsed.analysis_body));
        if (status.status !== "complete" || !status.report) return null;
        return {
          assetId: asset.id,
          kind: asset.kind,
          sourceUrl: asset.sourceUrl,
          sampling: status.report.sampling,
          cuts: status.report.cuts,
          transcript: status.report.transcript,
          limitations: status.report.limitations,
        };
      })
      .filter((item): item is PlanningMediaAnalysis => item !== null);
  }
}

// 고객 질문의 출처 ID 가 근거 종류와 맞지 않으면(실측 2026-10-06: customer_voice 에 레퍼런스 ID) 거부 대신 고친다:
// 맞지 않는 ID 를 빼고, 남는 근거가 없으면 basis inferred(검증되지 않은 추정)로 둔다. 재작성 기회를 아낀다.
export function normalizeCustomerQuestions<T extends CreativePlan["customerQuestions"][number]>(
  questions: readonly T[],
  ids: { facts: ReadonlySet<string>; voices: ReadonlySet<string>; references: ReadonlySet<string> },
): T[] {
  return questions.map((question) => {
    const allowed =
      question.basis === "customer_voice"
        ? ids.voices
        : question.basis === "product_fact"
          ? ids.facts
          : new Set<string>();
    const sourceIds = question.sourceIds.filter((id) => allowed.has(id));
    const answeredByReferences = question.answeredByReferences.filter((id) =>
      ids.references.has(id),
    );
    return {
      ...question,
      sourceIds,
      answeredByReferences,
      basis: question.basis !== "inferred" && sourceIds.length === 0 ? "inferred" : question.basis,
    };
  });
}
