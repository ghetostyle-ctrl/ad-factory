import type { CreativePlan } from "./creative-plan";
import {
  alignmentProblems,
  CAPTION_LINE_MAX_CHARS,
  hypothesisFactTexts,
  MOTION_GRAPHIC_MAX_RATIO,
  maxSentenceSec,
  NARRATION_MAX_CHARS_PER_SEC,
  NARRATION_MIN_CHARS_PER_SEC,
  narrationProblems,
  STILL_MAX_SEC,
  STILL_SHOTS_MAX,
  VEO_CLIP_SEC,
  VEO_MAX_RATIO,
  VEO_SHOTS_MAX,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
  type VideoScript,
  voiceCutRange,
} from "./video-script";

// 영상 대본 규칙을 hard(거부·다시 생성)와 soft(경고로 받아들임)로 나눈다(2026-10-04).
// 실전 gpt-5-mini 가 3회 모두 거부된 뒤 멈춘 원인 중 하나는 '모든 규칙이 거부'였기 때문이다. 이제 품질을 미세하게 좌우하는
// 발화량·자막·목표 길이 차이는 경고로 남기고 사용자·AI 검토가 본다. 컷 속도와 이야기 순서는 강제하지 않는다.
// 서버 verifyLongVideoScript(거부 래퍼)·VideoScriptService(view/edit/approve)·화면 ScriptEditor 가 같은 함수를 쓴다.
export type ScriptProblems = { readonly hard: string[]; readonly soft: string[] };
export type ScriptExpectation = {
  readonly number: number;
  // 목표 길이(초). 실제 길이(컷 합계)는 30~60초까지 받고 목표와 다른 것은 경고만 남긴다.
  readonly durationSec: number;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  // 업로드된 촬영본이 있어야 project_clip 컷을 쓸 수 있다.
  readonly hasProjectClips?: boolean;
  // 제품 낱말 대조에 쓸 사실 글(자료 본문). 없으면 가설의 인용·신호만 쓴다.
  readonly facts?: readonly string[];
};
// 다음 생성에 전달하는 규칙 위반 수 상한. 말과 그림 규칙이 더해져 종류가 두 배가 됐으므로 8개로는 어긋남이 잘려 나갔다.
export const VERIFY_FEEDBACK_MAX = 16;
// 모델에 돌려주는 피드백 문자열: hard(말·그림 → 낱말 순) 뒤에 soft 를 붙이고 상한에서 자른다.
export function scriptFeedback(hard: readonly string[], soft: readonly string[] = []): string {
  const problems = [...hard, ...soft];
  return `영상 대본 규칙 위반: ${problems.slice(0, VERIFY_FEEDBACK_MAX).join(" / ")}${
    problems.length > VERIFY_FEEDBACK_MAX
      ? ` / (외 ${problems.length - VERIFY_FEEDBACK_MAX}건 더 있음)`
      : ""
  }`;
}
// 오퍼 장면은 오퍼 자료가 있는 BOFU 광고안에서만 쓴다(프롬프트와 검사가 같은 판단을 쓴다).
export function videoOfferAllowed(hypothesis: CreativePlan["hypotheses"][number]): boolean {
  return (
    hypothesis.decisionRole === "final_decision" &&
    !!hypothesis.signals &&
    hypothesis.signals.offer.type !== "none"
  );
}
const lineLength = (text: string) => [...text].length;
const cutDurationMs = (cut: VideoScript["cuts"][number]) =>
  Math.round(cut.endSec * 1000) - Math.round(cut.startSec * 1000);

export function classifyScriptProblems(
  script: VideoScript,
  expected: ScriptExpectation,
): ScriptProblems {
  const { hypothesis } = expected;
  const hard: string[] = [];
  const soft: string[] = [];
  const fail = (message: string) => {
    if (!hard.includes(message)) hard.push(message);
  };
  const warn = (message: string) => {
    if (!soft.includes(message)) soft.push(message);
  };
  if (script.number !== expected.number || script.hypothesisId !== hypothesis.id)
    fail(`number는 ${expected.number}, hypothesisId는 ${hypothesis.id}여야 합니다.`);
  // 길이: 컷 합계가 30~60초면 받는다. 목표와 다른 것은 경고.
  const [shortest, longest] = [VIDEO_MIN_SEC, VIDEO_MAX_SEC];
  if (script.durationSec < shortest || script.durationSec > longest)
    fail(
      `길이 ${script.durationSec}초는 허용 범위 ${shortest}~${longest}초 밖입니다(목표 ${expected.durationSec}초). 문장을 더하거나 빼세요.`,
    );
  else if (script.durationSec !== expected.durationSec)
    warn(`목표 ${expected.durationSec}초, 실제 ${script.durationSec}초입니다.`);
  // 컷 시간 연속성·마지막 컷 = durationSec: 중첩 응답에서는 구조상 성립(내부 단언).
  let end = 0;
  for (const cut of script.cuts) {
    if (cut.startSec !== end || cut.endSec <= cut.startSec) {
      fail(`컷 시간이 이어지지 않습니다(${end}초 다음 컷이 ${cut.startSec}~${cut.endSec}초).`);
      break;
    }
    end = cut.endSec;
  }
  if (end !== script.durationSec)
    fail(`마지막 컷이 ${end}초에 끝납니다. 0초부터 ${script.durationSec}초까지 채워야 합니다.`);
  if (!script.cuts.some((cut) => cut.source === "approved_image"))
    fail("대표 이미지(approved_image) 컷이 하나 이상 필요합니다.");
  for (const cut of script.cuts) {
    const lines = cut.onScreenText ? cut.onScreenText.split("\n") : [];
    if (lines.length > 1 || lines.some((item) => lineLength(item.trim()) > CAPTION_LINE_MAX_CHARS))
      warn(`자막은 1줄, 한 줄 ${CAPTION_LINE_MAX_CHARS}자 이내여야 합니다(${cut.startSec}초).`);
    if ((cut.source === "veo_clip") !== cut.veoClip.length > 0)
      fail("Veo 클립 컷만 선언한 클립(veoClips 의 id)을 가리켜야 합니다.");
    if (cut.source === "veo_clip" && !script.veoClips.some((clip) => clip.id === cut.veoClip))
      fail(`${cut.startSec}초 컷이 선언하지 않은 Veo 클립 ${cut.veoClip}을 가리킵니다.`);
    if ((cut.source === "still_image") !== cut.stillId.length > 0)
      fail(
        "정지 이미지 컷만 선언한 정지 이미지(stills 의 id)를 가리켜야 합니다(다른 소스는 빈 문자열).",
      );
    if (cut.source === "still_image" && !script.stills.some((still) => still.id === cut.stillId))
      fail(`${cut.startSec}초 컷이 선언하지 않은 정지 이미지 ${cut.stillId}을 가리킵니다.`);
    if ((cut.source === "motion_graphic") !== cut.graphicKind.length > 0)
      fail("모션그래픽 컷만 graphicKind 를 정합니다(다른 소스는 빈 문자열).");
    if (cut.source === "motion_graphic" && cut.graphicLines.length === 0)
      fail(
        `${cut.startSec}초 모션그래픽 컷에 보여줄 글줄(graphicLines)이 없습니다(자막도 없어 채우지 못했습니다).`,
      );
    if (cut.source !== "motion_graphic" && cut.graphicLines.length > 0)
      fail(`${cut.startSec}초 컷은 모션그래픽이 아닌데 graphicLines 가 있습니다.`);
    if (cut.source === "card_slide" && hypothesis.cardSlides.length === 0)
      fail("카드뉴스가 없는 광고안에서 카드 장면을 쓸 수 없습니다.");
    if (cut.source === "project_clip" && !expected.hasProjectClips)
      fail("업로드된 촬영본이 없어 project_clip 을 쓸 수 없습니다.");
  }
  for (let index = 2; index < script.cuts.length; index++) {
    const effects = script.cuts.slice(index - 2, index + 1).map((cut) => cut.effect);
    if (effects[0] !== "hard_cut" && effects.every((effect) => effect === effects[0]))
      warn(`같은 효과(${effects[0]})가 3번 연속입니다(${script.cuts[index]?.startSec}초).`);
  }
  if (!script.openLoop) warn("후킹에서 던질 궁금증(openLoop)이 없습니다.");
  if (script.payoffSec >= script.durationSec)
    warn("궁금증의 답(payoffSec)은 영상 시간 안에 있어야 합니다.");
  const minChars = Math.ceil(script.durationSec * NARRATION_MIN_CHARS_PER_SEC);
  const maxChars = Math.floor(script.durationSec * NARRATION_MAX_CHARS_PER_SEC);
  if (script.voiceover.length === 0) fail("음성 트랙(voiceover)이 없습니다.");
  // 컷에 묶인 대본(fromCut ≥ 0)은 말 없는 구간·문장 길이를 alignmentProblems 가 컷 기준으로 검사한다.
  // 아래 시간 기준 검사(3초 공백·창 글자 수 +6)는 컷 범위가 없던 예전 대본에만 적용한다.
  const bound = script.voiceover.some((voice) => voice.fromCut >= 0);
  let voiceEnd = 0;
  for (const voice of script.voiceover) {
    const window = voice.endSec - voice.startSec;
    if (voice.startSec < voiceEnd || window <= 0 || voice.endSec > script.durationSec) {
      fail(`음성 문장 시간이 겹치거나 범위를 벗어납니다(${voice.startSec}~${voice.endSec}초).`);
      break;
    }
    if (!bound) {
      if (voice.startSec - voiceEnd > 3)
        warn(`${voiceEnd}~${voice.startSec}초에 말이 3초 넘게 비어 있습니다.`);
      const limit = Math.floor(window * NARRATION_MAX_CHARS_PER_SEC) + 6;
      if (lineLength(voice.text) > limit)
        warn(
          `${voice.startSec}~${voice.endSec}초 문장이 ${lineLength(voice.text)}자로 깁니다(${limit}자 이하로 줄이거나 시간을 늘리세요).`,
        );
    }
    voiceEnd = voice.endSec;
  }
  if (!bound && script.voiceover.length > 0 && script.durationSec - voiceEnd > 3)
    warn(`${voiceEnd}초 이후 말이 3초 넘게 비어 있습니다.`);
  // 말과 그림 일치(컷에 묶인 문장): 범위·순서·말한 숫자. 낱말 규칙보다 먼저 모은다.
  if (bound) {
    for (const problem of alignmentProblems(script, [
      ...hypothesisFactTexts(hypothesis),
      ...(expected.facts ?? []),
    ]))
      fail(problem);
    for (const problem of alignmentProblems(
      script,
      [...hypothesisFactTexts(hypothesis), ...(expected.facts ?? [])],
      "soft",
    ))
      warn(problem);
    // 느린 문장은 경고만 남기고 계획한 시간을 유지한다.
    script.voiceover.forEach((voice, index) => {
      const range = voice.fromCut >= 0 ? voiceCutRange(voice, script.cuts) : null;
      const first = range ? script.cuts[range[0]] : undefined;
      const lastCut = range ? script.cuts[range[1]] : undefined;
      if (!first || !lastCut) return;
      const seconds = lastCut.endSec - first.startSec;
      const chars = lineLength(voice.text);
      if (seconds > maxSentenceSec(chars))
        warn(
          `${index + 1}번째 문장 "${voice.text}"(${chars}자)이 ${seconds}초에 걸쳐 느립니다(초당 ${NARRATION_MIN_CHARS_PER_SEC}자면 ${maxSentenceSec(chars)}초).`,
        );
    });
  }
  for (const problem of narrationProblems(script.voiceover, script.voicePersona)) fail(problem);
  const narration = script.cuts.reduce((sum, cut) => sum + lineLength(cut.narration), 0);
  if (narration < minChars || narration > maxChars)
    warn(
      `내레이션 총량이 ${narration}자입니다. ${script.durationSec}초 분량은 ${minChars}~${maxChars}자입니다.`,
    );
  if (!videoOfferAllowed(hypothesis) && script.cuts.some((cut) => cut.purpose === "offer"))
    fail("오퍼 장면은 오퍼 자료가 있는 BOFU 광고안에서만 씁니다(이 광고안은 offer 금지).");
  if (script.veoClips.length > VEO_SHOTS_MAX)
    fail(
      `Veo 클립은 영상 1편에 ${VEO_SHOTS_MAX}개까지입니다. 움직임이 설득력인 실사 컷에만 쓰고 나머지는 정지 이미지로 바꾸세요.`,
    );
  if (script.stills.length > STILL_SHOTS_MAX)
    fail(`정지 이미지는 영상 1편에 ${STILL_SHOTS_MAX}장까지입니다.`);
  for (const [kind, ids] of [
    ["Veo 클립", script.veoClips.map((clip) => clip.id)],
    ["정지 이미지", script.stills.map((still) => still.id)],
  ] as const)
    if (new Set(ids).size !== ids.length) fail(`${kind} ID가 중복 선언됐습니다.`);
  if ((script.veoClips.length > 0 || script.stills.length > 0) && !script.styleAnchor)
    fail("시작 이미지·정지 이미지들이 공유할 시각 기준(styleAnchor)이 없습니다.");
  // 클립 하나는 8초뿐이다. 그보다 많이 잘라 쓰면 같은 화면이 반복된다(같은 원본의 총 사용 시간).
  for (const clip of script.veoClips) {
    const usedMs = script.cuts
      .filter((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    if (usedMs === 0) warn(`선언한 Veo 클립 ${clip.id}를 쓰는 컷이 없습니다.`);
    if (usedMs > VEO_CLIP_SEC * 1000)
      fail(
        `Veo 클립 ${clip.id}에서 ${usedMs / 1000}초를 잘라 씁니다. 한 클립은 ${VEO_CLIP_SEC}초뿐이니 장면이 바뀌면 새 클립을 선언하거나, 그 위의 문장을 줄이세요.`,
      );
  }
  for (const still of script.stills) {
    const usedMs = script.cuts
      .filter((cut) => cut.source === "still_image" && cut.stillId === still.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    if (usedMs === 0) warn(`선언한 정지 이미지 ${still.id}를 쓰는 컷이 없습니다.`);
    if (usedMs > STILL_MAX_SEC * 1000)
      warn(
        `정지 이미지 ${still.id}을 총 ${usedMs / 1000}초 사용합니다. 정지 화면의 유지 시간과 반복 노출을 기획 검토에 참고하세요.`,
      );
  }
  const veoMs = script.cuts
    .filter((cut) => cut.source === "veo_clip")
    .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
  if (veoMs > Math.round(script.durationSec * 1000) * VEO_MAX_RATIO)
    fail(
      `Veo 클립 컷이 ${veoMs / 1000}초로 전체의 ${Math.round(VEO_MAX_RATIO * 100)}%를 넘습니다. 움직임이 필요 없는 분위기·상황·장소 컷은 정지 이미지(still_image)로 바꾸세요.`,
    );
  const graphicMs = script.cuts
    .filter((cut) => cut.source === "motion_graphic")
    .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
  if (graphicMs > Math.round(script.durationSec * 1000) * MOTION_GRAPHIC_MAX_RATIO)
    fail(
      `모션그래픽이 ${graphicMs / 1000}초로 전체의 ${Math.round(MOTION_GRAPHIC_MAX_RATIO * 100)}%를 넘습니다. 실사 장면(Veo 클립) 또는 정지 이미지로 바꾸세요.`,
    );
  return { hard, soft };
}
