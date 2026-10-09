import { explanationLabels, explanationPrompt } from "./explanation-prompt";
import { type FlowTexts, fillTemplate } from "./flow-texts";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { clipPlanParagraph } from "./veo-prompt";
import {
  type ExplainerEmphasis,
  type ExplainerObject,
  type InfoClip,
  isClipPlanEmpty,
  isExplainerScene,
  type Subject,
} from "./video-script";

// --- 설명 컷 프롬프트 조립(순수 함수) ---------------------------------------------------------------------
// 2026-10-07(지시 파일 분리): 고정 문장은 모두 instructions/flow.md 의 절이고 이 파일은 그 글(texts)을 인자로 받아
// 순서·공백·번호만 붙인다. 서버는 로더로 texts 를 채우고(server/flow-instructions.ts), 화면은 서버가 조립한 결과
// (flow-export JSON·/api/jobs/:id/videos/:n/flow-export)를 받는다. 절의 글을 바꾸면 다음 생성부터 반영된다.
//
// 혼합형 설명 세계(hybrid_explainer_v1, 2026-10-07, H5·레퍼런스 R1~R9): 설명 세계의 프롬프트는 실사 기준(styleAnchor)이 아니라
// 설명 세계 기준(explainerAnchor)을 쓴다. 모든 컷은 물체가 있는 3D 장면이고(R1) 글자는 앱 자막 한 줄뿐이라 이름표·지시선·수치 박스를
// 넣지 않으며(R2), 강조는 네 가지만 장면 속 물체에 붙는다(R3). "사람·제품·사진 금지" 문구는 설명 세계에만 두고 실사 프롬프트에는 넣지 않는다(H3).
export type ExplainerContext = {
  readonly explainerAnchor: string;
  // 대본 subjects: objects 의 subjectId 를 외형(traits)으로 풀어 쓴다.
  readonly subjects: readonly Subject[];
};
const EMPTY_EXPLAINER: ExplainerContext = { explainerAnchor: "", subjects: [] };
export type InfoPromptOptions = {
  readonly immersive?: boolean;
  readonly explainer?: ExplainerContext;
};
const numbered = (lines: readonly string[]) => lines.map((line, index) => `${index + 1}) ${line}`);
// 화면 표시·번들용 한국어 라벨(값은 shared/video-script.ts 의 enum 과 같다).
export const EXPLAINER_SCENE_LABELS = {
  process: "과정",
  comparison: "비교",
  analogy: "비유",
} as const;
export const EXPLAINER_COLOR_LABELS = {
  accent1: "강조색 1",
  accent2: "강조색 2",
  neutral: "중립(클레이·화이트)",
} as const;
export const EXPLAINER_EMPHASIS_LABELS = {
  color_code: "색 구분",
  outline: "빨간 외곽선",
  glow_line: "흰 발광선",
  ghost_object: "반투명 비유 물체",
} as const;
// 색 이름(EXPLAINER_COLOR_ACCENT1/ACCENT2/NEUTRAL 절).
function colorWord(color: ExplainerObject["color"], texts: FlowTexts): string {
  switch (color) {
    case "accent1":
      return texts.EXPLAINER_COLOR_ACCENT1;
    case "accent2":
      return texts.EXPLAINER_COLOR_ACCENT2;
    default:
      return texts.EXPLAINER_COLOR_NEUTRAL;
  }
}
const traitsOf = (subjectId: string, subjects: readonly Subject[]) =>
  subjects.find((subject) => subject.id === subjectId)?.traits ?? "";
// 물체 한 줄: "capsule — clay-white translucent capsule shell — in the first brand accent color". ID 는 참조용이지 글자가 아니다.
function objectLine(
  object: ExplainerObject,
  subjects: readonly Subject[],
  color: ExplainerObject["color"],
  texts: FlowTexts,
): string {
  const traits = traitsOf(object.subjectId, subjects);
  return `${object.subjectId}${traits ? ` — ${traits}` : ""} — in ${colorWord(color, texts)}`;
}
// color_code 강조의 대상은 CLEAN 에서 아직 중립이고 강조가 나타날 때 제 색으로 물든다(R3: 색 구분은 그 뒤 영상 끝까지 고정).
const colorCoded = (clip: Pick<InfoClip, "emphasis">, subjectId: string) =>
  clip.emphasis.some((item) => item.kind === "color_code" && item.target === subjectId);
function cleanColor(clip: Pick<InfoClip, "emphasis">, object: ExplainerObject) {
  return colorCoded(clip, object.subjectId) ? "neutral" : object.color;
}
// 강조 한 건을 물체에 붙는 묘사로(네 가지뿐, 평면 그래픽 없음). 문장은 EMPHASIS_* 절, {{name}}·{{color}} 를 채운다.
function emphasisText(
  item: ExplainerEmphasis,
  clip: Pick<InfoClip, "objects">,
  subjects: readonly Subject[],
  texts: FlowTexts,
): string {
  const traits = traitsOf(item.target, subjects);
  const name = `${item.target}${traits ? ` (${traits})` : ""}`;
  const color = clip.objects.find((object) => object.subjectId === item.target)?.color ?? "neutral";
  switch (item.kind) {
    case "color_code":
      return fillTemplate(texts.EMPHASIS_COLOR_CODE, { name, color: colorWord(color, texts) });
    case "outline":
      return fillTemplate(texts.EMPHASIS_OUTLINE, { name });
    case "glow_line":
      return fillTemplate(texts.EMPHASIS_GLOW_LINE, { name });
    default:
      return fillTemplate(texts.EMPHASIS_GHOST_OBJECT, { name });
  }
}
// "after action N, …" 목록(동작 순서대로 정렬). 강조가 없으면 그 사실을 적는다.
function emphasisLines(
  clip: Pick<InfoClip, "objects" | "emphasis">,
  subjects: readonly Subject[],
  texts: FlowTexts,
): string[] {
  const sorted = [...clip.emphasis].sort((left, right) => left.afterAction - right.afterAction);
  return sorted.map(
    (item, index) =>
      `${index + 1}) after action ${item.afterAction + 1}, ${emphasisText(item, clip, subjects, texts)}`,
  );
}
const actionLines = (clip: Pick<InfoClip, "actions">) => numbered(clip.actions);

export function hybridCleanPrompt(
  clip: InfoClip,
  explainer: ExplainerContext,
  texts: FlowTexts,
): string {
  const objects = clip.objects.map(
    (object, index) =>
      `${index + 1}) ${objectLine(object, explainer.subjects, cleanColor(clip, object), texts)}`,
  );
  return [
    explainer.explainerAnchor,
    clip.cleanPrompt,
    objects.length > 0
      ? fillTemplate(texts.HYBRID_CLEAN_OBJECTS, { objects: objects.join(" ") })
      : "",
    texts.HYBRID_CLEAN_START_STATE,
    texts.EXPLAINER_WORLD,
    texts.EXPLAINER_TEXT_RULE,
    texts.VERTICAL_FRAME,
  ]
    .filter(Boolean)
    .join(" ");
}

// 설명 세계 기준 한 줄: 강조색 두 개의 이름은 explainerAnchor 에만 있으므로(R8) INFO·영상 프롬프트에도 같은 기준을 싣는다
// ("the first brand accent color" 가 가리키는 색을 CLEAN 이미지만으로는 알 수 없다 — color_code 대상은 CLEAN 에서 중립이다).
const anchorLine = (explainer: ExplainerContext, texts: FlowTexts) =>
  explainer.explainerAnchor
    ? fillTemplate(texts.HYBRID_ANCHOR_LINE, { explainerAnchor: explainer.explainerAnchor })
    : "";

function hfPromptValues(clip: InfoClip, explainer: ExplainerContext, texts: FlowTexts) {
  return {
    scene: [
      anchorLine(explainer, texts),
      clip.infoPrompt,
      ...clip.objects.map((object) => objectLine(object, explainer.subjects, object.color, texts)),
    ]
      .filter(Boolean)
      .join(" "),
    actions: clip.actions.join("; "),
    camera: isClipPlanEmpty(clip.plan) ? "" : clipPlanParagraph(clip.plan),
    veoGraphics: clip.labelLayer?.veoGraphics.join("; ") ?? "",
  };
}

export function hybridOverlayPrompt(
  clip: InfoClip,
  explainer: ExplainerContext,
  texts: FlowTexts,
): string {
  if (clip.labelLayer)
    return fillTemplate(texts.VEO_HF_INFO_IMAGE, hfPromptValues(clip, explainer, texts));
  const emphasis = emphasisLines(clip, explainer.subjects, texts);
  const infoLabels = numbered(clip.infoLines);
  return [
    texts.HYBRID_OVERLAY_BASE,
    anchorLine(explainer, texts),
    clip.infoPrompt,
    clip.actions.length > 0
      ? fillTemplate(texts.HYBRID_OVERLAY_ACTIONS, { actions: actionLines(clip).join(" ") })
      : "",
    emphasis.length > 0
      ? fillTemplate(texts.HYBRID_OVERLAY_EMPHASIS, { emphasis: emphasis.join(" ") })
      : texts.HYBRID_OVERLAY_NO_EMPHASIS,
    // 2026-10-08(사용자 결정): INFO 문구(infoLines)가 있는 설명 장면은 튜토리얼식 인포그래픽(굵은 화살표·치수선·링·한글 라벨·숫자)을
    // 그리고 글자는 지정 문구만 쓴다. 예전 혼합형 설명 장면(infoLines [])은 평면 그래픽·글자 금지 그대로(골든 hybrid-overlay-notext).
    ...(infoLabels.length > 0
      ? [
          texts.HYBRID_OVERLAY_INFOGRAPHIC,
          fillTemplate(texts.HYBRID_OVERLAY_LABELS, { infoLines: infoLabels.join(" ") }),
          texts.EXPLAINER_WORLD,
        ]
      : [texts.HYBRID_OVERLAY_NO_FLAT, texts.EXPLAINER_WORLD, texts.EXPLAINER_TEXT_RULE]),
    texts.VERTICAL_FRAME,
  ]
    .filter(Boolean)
    .join("\n");
}

export function hybridMotionPrompt(
  clip: InfoClip,
  explainer: ExplainerContext,
  texts: FlowTexts,
): string {
  if (clip.labelLayer)
    return fillTemplate(texts.VEO_HF_MOTION, hfPromptValues(clip, explainer, texts));
  const emphasis = emphasisLines(clip, explainer.subjects, texts);
  const infoLabels = numbered(clip.infoLines);
  return [
    texts.HYBRID_MOTION_OPENING,
    anchorLine(explainer, texts),
    isClipPlanEmpty(clip.plan) ? "" : clipPlanParagraph(clip.plan),
    clip.actions.length > 0
      ? fillTemplate(texts.HYBRID_MOTION_ACTIONS, { actions: actionLines(clip).join(" ") })
      : "",
    emphasis.length > 0
      ? fillTemplate(texts.HYBRID_MOTION_EMPHASIS, { emphasis: emphasis.join(" ") })
      : texts.HYBRID_MOTION_NO_EMPHASIS,
    texts.HYBRID_MOTION_CAMERA,
    texts.EXPLAINER_WORLD,
    // HYBRID_MOTION_TEXT 절은 끝에 {{@EXPLAINER_TEXT_RULE}} 를 포함한다(로더가 끼운다). INFO 문구가 있으면 라벨 등장 규칙으로 바꾼다.
    infoLabels.length > 0
      ? fillTemplate(texts.HYBRID_MOTION_LABELS, { infoLines: infoLabels.join(" ") })
      : texts.HYBRID_MOTION_TEXT,
    texts.HYBRID_MOTION_LENGTH,
  ]
    .filter(Boolean)
    .join("\n");
}

// 완성 라벨 지시(IMMERSIVE_INFO_LABELS 절, {{labels}} = JSON 배열) 또는 글자 금지(IMMERSIVE_TEXT_RULE 절).
const infoLabelsRule = (clip: InfoClip, texts: FlowTexts): string =>
  clip.explanation && explanationLabels(clip.explanation).length > 0
    ? fillTemplate(texts.IMMERSIVE_INFO_LABELS, {
        labels: JSON.stringify(explanationLabels(clip.explanation)),
      })
    : texts.IMMERSIVE_TEXT_RULE;

export function immersiveCleanPrompt(
  clip: InfoClip,
  styleAnchor: string,
  texts: FlowTexts,
): string {
  return [
    styleAnchor,
    clip.cleanPrompt,
    explanationPrompt(clip.explanation, texts.EXPLANATION_CONTRACT_INTRO),
    texts.IMMERSIVE_CLEAN_DIMENSIONAL,
    texts.IMMERSIVE_CLEAN_ESTABLISH,
    texts.IMMERSIVE_CLEAN_FORM,
    texts.IMMERSIVE_PALETTE,
    texts.IMMERSIVE_BAND,
    texts.CLEAN_KEYFRAME_TAIL,
  ]
    .filter(Boolean)
    .join(" ");
}

export function immersiveOverlayPrompt(clip: InfoClip, texts: FlowTexts): string {
  return [
    texts.IMMERSIVE_OVERLAY_BASE,
    clip.infoPrompt,
    explanationPrompt(clip.explanation, texts.EXPLANATION_CONTRACT_INTRO),
    fillTemplate(texts.IMMERSIVE_OVERLAY_CAMERA, { camera: clip.plan.late.camera }),
    texts.IMMERSIVE_OVERLAY_STATE_INTRO,
    ...numbered(clip.graphicOrder),
    texts.IMMERSIVE_OVERLAY_RELATION,
    texts.IMMERSIVE_OVERLAY_IDENTITY,
    texts.IMMERSIVE_PALETTE,
    texts.IMMERSIVE_BAND,
    infoLabelsRule(clip, texts),
  ].join("\n");
}

export function immersiveMotionPrompt(clip: InfoClip, texts: FlowTexts): string {
  return [
    texts.IMMERSIVE_MOTION_OPENING,
    clipPlanParagraph(clip.plan),
    explanationPrompt(clip.explanation, texts.EXPLANATION_CONTRACT_INTRO),
    fillTemplate(texts.IMMERSIVE_MOTION_STAGES, { stages: numbered(clip.graphicOrder).join(" ") }),
    texts.IMMERSIVE_MOTION_OBJECTS,
    texts.IMMERSIVE_MOTION_PRESERVE,
    texts.IMMERSIVE_MOTION_BEATS,
    texts.IMMERSIVE_PALETTE,
    texts.IMMERSIVE_BAND,
    clip.explanation && explanationLabels(clip.explanation).length > 0
      ? fillTemplate(texts.IMMERSIVE_MOTION_LABELS, {
          labels: JSON.stringify(explanationLabels(clip.explanation)),
        })
      : texts.IMMERSIVE_TEXT_RULE,
    texts.IMMERSIVE_MOTION_LENGTH,
  ].join("\n");
}

// 설명 설계가 있는 컷은 완성 INFO 이미지의 라벨을 검증한다. 이전 R4 컷은 글자 없이,
// 그보다 오래된 infoLines 전용 컷은 지정 문구 대조 방식으로 계속 읽는다.
// 프롬프트(여기)·업로드 글자 검사(server/flow-import.ts)·화면(src/FlowInfoClips.tsx)이 같은 기준을 쓴다.
export function infoClipExpectsText(
  clip: Pick<InfoClip, "infoLines" | "graphicOrder" | "explanation" | "labelLayer">,
): boolean {
  if (clip.labelLayer) return false;
  if (clip.explanation) return explanationLabels(clip.explanation).length > 0;
  return clip.graphicOrder.length === 0 && clip.infoLines.length > 0;
}
export function infoTextLines(clip: Pick<InfoClip, "infoLines" | "explanation">): string[] {
  return clip.explanation ? explanationLabels(clip.explanation) : clip.infoLines;
}
// INFO 그래픽을 두는 중간 띠(위에서부터 높이 %)의 기본값. 실측(2026-10-06): 위·아래에 놓인 그래픽을 앱의 고정 제목·자막이 가렸다.
// 프롬프트 문장은 flow.md 절이 {{INFO_GRAPHIC_BAND_TOP}}·{{INFO_GRAPHIC_BAND_BOTTOM}} 토큰(thresholds.json)으로 적는다.
export const INFO_GRAPHIC_BAND = {
  top: DEFAULT_THRESHOLDS.INFO_GRAPHIC_BAND_TOP,
  bottom: DEFAULT_THRESHOLDS.INFO_GRAPHIC_BAND_BOTTOM,
} as const;

export function infoCleanPrompt(
  clip: InfoClip,
  styleAnchor: string,
  texts: FlowTexts,
  options: InfoPromptOptions = {},
): string {
  const explainer = options.explainer ?? EMPTY_EXPLAINER;
  // 혼합형 설명 장면(sceneType 있음)은 실사 기준(styleAnchor)·참조 사진 없이 설명 세계 기준만 쓴다.
  if (isExplainerScene(clip)) return hybridCleanPrompt(clip, explainer, texts);
  if (options.immersive || clip.explanation) return immersiveCleanPrompt(clip, styleAnchor, texts);
  return [
    styleAnchor,
    clip.cleanPrompt,
    texts.INFO_CLEAN_REFERENCE,
    texts.INFO_CLEAN_FORMAT,
    // R3: 글자·화살표·수치·라벨·아이콘·강조 링 없이, 뒤에 그래픽이 놓일 빈 공간을 남긴다.
    texts.CLEAN_KEYFRAME_TAIL,
  ]
    .filter(Boolean)
    .join(" ");
}
// INFO 이미지 프롬프트(R4): 글자·숫자·라벨 없음(글자는 앱이 그린다), 크고 굵고 발광하는 그래픽을 원근에 맞춰 대상 앞·뒤·표면에,
// 정확한 대상을 가리키고 얼굴·제품을 가리지 않게, 원본 구도 유지, 중간 띠, 브랜드에 맞는 강조색 2~3개, 근거 없는 요소 금지.
export function infoOverlayPrompt(
  clip: InfoClip,
  texts: FlowTexts,
  options: InfoPromptOptions = {},
): string {
  const explainer = options.explainer ?? EMPTY_EXPLAINER;
  if (isExplainerScene(clip)) return hybridOverlayPrompt(clip, explainer, texts);
  if (options.immersive || clip.explanation) return immersiveOverlayPrompt(clip, texts);
  if (infoClipExpectsText(clip)) return legacyInfoOverlayPrompt(clip, texts);
  return [
    texts.INFO_OVERLAY_BASE,
    clip.infoPrompt,
    ...(clip.graphicOrder.length > 0
      ? [texts.INFO_OVERLAY_ORDER_INTRO, ...numbered(clip.graphicOrder)]
      : []),
    texts.INFO_OVERLAY_NO_TEXT,
    texts.INFO_OVERLAY_STYLE,
    texts.INFO_OVERLAY_BAND,
    texts.INFO_OVERLAY_COLORS,
  ].join("\n");
}
// 예전 설명 컷(infoLines 로 글자 대조, 2026-10-05)의 INFO 프롬프트. 저장된 대본과의 호환을 위해 바꾸지 않는다.
function legacyInfoOverlayPrompt(clip: InfoClip, texts: FlowTexts): string {
  return [
    texts.INFO_LINES_BASE,
    clip.infoPrompt,
    texts.INFO_LINES_INTRO,
    ...numbered(clip.infoLines),
    texts.INFO_LINES_STYLE,
    texts.INFO_LINES_BAND,
  ].join("\n");
}
// 전환 영상 프롬프트(R5): 세 구간 계획 + graphicOrder 순서로 그래픽이 생김 + 마지막 프레임 = INFO 이미지 + 어느 순간에도 글자 없음
// + 단순 페이드·정지 줌 금지. 계획이 없는 예전 설명 컷은 저장된 motionPrompt 와 예전 문장을 그대로 쓴다.
export function infoMotionPrompt(
  clip: InfoClip,
  texts: FlowTexts,
  options: InfoPromptOptions = {},
): string {
  const explainer = options.explainer ?? EMPTY_EXPLAINER;
  if (isExplainerScene(clip)) return hybridMotionPrompt(clip, explainer, texts);
  if (options.immersive || clip.explanation) return immersiveMotionPrompt(clip, texts);
  if (isClipPlanEmpty(clip.plan)) return `${clip.motionPrompt} ${texts.INFO_MOTION_LEGACY_TAIL}`;
  return [
    texts.INFO_MOTION_OPENING,
    clipPlanParagraph(clip.plan),
    clip.graphicOrder.length > 0
      ? fillTemplate(texts.INFO_MOTION_ORDER, { order: numbered(clip.graphicOrder).join(" ") })
      : "",
    texts.INFO_MOTION_CAMERA,
    texts.INFO_MOTION_TEXT,
  ]
    .filter(Boolean)
    .join("\n");
}
