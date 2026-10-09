import { join } from "node:path";
import { CHAIN_STEP_KEYS, type CreativePlan } from "../shared/creative-plan";
import type { ArtifactModel } from "../shared/models";
import type { Job } from "../shared/schema";
import { copyProblems, estimateSpeechMs } from "../shared/script-rules-v2";
import type { VideoPlanning } from "../shared/video-planning";
import {
  type CopyLine,
  calloutWordInText,
  hypothesisFactTexts,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
  VideoCopyResponseSchema,
} from "../shared/video-script";
import { Artifacts } from "./artifacts";
import { dataDir } from "./config";
import { BlockedError } from "./errors";
import {
  fillSection,
  type InstructionsStamp,
  instructionsStamp,
  loadInstructions,
  sectionJson,
  sectionOf,
} from "./instructions";
import type { OpenAIConnection } from "./provider-transport";
import { hasArtifact } from "./render-state-helpers";
import type { JobStore } from "./store";
import { generateTextResult } from "./text-provider";
import { videoPlanningContext } from "./video-planning-context";

// 카피 먼저 흐름(2026-10-08, 사용자 결정): 편지 1 이 기획·사실·고객 후기만 보고 문장(사슬 단계 + 글)을 쓰고, 앱이 길이를 초당
// NATURAL_CHARS_PER_SEC 자로 추정해 통과시킨 뒤에야 편지 2(server/video-scripts.ts)가 컷·장면을 붙인다. 이 파일은 편지 1 과
// 두 편지를 잇는 도구(문장 고정)를 둔다. 프롬프트 문구는 instructions/copy-first.md, 규칙 검사는 shared/script-rules-v2.ts.
// 편지 2 가 이 파일에서 가져가는 것만 있으므로(video-scripts.ts → copy-writer.ts) 이 파일은 video-scripts.ts 를 부르지 않는다.
export const COPY_MAX_GENERATIONS = 3;
export const copyArtifactName = (number: number, attempt: number) =>
  `video-copy-${number}-${attempt}.json`;

export type VideoCopyTask = {
  readonly job: Job;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  readonly number: number;
  readonly durationSec: number;
  // 직전 시도의 문제 목록 또는 사용자 수정 요청. 있으면 COPY_FEEDBACK_HEAD 를 붙여 전체를 다시 쓰게 한다.
  readonly feedback?: string;
  readonly signal: AbortSignal;
  readonly planning?: VideoPlanning;
};
export type VideoCopyWritten = {
  readonly lines: CopyLine[];
  readonly model: ArtifactModel;
  // 이 카피를 쓸 때 읽은 지시 파일의 해시·시각. 주입 공급자(테스트)는 생략할 수 있다.
  readonly instructions?: InstructionsStamp;
};
export type VideoCopyProvider = (
  task: VideoCopyTask,
  // 테스트가 로컬 HTTP 픽스처를 쓰기 위한 연결(기본은 .env 의 OpenAI 연결).
  connection?: OpenAIConnection,
) => Promise<VideoCopyWritten>;

// 카피 길이·숫자 대조용 사실 글: 광고안의 인용·신호·사슬 + 프로젝트 자료 본문(제품 사실·오퍼) + 고객 후기.
export function copyFactTexts(
  job: Pick<Job, "sourceSnapshot">,
  hypothesis: CreativePlan["hypotheses"][number],
): string[] {
  const sources = (job.sourceSnapshot?.sources ?? [])
    .filter(
      (source) =>
        source.status === "eligible" &&
        source.contentStatus === "content" &&
        source.evidence === "observed" &&
        ["product_fact", "offer", "review"].includes(source.kind),
    )
    .map((source) => source.content);
  const chain = hypothesis.chain
    ? CHAIN_STEP_KEYS.map((key) => hypothesis.chain?.[key].content ?? "").filter(
        (text) => text.length > 0,
      )
    : [];
  return [...hypothesisFactTexts(hypothesis), ...chain, ...sources];
}

// 편지 1: 문장(사슬 단계 + 글)만 받는다. 한 번 호출(검사·재시도는 writeVideoCopy).
export const generateVideoCopy: VideoCopyProvider = async (task, connection) => {
  const { job, hypothesis, number, planning } = task;
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 카피를 작성할 프로젝트 자료와 모델이 없습니다.");
  // 지시 파일은 호출마다 읽는다(고친 파일은 다음 생성부터). 같은 스냅샷의 해시를 산출물에 남긴다.
  const snapshot = loadInstructions();
  const text = (key: string) => sectionOf(snapshot, key);
  const prompt = [
    text("COPY_WRITE_RULES"),
    `EXAMPLE (shape only; every number and product word must come from DATA.facts and DATA.voices): ${JSON.stringify(sectionJson(snapshot, "COPY_SHAPE_EXAMPLE"))}`,
    task.feedback ? fillSection(text("COPY_FEEDBACK_HEAD"), { feedback: task.feedback }) : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  // 기획의 청중·콘셉트는 주되 장면 계획(scenePlan)과 기획 단계 카피 초안은 뺀다: 편지 1 은 말만 쓴다.
  const planningForCopy = planning
    ? (({ scenePlan: _scenePlan, ...concept }) => ({
        durationSec: planning.durationSec,
        audience: planning.audience,
        concept,
      }))(planning.concept)
    : null;
  const result = await generateTextResult(
    {
      name: "video_copy",
      schema: VideoCopyResponseSchema,
      directory: join(dataDir, "cli", job.id, `video-${number}`),
      signal: task.signal,
      models: job.executionModels,
      stage: "script",
      // 문장 14개 이하의 작은 JSON이지만 reasoning 토큰이 한도를 나눠 쓴다(대본 12000 → 24000 으로 올린 전례).
      maxOutputTokens: 8000,
      prompt: `${prompt}
DATA:
${JSON.stringify({ ...videoPlanningContext(job, hypothesis, snapshot), durationSec: task.durationSec, planning: planningForCopy })}`,
    },
    connection,
  );
  return {
    lines: result.value.lines,
    model: result.model,
    instructions: instructionsStamp(snapshot),
  };
};

export type CopyAssessment = {
  readonly hard: string[];
  readonly soft: string[];
  // 이 카피를 초당 NATURAL_CHARS_PER_SEC 자 + 문장 사이 무음으로 읽을 때의 추정 시간(초, 소수 첫째 자리).
  readonly estimatedSec: number;
};
// 카피 규칙 판정(shared/script-rules-v2.ts copyProblems) + 추정 발화 초. 길이(30~60초)·문장 수·순서·숫자·영문·반복·행동 동사를 코드가 본다.
export function assessCopy(
  lines: readonly CopyLine[],
  context: { readonly durationTargetSec: number; readonly facts: readonly string[] },
): CopyAssessment {
  const rules = copyProblems(lines, context);
  return {
    hard: rules.hard,
    soft: rules.soft,
    estimatedSec: Math.round(estimateSpeechMs(lines.map((line) => line.text)) / 100) / 10,
  };
}
// 다시 쓰기 피드백: 문제 목록 + 추정 발화 초(문장 수·길이를 어느 쪽으로 조절할지 알려 준다).
export function copyFeedback(assessment: CopyAssessment, durationTargetSec: number): string {
  const problems = [...assessment.hard, ...assessment.soft.map((item) => `경고: ${item}`)];
  return `카피 규칙 위반: ${problems.join(" / ")} / 이 카피의 추정 발화 시간은 약 ${assessment.estimatedSec}초입니다(허용 ${VIDEO_MIN_SEC}~${VIDEO_MAX_SEC}초, 목표 ${durationTargetSec}초). 문장을 자르지 말고 문장 수와 길이를 조절해 전체를 다시 쓰세요.`;
}

export type WriteCopyInput = {
  readonly store: JobStore;
  readonly provider: VideoCopyProvider;
  readonly id: string;
  readonly number: number;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  readonly durationSec: number;
  readonly signal: AbortSignal;
  readonly planning: VideoPlanning | undefined;
  // 사용자 수정 요청(다시 쓰기). 이미 SCRIPT_USER_FEEDBACK_PREFIX 로 감싼 글이다.
  readonly userFeedback?: string;
  readonly progress?: (attempt: number) => void;
};
export type CopyOutcome = {
  readonly lines: CopyLine[];
  readonly model: ArtifactModel | null;
  // 카피를 쓴 횟수. 외부 카피(rewrite 본문 copy)는 0.
  readonly attempts: number;
  // 마지막으로 받아들인 카피에 남은 hard(3회 뒤에도 규칙을 못 지킨 경우). 비어 있으면 통과.
  readonly hard: string[];
  readonly soft: string[];
  readonly estimatedSec: number;
  readonly external: boolean;
  readonly stamp?: InstructionsStamp;
};
// 산출물 번호는 작업 안에서 이어진다(다시 쓰기도 다음 번호를 쓴다).
function nextCopyAttempt(job: Job, number: number): number {
  let attempt = 1;
  while (hasArtifact(job, copyArtifactName(number, attempt))) attempt++;
  return attempt;
}
async function saveCopy(
  assets: Artifacts,
  store: JobStore,
  id: string,
  number: number,
  body: {
    readonly lines: readonly CopyLine[];
    readonly assessment: CopyAssessment;
    readonly external: boolean;
  },
  model: ArtifactModel | null,
): Promise<string> {
  const name = copyArtifactName(number, nextCopyAttempt(store.get(id), number));
  await assets.save(id, {
    name,
    kind: "json",
    agentId: "creative",
    content: JSON.stringify({
      external: body.external,
      estimatedSec: body.assessment.estimatedSec,
      hard: body.assessment.hard,
      soft: body.assessment.soft,
      lines: body.lines,
    }),
    ...(model ? { model } : {}),
  });
  return name;
}

// 외부 카피(사용자·다른 에이전트가 rewrite 본문으로 보낸 문장): 편지 1 을 건너뛰고 같은 규칙으로 판정해 산출물만 남긴다.
export async function acceptExternalCopy(
  input: Pick<WriteCopyInput, "store" | "id" | "number"> & {
    readonly lines: readonly CopyLine[];
    readonly context: { readonly durationTargetSec: number; readonly facts: readonly string[] };
  },
): Promise<CopyOutcome> {
  const assessment = assessCopy(input.lines, input.context);
  await saveCopy(
    new Artifacts(input.store),
    input.store,
    input.id,
    input.number,
    { lines: input.lines, assessment, external: true },
    null,
  );
  return {
    lines: [...input.lines],
    model: null,
    attempts: 0,
    hard: assessment.hard,
    soft: assessment.soft,
    estimatedSec: assessment.estimatedSec,
    external: true,
  };
}

// 편지 1 쓰기 루프: 생성 → 규칙·길이 판정 → 걸리면 문제 목록 + 추정 발화 초로 전체를 다시 쓴다(최대 COPY_MAX_GENERATIONS 회).
// 3회 뒤에도 hard 가 남으면 hard 가 가장 적은 카피(동수면 최신)를 돌려주고 호출부가 검토 기록에 남긴다.
export async function writeVideoCopy(input: WriteCopyInput): Promise<CopyOutcome> {
  const { store, id, number, hypothesis } = input;
  const assets = new Artifacts(store);
  const facts = copyFactTexts(store.get(id), hypothesis);
  const context = { durationTargetSec: input.durationSec, facts };
  let violations: string | null = null;
  let best: CopyOutcome | null = null;
  for (let attempt = 1; attempt <= COPY_MAX_GENERATIONS; attempt++) {
    input.progress?.(attempt);
    const feedback = [input.userFeedback, violations]
      .filter((item): item is string => Boolean(item))
      .join("\n");
    const written = await input.provider({
      job: store.get(id),
      hypothesis,
      number,
      durationSec: input.durationSec,
      ...(feedback.length > 0 ? { feedback } : {}),
      signal: input.signal,
      ...(input.planning ? { planning: input.planning } : {}),
    });
    const assessment = assessCopy(written.lines, context);
    await saveCopy(
      assets,
      store,
      id,
      number,
      { lines: written.lines, assessment, external: false },
      written.model,
    );
    const outcome: CopyOutcome = {
      lines: written.lines,
      model: written.model,
      attempts: attempt,
      hard: assessment.hard,
      soft: assessment.soft,
      estimatedSec: assessment.estimatedSec,
      external: false,
      ...(written.instructions ? { stamp: written.instructions } : {}),
    };
    if (assessment.hard.length === 0) return outcome;
    if (!best || assessment.hard.length <= best.hard.length) best = outcome;
    violations = copyFeedback(assessment, input.durationSec);
  }
  if (!best) throw new BlockedError("영상 카피를 작성하지 못했습니다.");
  return { ...best, attempts: COPY_MAX_GENERATIONS };
}

// --- 문장 고정(편지 2 가 문장을 바꾸면 카피 원문으로 되돌린다) ----------------------------------------------------
type Pinnable = {
  readonly text: string;
  readonly chainStep: string;
  readonly callouts: readonly { readonly word: string; readonly text: string }[];
};
export type PinResult<T> = {
  readonly items: T[];
  // "N번째 문장을 카피 원문으로 되돌림" 같은 한국어 수리 기록.
  readonly repairs: string[];
  // 문장 수가 달라 고정할 수 없을 때의 hard 문제(비어 있으면 고정 성공).
  readonly hard: string[];
};
// 장면 응답의 문장(sentences[]) 또는 저장 대본의 음성 문장(voiceover[])을 카피에 맞춘다. 문장 수가 다르면 건드리지 않고 hard 로 알리며(재생성),
// 같으면 글과 사슬 단계를 카피 원문으로 덮어쓴다. 바뀐 문장에 붙은 콜아웃은 어절이 새 글에 없으면 뺀다(없는 어절에 그리지 않게).
export function pinToCopy<T extends Pinnable>(
  items: readonly T[],
  copy: readonly CopyLine[],
): PinResult<T> {
  if (items.length !== copy.length)
    return {
      items: [...items],
      repairs: [],
      hard: [
        `장면 응답의 문장이 ${items.length}개인데 카피는 ${copy.length}개입니다. 문장 수·순서·글을 DATA.copyLines 그대로 두고 장면만 붙이세요.`,
      ],
    };
  const repairs: string[] = [];
  const pinned = items.map((item, index) => {
    const line = copy[index];
    if (!line) return item;
    const textChanged = item.text !== line.text;
    const stepChanged = item.chainStep !== line.chainStep;
    const callouts = item.callouts.filter((callout) => calloutWordInText(callout.word, line.text));
    if (textChanged) repairs.push(`${index + 1}번째 문장을 카피 원문으로 되돌림`);
    else if (stepChanged) repairs.push(`${index + 1}번째 문장의 사슬 단계를 카피 기준으로 되돌림`);
    if (callouts.length !== item.callouts.length)
      for (const callout of item.callouts)
        if (!callouts.includes(callout))
          repairs.push(
            `${index + 1}번째 문장 콜아웃 '${callout.text}' 제거(어절 "${callout.word}"이 카피 원문에 없음)`,
          );
    return textChanged || stepChanged || callouts.length !== item.callouts.length
      ? ({ ...item, text: line.text, chainStep: line.chainStep, callouts } satisfies Pinnable as T)
      : item;
  });
  return { items: pinned, repairs, hard: [] };
}
