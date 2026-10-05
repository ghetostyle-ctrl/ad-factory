import { z } from "zod";
import type { CreativePlan } from "../shared/creative-plan";
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
import { type VideoScript, VideoScriptSchema, videoTargetSeconds } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import type { ProductionProviders } from "./automation-production";
import { BlockedError, StudioError } from "./errors";
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
export const ScriptRewriteSchema = z
  .object({ feedback: z.string().trim().min(1).max(2000) })
  .strict();
export type ScriptView = {
  readonly number: number;
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
      "videoPlanning" | "videoScript" | "reviewVideoScript"
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
  async rewrite(id: string, number: number, feedback: string, signal: AbortSignal): Promise<Job> {
    const job = this.store.get(id);
    this.scriptOf(job, number);
    this.assertEditable(job, number);
    const result = await writeVideoScript({
      store: this.store,
      providers: this.providers,
      id,
      number,
      hypothesis: this.hypothesisOf(job, number),
      durationSec: videoTargetSeconds(id, number),
      signal,
      userFeedback: feedback,
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
    return classifyScriptProblems(script, {
      number,
      durationSec: script.durationSec,
      hypothesis,
      hasProjectClips: (job.productionSourceSnapshot?.assets.length ?? 0) > 0,
      facts: scriptFactTexts(job, hypothesis),
    });
  }
}
