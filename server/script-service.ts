import { z } from "zod";
import type { CreativePlan } from "../shared/creative-plan";
import { clipModeOf } from "../shared/flow-mode";
import { chainExpectation } from "../shared/persuasion-chain";
import type { RenderState, StoredVideoScriptReview } from "../shared/render-state";
import type { Job } from "../shared/schema";
import {
  narrationSynthesized,
  pendingScriptApprovals,
  type ScriptApprovalMode,
  scriptApprovalMode,
  scriptApproved,
  scriptArtifactName,
  scriptDigestOf,
  scriptNeedsFix,
  scriptNeedsFixMessage,
  videoScriptOf,
} from "../shared/script-approval";
import { applyScriptEdit } from "../shared/script-edit";
import {
  classifyScriptProblems,
  type ScriptProblems,
  scriptFeedback,
} from "../shared/script-rules";
import { copyProblems } from "../shared/script-rules-v2";
import {
  type CopyLine,
  CopyLineSchema,
  calloutWordInText,
  type VideoScript,
  VideoScriptSchema,
  videoTargetSeconds,
  videoVariantIndex,
} from "../shared/video-script";
import { Artifacts } from "./artifacts";
import type { ProductionProviders } from "./automation-production";
import { assessCopy, copyFactTexts } from "./copy-writer";
import { BlockedError, publicError, StudioError } from "./errors";
import { instructionsEventMessage, syncThresholds } from "./instructions";
import { renderStateOf, saveArtifactOnce } from "./render-state-helpers";
import { writeVideoScript } from "./script-writer";
import { videoHypotheses } from "./source-production";
import type { JobStore } from "./store";
import { scriptFactTexts } from "./video-scripts";

// 영상 대본 확인·수정·승인·다시 쓰기(사용자 결정 2026-10-04). 유료 제작(내레이션 합성) 전에 사람이 대본을 본다.
// 라우트(server/job-routes.ts)와 CLI(scripts/script-cli.ts)가 같은 규칙을 쓰도록 여기 모아 둔다.
export const ScriptEditSchema = z
  .object({
    // 음성 트랙 문장 교체(문장 번호는 0부터). 시간은 fitVoiceover 가 다시 맞춘다.
    voiceover: z
      .array(z.object({ index: z.number().int().min(0).max(39), text: z.string().trim() }).strict())
      .max(40)
      .default([]),
    // 컷 자막 교체(컷 번호는 0부터). 빈 문자열이면 자막 없음. 줄바꿈·자름(R7)만 자동으로 손본다.
    captions: z
      .array(
        z
          .object({ cutIndex: z.number().int().min(0).max(59), onScreenText: z.string().trim() })
          .strict(),
      )
      .max(60)
      .default([]),
  })
  .strict();
export type ScriptEdit = z.infer<typeof ScriptEditSchema>;
// 다시 쓰기 본문: 수정 요청(feedback) 또는 외부 카피(copy) 중 하나는 있어야 한다. copy 가 있으면 편지 1(카피 쓰기)을 건너뛰고
// 그 문장으로 편지 2(장면)를 돌린다(카피 먼저 흐름, 혼합형 기획에서만). 문장 수는 카피 응답 스키마와 같은 4~14개.
export const ScriptRewriteSchema = z
  .object({
    feedback: z.string().trim().max(2000).default(""),
    copy: z.array(CopyLineSchema).min(4).max(14).optional(),
  })
  .strict()
  .refine((body) => body.feedback.length > 0 || body.copy !== undefined, {
    message: "수정 요청(feedback) 또는 카피(copy)가 필요합니다.",
    path: ["feedback"],
  });
export type ScriptView = {
  readonly number: number;
  // 저장 대본 전체. 장면 계획 필드(subjects·컷 goal/phase·문장 callouts·클립 plan·설명 컷 graphicOrder)와
  // 혼합형 필드(explainerAnchor·설명 컷 sceneType/objects/actions/emphasis·planning.visualPolicy)도 그대로 나간다.
  readonly script: VideoScript;
  readonly scriptDigest: string;
  readonly approvalMode: ScriptApprovalMode;
  readonly approved: boolean;
  readonly approval: RenderState["scriptApproval"];
  readonly review: StoredVideoScriptReview | null;
  // 지금 저장된 대본의 규칙 판정(사실 자료 본문까지 포함해 서버가 계산). hard 가 남아 있으면 승인할 수 없다.
  readonly rules: ScriptProblems;
  // 내레이션이 이미 합성됐으면 대본을 더 바꿀 수 없다(초기화 필요).
  readonly synthesized: boolean;
  readonly pending: number[];
};
const invalid = (code: string, message: string, status: 400 | 404 | 409 = 409) =>
  new StudioError(code, message, status);

export class VideoScriptService {
  readonly assets: Artifacts;
  constructor(
    readonly store: JobStore,
    readonly providers: Pick<
      ProductionProviders,
      "videoPlanning" | "videoScript" | "reviewVideoScript" | "videoCopy"
    >,
  ) {
    this.assets = new Artifacts(store);
  }
  view(id: string, number: number): ScriptView {
    const job = this.store.get(id);
    const script = this.scriptOf(job, number);
    const render = job.renders.find((item) => item.number === number);
    return {
      number,
      script,
      scriptDigest: scriptDigestOf(script),
      approvalMode: scriptApprovalMode(job),
      approved: scriptApproved(job, number),
      approval: render?.scriptApproval ?? null,
      review: render?.scriptReview ?? null,
      rules: this.rulesOf(job, number, script),
      synthesized: narrationSynthesized(job, number),
      pending: pendingScriptApprovals(job),
    };
  }
  // 문장·자막 부분 수정 → 자막 줄바꿈(R7) → 시간 재계산 → 저장 스키마 재해석 → 규칙 분류. hard 가 있으면 400, soft 는 통과.
  // 통과하면 저장하고 승인을 푼다. needsFix 초안도 같은 길로 고친다(hard 가 모두 풀리면 hardProblems 를 비운다).
  async edit(id: string, number: number, edit: ScriptEdit): Promise<Job> {
    const job = this.store.get(id);
    const current = this.scriptOf(job, number);
    this.assertEditable(job, number);
    for (const change of edit.voiceover)
      if (change.index >= current.voiceover.length)
        throw invalid("script_edit", `${change.index + 1}번째 문장은 없습니다.`, 400);
    for (const change of edit.captions)
      if (change.cutIndex >= current.cuts.length)
        throw invalid("script_edit", `${change.cutIndex + 1}번째 컷은 없습니다.`, 400);
    // 장면 계획(2026-10-06 R7): 글만 바꾸고 콜아웃·goal·phase·plan·subjects 는 그대로 둔다(applyScriptEdit 이 나머지 필드를 보존).
    // 혼합형(2026-10-07)의 explainerAnchor·설명 장면 필드도 같은 이유로 보존되고, 저장 뒤 규칙 분류(hybridProblems)를 다시 지난다.
    // 콜아웃은 그 문장의 어절에 붙으므로, 새 문장에서 그 어절이 사라지면 저장 전에 어느 콜아웃인지 알려 준다(콜아웃 자체는 이 API 로 못 바꾼다).
    const lostCallouts = edit.voiceover.flatMap((change) =>
      (current.voiceover[change.index]?.callouts ?? [])
        .filter((callout) => !calloutWordInText(callout.word, change.text))
        .map(
          (callout) =>
            `${change.index + 1}번째 문장 콜아웃 '${callout.text}'의 단어가 문장에 없습니다(어절 "${callout.word}")`,
        ),
    );
    if (lostCallouts.length > 0)
      throw invalid(
        "script_rules",
        `${lostCallouts.join(" / ")}. 콜아웃이 붙은 어절은 문장에 그대로 두세요. 콜아웃을 바꾸려면 다시 쓰기를 하세요.`,
        400,
      );
    const candidate = applyScriptEdit(current, edit);
    const parsed = VideoScriptSchema.safeParse(candidate);
    if (!parsed.success)
      throw invalid(
        "script_invalid",
        `대본 형식에 맞지 않습니다: ${parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join(" / ")}`,
        400,
      );
    const rules = this.rulesOf(job, number, parsed.data);
    if (rules.hard.length > 0)
      throw invalid("script_rules", scriptFeedback(rules.hard, rules.soft), 400);
    return this.replace(
      id,
      number,
      parsed.data,
      (review) => (review ? { ...review, hardProblems: [], warnings: rules.soft } : review),
      `사용자가 대본을 수정했습니다(승인 해제${rules.soft.length > 0 ? ` · 경고 ${rules.soft.length}건` : ""}).`,
    );
  }
  // 승인. 규칙을 통과하지 못한 초안(needsFix)은 hard 위반이 남아 있으면 409 로 거부한다(pass/forced 대본은 재검사 없이 승인).
  approve(id: string, number: number): Job {
    const job = this.store.get(id);
    const script = this.scriptOf(job, number);
    if (scriptNeedsFix(job, number)) {
      const rules = this.rulesOf(job, number, script);
      if (rules.hard.length > 0)
        throw invalid(
          "script_needs_fix",
          `${scriptNeedsFixMessage}: ${rules.hard.slice(0, 5).join(" / ")}${rules.hard.length > 5 ? ` / (외 ${rules.hard.length - 5}건)` : ""}`,
          409,
        );
    }
    const digest = scriptDigestOf(script);
    return this.store.change(id, (draft) => {
      const render = renderStateOf(draft, number);
      render.scriptApproval = { approvedAt: new Date().toISOString(), scriptDigest: digest };
      this.store.event(draft, "creative", "info", `영상 ${number} 대본을 사용자가 승인했습니다.`);
    });
  }
  // 사용자 피드백을 붙여 다시 생성(유료 텍스트 호출, 사용자가 시작). 규칙 분류·AI 검토를 거쳐 저장하고 승인을 푼다.
  // copy 가 있으면 외부 카피: 카피 규칙(shared/script-rules-v2.ts copyProblems)을 먼저 적용해 hard 면 400 copy_rules 로 돌려보낸다(유료 호출 전).
  async rewrite(
    id: string,
    number: number,
    feedback: string,
    signal: AbortSignal,
    copy?: readonly CopyLine[],
  ): Promise<Job> {
    const job = this.store.get(id);
    this.scriptOf(job, number);
    this.assertEditable(job, number);
    const hypothesis = this.hypothesisOf(job, number);
    const targetSec = videoTargetSeconds(
      id,
      number,
      videoVariantIndex(job.videoScripts, number, hypothesis.id),
    );
    if (copy) {
      syncThresholds();
      const assessment = assessCopy(copy, {
        durationTargetSec: targetSec,
        facts: copyFactTexts(job, hypothesis),
      });
      if (assessment.hard.length > 0)
        throw invalid(
          "copy_rules",
          `카피가 규칙을 지키지 않습니다(추정 발화 약 ${assessment.estimatedSec}초): ${assessment.hard.join(" / ")}`,
          400,
        );
    }
    const result = await writeVideoScript({
      store: this.store,
      providers: this.providers,
      id,
      number,
      hypothesis,
      durationSec: targetSec,
      signal,
      ...(feedback.length > 0 ? { userFeedback: feedback } : {}),
      ...(copy ? { externalCopy: copy } : {}),
      progress: (attempt, reason) => {
        this.store.agent(id, "creative", {
          status: "running",
          action: {
            planning: `영상 ${number} · 피드백을 반영한 고객 상황·영상 콘셉트 기획 중`,
            copy: `영상 ${number} · 내레이션·화면 카피 교정 중`,
            write: `영상 ${number} 대본 다시 쓰기(사용자 피드백 반영)${attempt > 1 ? ` · 수정 ${attempt - 1}회` : ""}`,
            review: `영상 ${number} 다시 쓴 대본 AI 품질 검토 중`,
          }[reason],
        });
      },
    }).catch((error: unknown) => {
      this.store.agent(id, "creative", {
        status:
          error instanceof BlockedError
            ? "blocked"
            : error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "failed",
        action: `영상 ${number} 대본 다시 쓰기 중단 · ${publicError(error)}`,
      });
      throw error;
    });
    await this.assets.save(id, {
      name: scriptArtifactName(number),
      kind: "json",
      agentId: "creative",
      content: JSON.stringify(result.script),
      model: result.model,
    });
    const outcome =
      result.review.accepted === "pass"
        ? "다시 썼습니다(승인 필요)"
        : result.review.accepted === "forced"
          ? "다시 썼습니다 · AI 검토 미통과, 확인 필요"
          : "다시 썼습니다 · 규칙 미통과 초안, 고치거나 다시 쓰기";
    const replaced = this.replace(
      id,
      number,
      result.script,
      () => result.review,
      `영상 ${number} 대본을 사용자 피드백으로 ${outcome}.`,
      // 다시 쓸 때 읽은 지시 파일(D5)
      result.review.instructionsDigest
        ? [
            `영상 ${number} 대본 · ${instructionsEventMessage({ digest: result.review.instructionsDigest })}`,
          ]
        : [],
    );
    this.store.agent(id, "creative", {
      status: "review",
      action: `영상 ${number} 대본 ${outcome}`,
    });
    return replaced;
  }
  private replace(
    id: string,
    number: number,
    script: VideoScript,
    review: (current: StoredVideoScriptReview | null) => StoredVideoScriptReview | null,
    message: string,
    extraEvents: readonly string[] = [],
  ): Job {
    return this.store.change(id, (draft) => {
      const index = draft.videoScripts.findIndex((item) => item.number === number);
      if (index >= 0) draft.videoScripts[index] = script;
      else draft.videoScripts[number - 1] = script;
      const render = renderStateOf(draft, number);
      render.scriptApproval = null;
      const next = review(render.scriptReview);
      if (next) render.scriptReview = next;
      this.store.event(draft, "creative", "info", message);
      for (const extra of extraEvents) this.store.event(draft, "creative", "info", extra);
    });
  }
  // 편집 저장: 산출물 video-script-<n>.json 은 같은 이름으로 덮어쓴다(목록 중복 없음).
  async saveEdited(id: string, number: number): Promise<void> {
    const script = this.scriptOf(this.store.get(id), number);
    await saveArtifactOnce(this.assets, id, {
      name: scriptArtifactName(number),
      kind: "json",
      agentId: "creative",
      content: JSON.stringify(script),
    });
  }
  private scriptOf(job: Job, number: number): VideoScript {
    const policy = job.automation?.policy;
    if (policy?.mode !== "creative")
      throw invalid("script_mode", "소재 자동 제작 작업이 아닙니다.", 409);
    const script = videoScriptOf(job, number);
    if (!Number.isInteger(number) || number < 1 || number > (policy.videoCount ?? 0) || !script)
      throw invalid("script_missing", `영상 ${number} 의 대본이 아직 없습니다.`, 404);
    return script;
  }
  private assertEditable(job: Job, number: number): void {
    if (narrationSynthesized(job, number))
      throw invalid(
        "script_synthesized",
        `영상 ${number} 은 내레이션이 이미 합성되어 대본을 바꿀 수 없습니다. 바꾸려면 작업을 초기화한 뒤 다시 시작하세요.`,
        409,
      );
    if (job.status === "running" || job.automation?.status === "running")
      throw invalid(
        "script_busy",
        "작업이 실행 중이라 대본을 바꿀 수 없습니다. 잠시 뒤 다시 시도하세요.",
        409,
      );
    if (job.artifacts.some((asset) => asset.name === `video-final-${number}.mp4`))
      throw invalid(
        "script_final",
        `영상 ${number} 은 이미 완성되어 대본을 바꿀 수 없습니다.`,
        409,
      );
  }
  private hypothesisOf(job: Job, number: number): CreativePlan["hypotheses"][number] {
    if (!job.creativePlan) throw new BlockedError("자료 기반 기획이 없습니다.");
    const order = videoHypotheses(job.creativePlan);
    const script = videoScriptOf(job, number);
    const hypothesis =
      order.find((item) => item.id === script?.hypothesisId) ?? order[(number - 1) % order.length];
    if (!hypothesis) throw new BlockedError("영상 대본에 연결할 광고안이 없습니다.");
    return hypothesis;
  }
  // 저장된(또는 편집 후보) 대본의 hard/soft 판정. 길이는 저장 길이를 그대로 목표로 둔다(편집으로 길이를 바꿀 수 없다).
  private rulesOf(job: Job, number: number, script: VideoScript): ScriptProblems {
    const hypothesis = this.hypothesisOf(job, number);
    // 규칙 임계값(글자 수·컷 길이 등)은 instructions/thresholds.json 의 지금 값으로 검사한다(재시작 없이 반영).
    syncThresholds();
    const scene = classifyScriptProblems(script, {
      number,
      durationSec: script.durationSec,
      hypothesis,
      hasProjectClips: (job.productionSourceSnapshot?.assets.length ?? 0) > 0,
      infoClipsAllowed: clipModeOf(job) === "flow",
      facts: scriptFactTexts(job, hypothesis),
      ...chainExpectation(job.creativePlan, hypothesis),
    });
    if (script.flow !== "copy_first") return scene;
    // 카피 먼저 흐름(2026-10-08): 장면 규칙(sceneProblemsV2)은 문장을 다시 보지 않으므로, 사용자가 고친 문장도 카피 규칙 8개로 함께 본다.
    // (쓰는 도중 3회 뒤에도 못 지킨 카피의 hard 도 같은 판정으로 다시 나오고, 문장을 고치면 사라진다.)
    const copy = copyProblems(
      script.voiceover.flatMap((voice) =>
        voice.chainStep === "" ? [] : [{ chainStep: voice.chainStep, text: voice.text }],
      ),
      { durationTargetSec: script.durationSec, facts: copyFactTexts(job, hypothesis) },
    );
    return { hard: [...copy.hard, ...scene.hard], soft: [...copy.soft, ...scene.soft] };
  }
}
