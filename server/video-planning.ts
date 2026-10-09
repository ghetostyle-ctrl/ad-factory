import { join } from "node:path";
import { guardCopyEdit } from "../shared/copy-polish";
import type { CreativePlan } from "../shared/creative-plan";
import { clipModeOf } from "../shared/flow-mode";
import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import {
  type VideoCopyEditingResponse,
  VideoCopyEditingResponseSchema,
  type VideoPlanning,
  type VideoPlanningDraft,
  type VisualPolicyId,
  videoPlanningResponseSchemaFor,
} from "../shared/video-planning";
import { dataDir } from "./config";
import { copyRhythmInstruction, koreanCopyPolishRules } from "./copy-instructions";
import { BlockedError } from "./errors";
import { hybridPlanningRules } from "./hybrid-script-instructions";
import { explanationPlanningRules } from "./immersive-script-instructions";
import {
  fillSection,
  type InstructionsSnapshot,
  loadInstructions,
  sectionOf,
} from "./instructions";
import type { OpenAIConnection } from "./provider-transport";
import { generateTextResult } from "./text-provider";
import { videoPlanningContext } from "./video-planning-context";

// 새 기획의 시각 정책(사용자 결정 2026-10-07): 혼합형 — 고통·상황·결과·행동 비트는 실사, 메커니즘·기능·비교 비트만 3D 설명 세계.
// immersive_explanations_v1(2026-10-06 입체 설명)은 저장된 기획과 테스트가 그대로 쓰며, task.visualPolicy 로 고를 수 있다.
export const DEFAULT_VISUAL_POLICY: VisualPolicyId = "hybrid_explainer_v1";

export type VideoPlanningTask = {
  readonly job: Job;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  readonly number: number;
  readonly durationSec: number;
  readonly signal: AbortSignal;
  readonly userFeedback?: string;
  readonly onProgress?: (stage: "planning" | "copy") => void;
  // 시각 정책(기본 DEFAULT_VISUAL_POLICY). immersive 로 두면 2026-10-06 입체 설명 프롬프트·응답 스키마를 그대로 쓴다.
  readonly visualPolicy?: VisualPolicyId;
};
export type VideoPlanningProvider = (
  task: VideoPlanningTask,
) => Promise<ModelResult<VideoPlanning>>;

export function editedVideoPlanning(
  draft: VideoPlanningDraft,
  edited: VideoCopyEditingResponse,
): VideoPlanning {
  // 교정 결과가 문장을 합치거나 나눠 줄 수가 달라지면 어느 문장이 무엇으로 바뀌었는지 기록할 수
  // 없다. 작업을 멈추지 않고 교정 전 초안을 그대로 쓰며, 그 사실을 검토 기록에 남긴다.
  if (draft.copy.lines.length !== edited.lines.length)
    return {
      ...draft,
      copyReview: {
        status: "pass",
        summary: `카피 교정 결과의 문장 수(${edited.lines.length})가 초안(${draft.copy.lines.length})과 달라 교정을 적용하지 않고 초안을 그대로 씁니다.`,
        edits: [],
      },
    };
  const changes = draft.copy.lines.flatMap((line, lineIndex) => {
    const after = edited.lines[lineIndex];
    if (!after) return [];
    return (["text", "screenText"] as const).flatMap((key) =>
      line[key] === after[key]
        ? []
        : [
            {
              lineIndex,
              field: key === "text" ? ("narration" as const) : ("screenText" as const),
              before: line[key],
              after: after[key],
            },
          ],
    );
  });
  // 수정 기록은 실제로 바뀐 칸에서 다시 만든다. 모델이 남긴 이유는 같은 칸(문장 번호·필드)에만
  // 붙이고, 이유가 없는 수정은 그렇다고 적는다. 모델 기록이 한 칸 어긋났다고 작업 전체를 멈추지
  // 않으면서도, 화면의 "수정 전/후"는 항상 실제 변경과 같다(2026-10-05 실전 테스트에서 이 검사로 멈춤).
  const { review } = edited;
  const edits = changes.map((change) => {
    const recorded = review.edits.find(
      (edit) => edit.lineIndex === change.lineIndex && edit.field === change.field,
    );
    return {
      ...change,
      reason: recorded?.reason ?? "교정 모델이 이유를 기록하지 않은 수정입니다.",
    };
  });
  const exact =
    review.edits.length === changes.length &&
    changes.every(
      (change) =>
        review.edits.filter(
          (edit) =>
            edit.lineIndex === change.lineIndex &&
            edit.field === change.field &&
            edit.before === change.before &&
            edit.after === change.after,
        ).length === 1,
    );
  const summary = exact
    ? review.summary
    : `${review.summary} (교정 모델의 수정 기록이 실제 변경과 달라 실제 바뀐 ${changes.length}건으로 다시 정리했습니다.)`.slice(
        0,
        1000,
      );
  return {
    ...draft,
    copy: { ...draft.copy, lines: edited.lines },
    copyReview: { status: changes.length > 0 ? "revised" : "pass", summary, edits },
  };
}

// 기획 프롬프트(instructions/planning.md + 정책별 hybrid.md/immersive.md + copy.md 리듬). 정책 공통 부분은 하나이고, 장면 계획·시각 계약·
// 정책 규칙·카피 리듬만 정책에 따라 갈린다. immersive 조각은 2026-10-06 문구 그대로다(저장된 기획의 재현·비교를 위해 바꾸지 않는다).
// DATA 앞부분. 테스트가 문구를 확인하고 골든(tests/golden/instructions-planning-*.txt)이 분리 전 출력과 바이트 단위로 대조한다.
export function videoPlanningInstructions(
  policy: VisualPolicyId,
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  const immersive = policy === "immersive_explanations_v1";
  const text = (key: string) => sectionOf(snapshot, key);
  return [
    text("PLANNING_OPENING"),
    text("PLANNING_TARGET_AND_SOLUTION"),
    text("PLANNING_AUDIENCE"),
    text("PLANNING_CONCEPT"),
    text("PLANNING_DECISIONS"),
    immersive ? text("IMMERSIVE_SCENE_PLAN") : text("HYBRID_SCENE_PLAN"),
    immersive ? text("IMMERSIVE_VISUAL_CONTRACT") : text("HYBRID_VISUAL_CONTRACT"),
    text("PLANNING_COPY"),
    immersive ? explanationPlanningRules(snapshot) : hybridPlanningRules(snapshot),
    // 카피 리듬: immersive 는 natural_v1(2026-10-06 Codex), 혼합형은 사용자 결정대로 짧은 호흡(26자 목표·40자 한도).
    copyRhythmInstruction(immersive, snapshot),
  ].join("\n");
}

export async function prepareVideoPlanning(
  task: VideoPlanningTask,
  connection?: OpenAIConnection,
): Promise<ModelResult<VideoPlanning>> {
  const { job, hypothesis } = task;
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 기획에 필요한 프로젝트 자료와 모델이 없습니다.");
  const policy = task.visualPolicy ?? DEFAULT_VISUAL_POLICY;
  const immersive = policy === "immersive_explanations_v1";
  // 지시 파일은 이 기획(기획 + 카피 교정 두 요청)이 시작할 때 한 번 읽어 끝까지 같은 본문을 쓴다.
  const snapshot = loadInstructions();
  const text = (key: string) => sectionOf(snapshot, key);
  const data = {
    ...videoPlanningContext(job, hypothesis, snapshot),
    durationRange: { min: 30, max: 60 },
    infoClipsAllowed: clipModeOf(job) === "flow",
    visualPolicy: policy,
    userFeedback: task.userFeedback ?? null,
  };
  const request = {
    directory: join(dataDir, "cli", job.id, `video-${task.number}`),
    signal: task.signal,
    models: job.executionModels,
    stage: "script" as const,
    maxOutputTokens: 9000,
  };
  task.onProgress?.("planning");
  const draft = await generateTextResult(
    {
      ...request,
      name: "video_planning",
      // 혼합형은 장면마다 explainerScene(물체·동작·강조)을 받고 graphic 소스·explanation(이름표 계획)이 없는 응답 스키마를 쓴다.
      schema: videoPlanningResponseSchemaFor(policy),
      prompt: `${videoPlanningInstructions(policy, snapshot)}
DATA:
${JSON.stringify(data)}`,
    },
    connection,
  );
  task.onProgress?.("copy");
  const edited = await generateTextResult(
    {
      ...request,
      name: "video_copy_editing",
      schema: VideoCopyEditingResponseSchema,
      // 카피 교정 프롬프트(planning.md COPY_EDITING_* + copy.md 규칙). 줄 수는 호출 때 채운다.
      prompt: `${text("COPY_EDITING_OPENING")}
${fillSection(text("COPY_EDITING_LINE_RULE"), { lineCount: draft.value.copy.lines.length })}
${koreanCopyPolishRules(snapshot)}
${copyRhythmInstruction(immersive, snapshot)}
${text("COPY_EDITING_RHYTHM_NOTE")}
DATA:
${JSON.stringify({ ...data, planning: draft.value })}`,
    },
    connection,
  );
  return {
    value: {
      ...editedVideoPlanning(draft.value, guardCopyEdit(draft.value, edited.value)),
      visualPolicy: policy,
    },
    model: edited.model,
  };
}
