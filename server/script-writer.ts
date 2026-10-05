import type { CreativePlan } from "../shared/creative-plan";
import type { ArtifactModel } from "../shared/models";
import type { StoredVideoScriptReview } from "../shared/render-state";
import { scriptNeedsFixBanner, scriptReviewName } from "../shared/script-approval";
import { type VideoScript, VideoScriptSchema } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import type { ProductionProviders } from "./automation-production";
import { BlockedError, StudioError } from "./errors";
import { isTestRuntime, TEST_PROVIDER_BLOCKED } from "./render-pipeline";
import { hasArtifact } from "./render-state-helpers";
import type { JobStore } from "./store";
import { prepareVideoPlanning } from "./video-planning";
import {
  classifyScriptProblems,
  generateVideoScript,
  reviewVideoScript,
  scriptFactTexts,
  scriptFeedback,
} from "./video-scripts";

// 영상 대본 1편 쓰기: 생성 → 자동 수리(변환 안) → 규칙 분류(hard/soft) → AI 품질 검토 → 걸리면 이유를 모아 다시 쓴다.
// 생성은 영상당 최대 3회(첫 생성 포함). hard 규칙(영문·구조·미선언 ID·숫자 불일치…)은 거부·재생성, soft(리듬·목표 길이 차이…)는
// 경고로 받아들인다. 마지막 생성이 AI 검토에서도 revise 면 받아들이되 '사용자 확인 필요'(forced)로 기록한다.
// 3회 뒤에도 hard 가 남으면(2026-10-04 실전: 3회 모두 거부 → attention) 작업을 멈추지 않고 hard 가 가장 적은 시도를
// needsFix 초안으로 저장해 승인 대기에 넣는다(사용자가 고치거나 다시 쓴다). 첫 작성(SourceProduction)과 '다시 쓰기'가 같은 함수를 쓴다.
export const SCRIPT_MAX_GENERATIONS = 3;
export type WriteScriptInput = {
  readonly store: JobStore;
  readonly providers: Pick<
    ProductionProviders,
    "videoPlanning" | "videoScript" | "reviewVideoScript"
  >;
  readonly id: string;
  readonly number: number;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  readonly durationSec: number;
  readonly signal: AbortSignal;
  // 사용자가 적은 수정 요청(다시 쓰기). 매 생성에 그대로 붙는다.
  readonly userFeedback?: string;
  readonly progress?: (attempt: number, reason: "planning" | "copy" | "write" | "review") => void;
};
export type WriteScriptResult = {
  readonly script: VideoScript;
  readonly model: ArtifactModel;
  readonly review: StoredVideoScriptReview;
};
function reviewIssuesFeedback(review: {
  readonly summary: string;
  readonly issues: readonly {
    sentenceIndex: number | null;
    cutIndexes: readonly number[];
    problem: string;
    fix: string;
  }[];
}): string {
  const items = review.issues.map(
    (issue) =>
      `${issue.sentenceIndex === null ? "전체" : `${issue.sentenceIndex + 1}번째 문장`}${
        issue.cutIndexes.length > 0 ? `(컷[${issue.cutIndexes.join(",")}])` : ""
      }: ${issue.problem} → ${issue.fix}`,
  );
  return `AI 대본 검토 수정 요청(${review.summary}): ${items.join(" / ")}`;
}
type Draft = {
  readonly script: VideoScript;
  readonly model: ArtifactModel;
  readonly hard: string[];
  readonly soft: string[];
  readonly repairs: string[];
};
export async function writeVideoScript(input: WriteScriptInput): Promise<WriteScriptResult> {
  const { store, id, number, hypothesis, signal } = input;
  const assets = new Artifacts(store);
  const write = input.providers.videoScript ?? generateVideoScript;
  const reviewer = input.providers.reviewVideoScript;
  if (!reviewer && isTestRuntime())
    throw new StudioError(
      TEST_PROVIDER_BLOCKED,
      "테스트 환경에서는 주입하지 않은 대본 검토가 실제 유료 공급자를 부를 수 없습니다. 스텁 검토를 주입하세요.",
    );
  const review = reviewer ?? reviewVideoScript;
  if (!input.providers.videoScript && isTestRuntime())
    throw new StudioError(
      TEST_PROVIDER_BLOCKED,
      "테스트 환경에서는 대본 작성 공급자를 주입해야 합니다.",
    );
  const planner =
    input.providers.videoPlanning ?? (input.providers.videoScript ? null : prepareVideoPlanning);
  if (planner === prepareVideoPlanning && isTestRuntime())
    throw new StudioError(
      TEST_PROVIDER_BLOCKED,
      "테스트 환경에서는 영상 기획 공급자를 주입해야 합니다.",
    );
  const planning = planner
    ? (
        await planner({
          job: store.get(id),
          hypothesis,
          number,
          durationSec: input.durationSec,
          signal,
          ...(input.userFeedback ? { userFeedback: input.userFeedback } : {}),
          onProgress: (stage) => input.progress?.(1, stage),
        })
      ).value
    : undefined;
  let violations: string | null = null;
  // hard 규칙에 걸린 시도 중 hard 가 가장 적은 것(동수면 최신). 3회 뒤에도 남으면 needsFix 초안으로 저장한다.
  let draft: Draft | null = null;
  // 규칙은 통과했지만 AI 검토가 revise 한 시도: 마지막 생성이 규칙에 걸리면 이쪽을 강제 수용(forced)한다.
  let reviewed: WriteScriptResult | null = null;
  for (let attempt = 1; attempt <= SCRIPT_MAX_GENERATIONS; attempt++) {
    input.progress?.(attempt, "write");
    const feedback = [
      input.userFeedback ? `USER FEEDBACK (must be applied): ${input.userFeedback}` : null,
      violations,
    ]
      .filter((item): item is string => Boolean(item))
      .join("\n");
    const written = await write(
      store.get(id),
      hypothesis,
      number,
      signal,
      feedback.length > 0 ? feedback : undefined,
      undefined,
      planning,
    );
    const script = { ...written.value, ...(planning ? { planning } : {}) };
    const repairs = [...(written.repairs ?? [])];
    // 저장 스키마(컷 60개·8~60초…)를 못 지키는 초안은 저장할 수 없으므로 best 후보에서도 뺀다(JobSchema 로드 보호).
    const stored = VideoScriptSchema.safeParse(script);
    if (!stored.success) {
      violations = `저장 형식 위반: ${stored.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join(" / ")}`;
      continue;
    }
    const rules = classifyScriptProblems(stored.data, {
      number,
      durationSec: input.durationSec,
      hypothesis,
      hasProjectClips: (store.get(id).productionSourceSnapshot?.assets.length ?? 0) > 0,
      facts: scriptFactTexts(store.get(id), hypothesis),
    });
    const soft = [...(written.warnings ?? []), ...rules.soft];
    if (rules.hard.length > 0) {
      if (!draft || rules.hard.length <= draft.hard.length)
        draft = { script: stored.data, model: written.model, hard: rules.hard, soft, repairs };
      violations = scriptFeedback(rules.hard, soft);
      continue;
    }
    input.progress?.(attempt, "review");
    const result = await review({ job: store.get(id), script: stored.data, hypothesis, signal });
    // 검토 산출물 번호는 작업 안에서 이어진다(다시 쓰기도 다음 번호를 쓴다).
    let reviewAttempt = 1;
    while (hasArtifact(store.get(id), scriptReviewName(number, reviewAttempt))) reviewAttempt++;
    await assets.save(id, {
      name: scriptReviewName(number, reviewAttempt),
      kind: "json",
      agentId: "creative",
      content: JSON.stringify(result.value),
      model: result.model,
    });
    const passed = result.value.status === "pass";
    const outcome: WriteScriptResult = {
      script: stored.data,
      model: written.model,
      review: {
        attempt: reviewAttempt,
        status: result.value.status,
        summary: result.value.summary,
        issues: result.value.issues,
        accepted: passed ? "pass" : "forced",
        repairs,
        warnings: soft,
        hardProblems: [],
        generations: attempt,
      },
    };
    if (passed || attempt === SCRIPT_MAX_GENERATIONS) return outcome;
    reviewed = outcome;
    violations = `${reviewIssuesFeedback(result.value)}${soft.length > 0 ? ` / 경고: ${soft.join(" / ")}` : ""}`;
  }
  // 마지막 생성이 규칙에 걸렸지만 앞 시도가 규칙을 통과했다면 그 대본을 강제 수용한다(AI 검토 revise 는 사용자 확인 필요).
  if (reviewed)
    return {
      ...reviewed,
      review: { ...reviewed.review, generations: SCRIPT_MAX_GENERATIONS },
    };
  if (!draft)
    throw new BlockedError(
      "영상 대본을 저장 가능한 형태로 작성하지 못했습니다(컷 60개·60초 초과 등). 모델 설정을 확인한 뒤 다시 시작하세요.",
    );
  // 3회 모두 hard 규칙에 걸림: 작업을 멈추지 않고 가장 나은 초안을 needsFix 로 저장해 사용자가 고치거나 다시 쓰게 한다.
  let reviews = 0;
  while (hasArtifact(store.get(id), scriptReviewName(number, reviews + 1))) reviews++;
  return {
    script: draft.script,
    model: draft.model,
    review: {
      attempt: reviews,
      status: "revise",
      summary: `${scriptNeedsFixBanner}(생성 ${SCRIPT_MAX_GENERATIONS}회)`,
      issues: [],
      accepted: "needsFix",
      repairs: draft.repairs,
      warnings: draft.soft,
      hardProblems: draft.hard,
      generations: SCRIPT_MAX_GENERATIONS,
    },
  };
}
