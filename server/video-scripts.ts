import { join } from "node:path";
import { clipModeOf } from "../shared/flow-mode";
import { explainerGrammar, hybridReviewRules } from "./hybrid-script-instructions";
import { explanationScriptRules, immersiveScriptRules } from "./immersive-script-instructions";
import { videoScriptInstructions } from "./script-instructions";

export { videoScriptInstructions } from "./script-instructions";

import type { CreativePlan } from "../shared/creative-plan";
import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import { videoScriptFromResponse } from "../shared/script-repair";
import {
  classifyScriptProblems,
  type ScriptExpectation,
  scriptFeedback,
} from "../shared/script-rules";
import type { VideoPlanning } from "../shared/video-planning";
import {
  type CopyLine,
  HfVideoScriptResponseSchema,
  hypothesisFactTexts,
  type VideoScript,
  type VideoScriptReview,
  VideoScriptReviewSchema,
  videoPolicyOf,
  videoScriptIsContinuous,
  videoScriptResponseSchemaFor,
  videoTargetSeconds,
  videoVariantIndex,
  voiceCutRange,
  voicePurposeOf,
} from "../shared/video-script";
import { dataDir } from "./config";
import { copyRhythmInstruction, koreanCopyPolishRules } from "./copy-instructions";
import { pinToCopy } from "./copy-writer";
import { BlockedError } from "./errors";
import {
  fillSection,
  type InstructionsSnapshot,
  type InstructionsStamp,
  instructionsStamp,
  loadInstructions,
  sectionOf,
} from "./instructions";
import type { OpenAIConnection } from "./provider-transport";
import { resolveFont } from "./render/fonts";
import { layoutHfLabels } from "./render/hf-label-layout";
import { requireHfRenderer } from "./render/hf-render";
import { generateTextResult } from "./text-provider";
import { videoPlanningContext } from "./video-planning-context";

// 규칙 분류·수리는 shared 에 있다(화면도 같은 판정을 쓴다). 서버 호출부·테스트 호환을 위해 여기서도 내보낸다.
export { splitSlowCuts } from "../shared/script-repair";
export {
  classifyScriptProblems,
  scriptFeedback,
  VERIFY_FEEDBACK_MAX,
  videoOfferAllowed,
} from "../shared/script-rules";

// AI 대본 품질 검토: 규칙 검사를 통과한 대본을 통째로 읽고 '사람이 듣는 광고 카피'로서 쓸 만한지 판단한다.
// 검토 규칙 본문은 instructions/review.md(번호 절) + 정책별 hybrid.md/immersive.md + copy.md 에 있다. 번호 1~14 는 절 이름의 일부다.
const REVIEW_RULE_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "8B",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
].map((rule) => `REVIEW_RULE_${rule}`);
export type VideoScriptReviewTask = {
  readonly job: Job;
  readonly script: VideoScript;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  readonly signal: AbortSignal;
};
export type VideoScriptReviewer = (
  task: VideoScriptReviewTask,
) => Promise<ModelResult<VideoScriptReview>>;
export async function reviewVideoScript(
  task: VideoScriptReviewTask,
  connection?: OpenAIConnection,
): Promise<ModelResult<VideoScriptReview>> {
  const { job, script, hypothesis } = task;
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 대본을 검토할 프로젝트 자료와 모델이 없습니다.");
  // 시각 정책 분기: immersive 는 natural_v1 리듬·입체 설명 계약, hybrid(2026-10-07)는 짧은 호흡·혼합형 계약, 예전 대본은 리듬만.
  const kind = videoPolicyOf(script);
  // 지시 파일은 호출마다 읽는다(고친 파일은 다음 검토부터). 규칙 15 는 정책 계약(immersive 입체 설명 / hybrid 설명 세계 문법),
  // 규칙 16 은 설명 설계가 있는 대본만 받는다.
  const snapshot = loadInstructions();
  const text = (key: string) => sectionOf(snapshot, key);
  const hfLabels = script.infoClips.some((clip) => clip.labelLayer);
  const contractRule = hfLabels
    ? text("HF_REVIEW_RULES")
    : kind === "immersive"
      ? `${text("IMMERSIVE_REVIEW_CONTRACT_INTRO")}\n${immersiveScriptRules(snapshot)}`
      : kind === "hybrid"
        ? `${text("HYBRID_REVIEW_GRAMMAR_INTRO")}\n${explainerGrammar(snapshot)}`
        : "";
  const explanationRule = script.infoClips.some((clip) => clip.explanation)
    ? `${text("IMMERSIVE_REVIEW_EXPLANATION")}\n${explanationScriptRules(snapshot)}`
    : "";
  return generateTextResult(
    {
      name: "video_script_review",
      schema: VideoScriptReviewSchema,
      directory: join(dataDir, "cli", job.id, `video-${script.number}`),
      signal: task.signal,
      models: job.executionModels,
      stage: "script",
      // 검토 규칙이 늘어 4000 에서 응답이 끊겼다(2026-10-06 실전).
      maxOutputTokens: 12000,
      prompt: `${text("REVIEW_OPENING")}
${text("REVIEW_RETURN_RULE")}
${kind === "immersive" ? text("REVIEW_RHYTHM_IMMERSIVE") : text("REVIEW_RHYTHM_DEFAULT")}
${kind === "hybrid" && !hfLabels ? hybridReviewRules(snapshot) : ""}
${REVIEW_RULE_KEYS.map(text).join("\n")}
${contractRule}
${explanationRule}
${koreanCopyPolishRules(snapshot)}
${copyRhythmInstruction(kind === "immersive", snapshot)}
DATA:
${JSON.stringify({
  ...videoPlanningContext(job, hypothesis, snapshot),
  planning: script.planning ?? null,
  infoClipsAllowed: clipModeOf(job) === "flow",
  durationSec: script.durationSec,
  voicePersona: script.voicePersona,
  fixedTitle: script.fixedTitle,
  disclaimer: script.disclaimer,
  openLoop: script.openLoop,
  styleAnchor: script.styleAnchor,
  // 혼합형(2026-10-07): 설명 세계 기준(다른 정책은 ""). 규칙 1c·15 가 실사 기준과 따로 본다.
  explainerAnchor: script.explainerAnchor,
  visualPolicy: script.planning?.visualPolicy ?? null,
  // 장면 계획(2026-10-06): 등장 대상·클립 구간 계획·컷 goal/phase·문장 콜아웃을 같이 넘겨 규칙 14 를 볼 수 있게 한다.
  subjects: script.subjects,
  stills: script.stills,
  veoClips: script.veoClips,
  // 설명 컷(I1~I3)을 빼먹어 검토가 매 회차 "I1·I2·I3 소스가 없다"고 지적했다(2026-10-06, gpt-6-astra 실측).
  infoClips: script.infoClips,
  editInstructions: script.editInstructions,
  visualSequence: script.cuts.map((cut, cutIndex) => ({
    cutIndex,
    startSec: cut.startSec,
    endSec: cut.endSec,
    source: cut.source,
    veoClip: cut.veoClip,
    phase: cut.phase,
    stillId: cut.stillId,
    effect: cut.effect,
    goal: cut.goal,
    screenComposition: cut.screenComposition,
    onScreenText: cut.onScreenText,
    graphicLines: cut.graphicLines,
  })),
  pairs: scriptPairs(script),
  silentCuts: silentCuts(script),
})}`,
    },
    connection,
  );
}

// AI 검토에 넘기는 문장↔컷 짝 표: 문장마다 그 문장이 흐르는 컷의 구도·자막·글줄을 붙인다(모델이 "말과 그림"을 같이 본다).
// 장면 계획 대본은 문장의 콜아웃과 컷의 goal·phase 도 같이 넘긴다(예전 대본은 []·""").
export function scriptPairs(script: VideoScript) {
  return script.voiceover.map((voice, sentenceIndex) => {
    const range = voiceCutRange(voice, script.cuts);
    return {
      sentenceIndex,
      purpose: voicePurposeOf(voice, script.cuts),
      text: voice.text,
      callouts: voice.callouts,
      ...(voice.actionSync ? { actionSync: voice.actionSync } : {}),
      cuts: range
        ? script.cuts.slice(range[0], range[1] + 1).map((cut, offset) => ({
            cutIndex: range[0] + offset,
            startSec: cut.startSec,
            endSec: cut.endSec,
            purpose: cut.purpose,
            source: cut.source,
            veoClip: cut.veoClip,
            phase: cut.phase,
            goal: cut.goal,
            screenComposition: cut.screenComposition,
            onScreenText: cut.onScreenText,
            graphicLines: cut.graphicLines,
          }))
        : [],
    };
  });
}
// 어느 문장에도 묶이지 않은(말 없는) 컷 번호.
export function silentCuts(script: VideoScript): number[] {
  const covered = new Set<number>();
  for (const voice of script.voiceover) {
    const range = voiceCutRange(voice, script.cuts);
    if (range) for (let k = range[0]; k <= range[1]; k++) covered.add(k);
  }
  return script.cuts.map((_, index) => index).filter((index) => !covered.has(index));
}
// 제품 낱말 대조용 사실 글: 가설의 인용·신호 + 프로젝트 자료 본문(evidence pack).
export function scriptFactTexts(
  job: Pick<Job, "sourceSnapshot">,
  hypothesis: CreativePlan["hypotheses"][number],
): string[] {
  const sources = (job.sourceSnapshot?.sources ?? [])
    .filter(
      (source) =>
        source.status === "eligible" &&
        source.contentStatus === "content" &&
        source.evidence === "observed" &&
        ["product_fact", "offer"].includes(source.kind),
    )
    .map((source) => source.content);
  return [...hypothesisFactTexts(hypothesis), ...sources];
}

// 모델이 쓴 대본(저장 형식) + 변환 중 자동 수리 기록·경고. 픽스처 공급자는 value·model 만 돌려줘도 된다.
export type VideoScriptWritten = ModelResult<VideoScript> & {
  readonly repairs?: readonly string[];
  readonly warnings?: readonly string[];
  // 카피 먼저 흐름(편지 2)에서 카피 문장을 고정할 수 없을 때의 hard 문제(문장 수가 카피와 다름). 호출부가 규칙 hard 에 합친다.
  readonly hard?: readonly string[];
  // 이 대본을 쓸 때 읽은 지시 파일의 해시·시각(D5). 주입 공급자(테스트)는 생략할 수 있다.
  readonly instructions?: InstructionsStamp;
};
// 카피 먼저 흐름(2026-10-08): copyLines 가 있으면 편지 2 — 확정 문장을 고정 입력으로 주고 장면만 받는다(혼합형 정책에서만).
export type VideoScriptOptions = { readonly copyLines?: readonly CopyLine[] };
export type VideoScriptProvider = (
  job: Job,
  hypothesis: CreativePlan["hypotheses"][number],
  number: number,
  signal: AbortSignal,
  // 직전 대본이 규칙 검사에서 걸린 이유. 다시 쓸 때 고칠 점으로 전달한다.
  feedback?: string,
  // 테스트가 로컬 HTTP 픽스처를 쓰기 위한 연결(기본은 .env 의 OpenAI 연결).
  connection?: OpenAIConnection,
  planning?: VideoPlanning,
  options?: VideoScriptOptions,
) => Promise<VideoScriptWritten>;

// 편지 2 응답 칸 이름(스키마와 묶임, 코드 고정). sentences[i].text·chainStep 은 DATA.copyLines[i] 를 그대로 옮긴다.
const SCENE_SHAPE =
  "JSON SHAPE: {title, fixedTitle, disclaimer, voicePersona, openLoop, payoffSec, styleAnchor, explainerAnchor, subjects[{id, traits}], veoClips[{id, startImagePrompt, prompt, plan{early{camera, action}, mid{…}, late{…}}}], stills[{id, prompt}], infoClips[{id, stage, cleanPrompt, infoPrompt, infoLines[], labelLayer, plan, sceneType, objects[{subjectId, color}], actions[], emphasis[{kind, target, afterAction}]}], sentences[{purpose, chainStep, text, actionSync, callouts[{word, text, kind, anchor, targetId}], cuts[{len, source, screenComposition, onScreenText, effect, veoClip, stillId, graphicKind, graphicLines, goal, phase}]}], flowPrompt, editInstructions}. sentences[i].text and chainStep are copied from DATA.copyLines[i]; purpose is the sentence's editorial label (hook, pain, story, mechanism, proof, offer, cta or rehook).";
// 편지 2 프롬프트(instructions/copy-first.md SCENE_FROM_COPY_RULES + 설명 컷 불가 안내 + 응답 칸 이름 + 피드백). 기존 대본 프롬프트(videoScriptInstructions)는 그대로다.
export function sceneFromCopyInstructions(
  input: { readonly infoClips: boolean; readonly feedback?: string },
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  const text = (key: string) => sectionOf(snapshot, key);
  return [
    text("SCENE_FROM_COPY_HF_RULES"),
    input.infoClips ? "" : text("SCRIPT_INFO_CLIPS_NONE"),
    SCENE_SHAPE,
    input.feedback ? fillSection(text("SCRIPT_FEEDBACK_PREFIX"), { feedback: input.feedback }) : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

// 편지 2 에 보여 줄 기획: 카피 초안 줄·교정 기록을 뺀다(말투 지정 voicePersona 만 남긴다).
function planningWithoutCopy(planning: VideoPlanning) {
  const { copy, copyReview: _copyReview, ...rest } = planning;
  return { ...rest, copy: { voicePersona: copy.voicePersona } };
}

// 응답(문장 우선·컷 중첩) → 자동 수리 → 평면화 → 저장 형식. number/hypothesisId 는 문맥에서 채우고 길이는 컷 합계에서 유도한다.
export const generateVideoScript: VideoScriptProvider = (
  job,
  hypothesis,
  number,
  signal,
  feedback,
  connection,
  planning,
  options,
) => {
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 대본을 작성할 프로젝트 자료와 모델이 없습니다.");
  const seconds =
    planning?.durationSec ??
    videoTargetSeconds(job.id, number, videoVariantIndex(job.videoScripts, number, hypothesis.id));
  // 정책 분기(2026-10-07): 기획이 없는 예전 작업은 legacy, immersive 는 2026-10-06 계약, hybrid 는 혼합형 계약·응답 스키마.
  const kind = videoPolicyOf({ planning });
  // 지시 파일(instructions/)은 생성 호출마다 읽는다. 같은 스냅샷의 해시를 산출물(renders[n].scriptReview)에 남긴다.
  const snapshot = loadInstructions();
  // 카피 먼저 흐름(편지 2)은 혼합형 정책에서만: 확정 문장(copyLines)을 고정 입력으로 주고 장면만 받는다.
  const copyLines = kind === "hybrid" ? options?.copyLines : undefined;
  const infoClipsAllowed = clipModeOf(job) === "flow";
  const instructions = copyLines
    ? sceneFromCopyInstructions(
        { infoClips: infoClipsAllowed, ...(feedback ? { feedback } : {}) },
        snapshot,
      )
    : videoScriptInstructions(
        {
          seconds,
          hypothesis,
          hasClips: (job.productionSourceSnapshot?.assets.length ?? 0) > 0,
          infoClips: infoClipsAllowed,
          immersive: kind === "immersive",
          hybrid: kind === "hybrid",
          ...(feedback ? { feedback } : {}),
        },
        snapshot,
      );
  const productionClips =
    job.productionSourceSnapshot?.assets.map((asset) => ({
      id: asset.id,
      title: asset.title,
      settings: asset.settings,
    })) ?? [];
  // 편지 2 의 DATA: 기획의 카피 초안(planning.copy.lines)과 그 교정 기록(copyReview)은 빼서 확정 문장(copyLines)과 두 갈래가 되지 않게 한다.
  const data = copyLines
    ? {
        ...videoPlanningContext(job, hypothesis, snapshot),
        durationTarget: seconds,
        planning: planning ? planningWithoutCopy(planning) : null,
        productionClips,
        infoClipsAllowed,
        copyLines,
      }
    : {
        ...videoPlanningContext(job, hypothesis, snapshot),
        durationTarget: seconds,
        planning: planning ?? null,
        productionClips,
      };
  const written = generateTextResult(
    {
      name: "video_script",
      // 혼합형은 explainerAnchor 와 장면 필드(sceneType·objects·actions·emphasis)를 받는 별도 응답 스키마를 쓴다.
      schema: copyLines
        ? HfVideoScriptResponseSchema
        : videoScriptResponseSchemaFor(planning?.visualPolicy),
      directory: join(dataDir, "cli", job.id, `video-${number}`),
      signal,
      models: job.executionModels,
      stage: "script",
      // 중첩 JSON(문장 40개·컷 60개)과 gpt-5-mini 의 reasoning 토큰이 한도를 나눠 쓴다(9000 에서 incomplete 가능).
      // 설명 컷(infoClips)까지 들어가며 12000 에서 응답이 끊겼다(2026-10-06 실전).
      // 장면 계획(2026-10-06 R1~R8)으로 컷마다 goal·phase, 문장마다 callouts, 클립마다 plan 3구간(camera·action 영어 6줄),
      // subjects 가 더해져 응답이 다시 길어졌으므로 24000 으로 올린다(실측 전 추정).
      // 혼합형(2026-10-07)은 설명 컷의 explanation(대상·동작·이름표 JSON) 대신 더 짧은 장면 필드를 받으므로 같은 한도를 둔다.
      maxOutputTokens: 24000,
      prompt: `${instructions}
DATA:
${JSON.stringify(data)}`,
    },
    connection,
  );
  return written.then((result) => {
    // 편지 2: 모델이 문장을 바꿨으면 카피 원문으로 되돌린다(수리 시간 계산 전에 해서 글자 수 기준 시간이 카피와 맞는다).
    // 문장 수가 다르면 고정할 수 없으므로 hard 로 알려 다시 쓰게 한다.
    const pinned = copyLines ? pinToCopy(result.value.sentences, copyLines) : null;
    const response = pinned ? { ...result.value, sentences: pinned.items } : result.value;
    const converted = videoScriptFromResponse(response, {
      number,
      hypothesisId: hypothesis.id,
      targetSec: seconds,
      hasCardSlides: hypothesis.cardSlides.length > 0,
      // 대표 이미지 컷 강제(R5)는 예전 정책만. immersive·hybrid 는 엔딩을 규칙(hybrid 는 마지막 컷 실사+제품)으로 본다.
      requireApprovedImage: kind === "legacy",
    });
    return {
      ...result,
      value: {
        ...converted.script,
        ...(planning ? { planning } : {}),
        ...(copyLines ? { flow: "copy_first" as const } : {}),
      },
      repairs: [...(pinned?.repairs ?? []), ...converted.repairs],
      warnings: converted.warnings,
      ...(pinned && pinned.hard.length > 0 ? { hard: pinned.hard } : {}),
      instructions: instructionsStamp(snapshot),
    };
  });
};

// 예전 8초 대본까지 포함해 저장된 대본이 기획과 연결돼 있는지만 확인한다(재개용).
export function verifyVideoScript(script: VideoScript, number: number, hypothesisId: string): void {
  if (script.infoClips.some((clip) => clip.labelLayer)) {
    requireHfRenderer();
    const font = resolveFont();
    if (!font) throw new BlockedError("HyperFrames 라벨용 한글 글꼴이 없습니다.");
    for (const clip of script.infoClips)
      if (clip.labelLayer) layoutHfLabels(clip.labelLayer, clip.infoLines, font);
  }
  if (
    script.number !== number ||
    script.hypothesisId !== hypothesisId ||
    (videoPolicyOf(script) === "legacy" &&
      !script.cuts.some((cut) => cut.source === "approved_image")) ||
    !videoScriptIsContinuous(script)
  )
    throw new BlockedError(
      "영상 대본의 번호·광고안·대표 이미지 또는 컷 시간이 기획과 맞지 않습니다.",
    );
}

// hard 규칙에 걸리면 지금처럼 BlockedError 를 던지는 얇은 래퍼(피드백은 hard 뒤에 soft, 16건 상한). soft 만 남으면 통과한다.
export function verifyLongVideoScript(script: VideoScript, expected: ScriptExpectation): void {
  const { hard, soft } = classifyScriptProblems(script, expected);
  if (hard.length > 0) throw new BlockedError(scriptFeedback(hard, soft));
}
