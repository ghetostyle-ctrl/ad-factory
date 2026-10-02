import { join } from "node:path";
import type { CreativePlan } from "../shared/creative-plan";
import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import {
  CAPTION_LINE_MAX_CHARS,
  CUT_MAX_SEC,
  NARRATION_MAX_CHARS_PER_SEC,
  NARRATION_MIN_CHARS_PER_SEC,
  VEO_SHOTS_MAX,
  type VideoScript,
  VideoScriptResponseSchema,
  videoScriptIsContinuous,
  videoTargetSeconds,
} from "../shared/video-script";
import { dataDir } from "./config";
import { BlockedError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { generateTextResult } from "./text-provider";

export type VideoScriptProvider = (
  job: Job,
  hypothesis: CreativePlan["hypotheses"][number],
  number: number,
  signal: AbortSignal,
) => Promise<ModelResult<VideoScript>>;

export const generateVideoScript: VideoScriptProvider = (job, hypothesis, number, signal) => {
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 대본을 작성할 프로젝트 자료와 모델이 없습니다.");
  const seconds = videoTargetSeconds(job.id, number);
  const minChars = Math.ceil(seconds * NARRATION_MIN_CHARS_PER_SEC);
  const maxChars = Math.floor(seconds * NARRATION_MAX_CHARS_PER_SEC);
  return generateTextResult({
    name: "video_script",
    schema: VideoScriptResponseSchema,
    directory: join(dataDir, "cli", job.id, `video-${number}`),
    signal,
    models: job.executionModels,
    maxOutputTokens: 9000,
    prompt: `Write one Korean ecommerce video ad script (Meta Reels, 9:16) BEFORE any visual generation. Return JSON only. durationSec is exactly ${seconds}. Make contiguous cuts from second 0 to second ${seconds}, each cut 1-${CUT_MAX_SEC} seconds (mostly 1-3; never hold one picture longer than ${CUT_MAX_SEC} seconds).
STRUCTURE (7 steps in this order, merge or lengthen steps but keep the order): hook (0-3s: call the avatar, first frame shows a face or the problem scene, 5-10 character caption) -> pain (the concrete discomfort, preferably a fix they already tried that failed, as a question when natural) -> story (the situation or the real cause reframed: "not X, it is Y") -> mechanism (our unique way of working shown visually; this is the USP) -> proof (cited product facts; real customer reviews only when supplied) -> offer (ONLY for a BOFU final_decision concept whose signals.offer is not none, stated exactly as written there) -> cta (last cut). Weight by awareness stage (hypothesis.decisionRole): need_awareness (TOFU) spends longest on pain/story/mechanism and ends with a learn-more CTA; comparison (MOFU) spends longest on mechanism and proof; final_decision (BOFU) names the brand early and spends longest on proof and offer.
SIGNALS: when hypothesis.signals exists, the hook caption and narration call signals.avatarCallout, the pain step uses signals.painPoint, the mechanism step shows signals.mechanism, and nothing else may promise an offer.
NARRATION: total narration across all cuts is ${minChars}-${maxChars} Korean characters including spaces (about ${NARRATION_MIN_CHARS_PER_SEC}-${NARRATION_MAX_CHARS_PER_SEC} characters per second); each cut's narration must fit its own duration at that pace; cut boundaries fall where a sentence ends, never mid-sentence; do not leave silence longer than one cut. Spoken, natural Korean, not written prose.
CAPTIONS: onScreenText is the visible caption, at most 2 lines separated by a newline, each line at most ${CAPTION_LINE_MAX_CHARS} characters including spaces; use an empty string when the shot needs no caption.
SOURCES per cut: approved_image (the concept's approved cover image, shown with slow zoom/pan; at least one cut must use it), card_slide (only when hypothesis.cardSlides is not empty: one of those card-news slides), project_clip (only when productionClips are supplied, by title), veo_clip (an AI-generated 8-second source clip; at most ${VEO_SHOTS_MAX} distinct veoPrompt values per script, reuse the same veoPrompt for several cuts cut from the same clip). veoPrompt: an executable English Veo prompt for an 8-second 9:16 shot when source is veo_clip, otherwise an empty string; no talking people, no lip sync, no invented product appearance, logos or packaging. flowPrompt repeats the most important veoPrompt (or, if no veo_clip is used, a prompt that animates the approved image).
editInstructions: concise Korean edit notes (cut rhythm, caption entrance timing slightly before speech, product kept in the lower third, safe zones).
Do not invent product claims, appearance, testimonials, prices, deadlines or performance. Use only cited product facts. Reference ads provide structure, not proof. If reference visuals were not analyzed, do not invent them. Match number and hypothesisId exactly.
DATA:
${JSON.stringify({ number, durationSec: seconds, hypothesis, facts: evidencePack(job.sourceSnapshot).facts.map((source) => ({ id: source.id, content: source.content })), productionClips: job.productionSourceSnapshot?.assets.map((asset) => ({ id: asset.id, title: asset.title, settings: asset.settings })) ?? [], references: job.creativePlan?.referenceAnalyses ?? [] })}`,
  });
};

// 예전 8초 대본까지 포함해 저장된 대본이 기획과 연결돼 있는지만 확인한다(재개용).
export function verifyVideoScript(script: VideoScript, number: number, hypothesisId: string): void {
  if (
    script.number !== number ||
    script.hypothesisId !== hypothesisId ||
    !script.cuts.some((cut) => cut.source === "approved_image") ||
    !videoScriptIsContinuous(script)
  )
    throw new BlockedError(
      "영상 대본의 번호·광고안·대표 이미지 또는 컷 시간이 기획과 맞지 않습니다.",
    );
}

const lineLength = (text: string) => [...text].length;
// 새로 쓴 30초~1분 대본의 길이·흐름·자막·내레이션·소스 규칙.
export function verifyLongVideoScript(
  script: VideoScript,
  expected: {
    readonly number: number;
    readonly durationSec: number;
    readonly hypothesis: CreativePlan["hypotheses"][number];
  },
): void {
  const { hypothesis } = expected;
  verifyVideoScript(script, expected.number, hypothesis.id);
  const fail = (message: string): never => {
    throw new BlockedError(`영상 대본 규칙 위반: ${message}`);
  };
  if (script.durationSec !== expected.durationSec)
    fail(`길이가 ${expected.durationSec}초가 아닙니다.`);
  for (const cut of script.cuts) {
    const length = cut.endSec - cut.startSec;
    if (length > CUT_MAX_SEC) fail(`한 컷이 ${CUT_MAX_SEC}초를 넘습니다(${cut.startSec}초).`);
    const lines = cut.onScreenText ? cut.onScreenText.split("\n") : [];
    if (lines.length > 2 || lines.some((item) => lineLength(item.trim()) > CAPTION_LINE_MAX_CHARS))
      fail(`자막은 2줄, 한 줄 ${CAPTION_LINE_MAX_CHARS}자 이내여야 합니다(${cut.startSec}초).`);
    if (lineLength(cut.narration) > Math.ceil(length * NARRATION_MAX_CHARS_PER_SEC) + 2)
      fail(`내레이션이 컷 길이에 비해 깁니다(${cut.startSec}초).`);
    if ((cut.source === "veo_clip") !== cut.veoPrompt.length > 0)
      fail("Veo 클립 컷에만 Veo 프롬프트를 적어야 합니다.");
    if (cut.source === "card_slide" && hypothesis.cardSlides.length === 0)
      fail("카드뉴스가 없는 광고안에서 카드 장면을 쓸 수 없습니다.");
  }
  const narration = script.cuts.reduce((sum, cut) => sum + lineLength(cut.narration), 0);
  if (
    narration < Math.ceil(script.durationSec * NARRATION_MIN_CHARS_PER_SEC) ||
    narration > Math.floor(script.durationSec * NARRATION_MAX_CHARS_PER_SEC)
  )
    fail(`내레이션 총량(${narration}자)이 ${script.durationSec}초 분량에 맞지 않습니다.`);
  if (script.cuts[0]?.purpose !== "hook") fail("첫 컷은 후킹이어야 합니다.");
  if (script.cuts.at(-1)?.purpose !== "cta") fail("마지막 컷은 행동 유도여야 합니다.");
  if (!script.cuts.some((cut) => cut.purpose === "mechanism"))
    fail("메커니즘(우리만의 작동 방식) 장면이 필요합니다.");
  const offerAllowed =
    hypothesis.decisionRole === "final_decision" &&
    !!hypothesis.signals &&
    hypothesis.signals.offer.type !== "none";
  if (!offerAllowed && script.cuts.some((cut) => cut.purpose === "offer"))
    fail("오퍼 장면은 오퍼 자료가 있는 BOFU 광고안에서만 씁니다.");
  if (new Set(script.cuts.map((cut) => cut.veoPrompt).filter(Boolean)).size > VEO_SHOTS_MAX)
    fail(`Veo 클립은 영상 1편에 ${VEO_SHOTS_MAX}개까지입니다.`);
}
