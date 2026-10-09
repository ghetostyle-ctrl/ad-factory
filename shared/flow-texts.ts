// Flow·Veo·이미지 프롬프트의 고정 문장은 instructions/flow.md 의 절이다(사용자 결정 2026-10-07).
// shared 의 조립 함수(veo-prompt·flow-info-prompts·flow-mode·explanation-prompt)는 이 글을 인자로만 받고 본문을 갖지 않는다.
// 서버는 로더가 읽은 절로 FlowTexts 를 만들고(server/flow-instructions.ts flowTexts), 화면은 서버가 조립한 결과
// (flow-export JSON·GET /api/jobs/:id/videos/:n/flow-export)를 받는다. 키 이름은 flow.md 의 `## KEY` 머리글과 같다.
export const FLOW_TEXT_KEYS = [
  // shared/veo-prompt.ts
  "CLEAN_KEYFRAME_TAIL",
  "CLIP_PLAN_TAIL",
  "CLIP_LEGACY_TAIL",
  "HYBRID_LIVE_TAIL",
  // shared/flow-info-prompts.ts — 혼합형 설명 세계
  "EXPLAINER_WORLD",
  "EXPLAINER_TEXT_RULE",
  "EXPLAINER_COLOR_ACCENT1",
  "EXPLAINER_COLOR_ACCENT2",
  "EXPLAINER_COLOR_NEUTRAL",
  "EMPHASIS_COLOR_CODE",
  "EMPHASIS_OUTLINE",
  "EMPHASIS_GLOW_LINE",
  "EMPHASIS_GHOST_OBJECT",
  "HYBRID_CLEAN_OBJECTS",
  "HYBRID_CLEAN_START_STATE",
  "HYBRID_ANCHOR_LINE",
  "VEO_HF_INFO_IMAGE",
  "VEO_HF_MOTION",
  "HF_LABEL_LAYER_RULES",
  "FLOW_INFO_CHECKLIST_HF",
  "HYBRID_OVERLAY_BASE",
  "HYBRID_OVERLAY_ACTIONS",
  "HYBRID_OVERLAY_EMPHASIS",
  "HYBRID_OVERLAY_NO_EMPHASIS",
  "HYBRID_OVERLAY_NO_FLAT",
  "HYBRID_OVERLAY_INFOGRAPHIC",
  "HYBRID_OVERLAY_LABELS",
  "HYBRID_MOTION_OPENING",
  "HYBRID_MOTION_ACTIONS",
  "HYBRID_MOTION_EMPHASIS",
  "HYBRID_MOTION_NO_EMPHASIS",
  "HYBRID_MOTION_CAMERA",
  "HYBRID_MOTION_TEXT",
  "HYBRID_MOTION_LABELS",
  "HYBRID_MOTION_LENGTH",
  "VERTICAL_FRAME",
  // immersive(입체 설명)
  "IMMERSIVE_PALETTE",
  "IMMERSIVE_TEXT_RULE",
  "IMMERSIVE_BAND",
  "IMMERSIVE_INFO_LABELS",
  "IMMERSIVE_CLEAN_DIMENSIONAL",
  "IMMERSIVE_CLEAN_ESTABLISH",
  "IMMERSIVE_CLEAN_FORM",
  "IMMERSIVE_OVERLAY_BASE",
  "IMMERSIVE_OVERLAY_CAMERA",
  "IMMERSIVE_OVERLAY_STATE_INTRO",
  "IMMERSIVE_OVERLAY_RELATION",
  "IMMERSIVE_OVERLAY_IDENTITY",
  "IMMERSIVE_MOTION_OPENING",
  "IMMERSIVE_MOTION_STAGES",
  "IMMERSIVE_MOTION_OBJECTS",
  "IMMERSIVE_MOTION_PRESERVE",
  "IMMERSIVE_MOTION_BEATS",
  "IMMERSIVE_MOTION_LABELS",
  "IMMERSIVE_MOTION_LENGTH",
  "EXPLANATION_CONTRACT_INTRO",
  // 예전 설명 컷(R3·R4·R5·infoLines)
  "INFO_CLEAN_REFERENCE",
  "INFO_CLEAN_FORMAT",
  "INFO_OVERLAY_BASE",
  "INFO_OVERLAY_ORDER_INTRO",
  "INFO_OVERLAY_NO_TEXT",
  "INFO_OVERLAY_STYLE",
  "INFO_OVERLAY_BAND",
  "INFO_OVERLAY_COLORS",
  "INFO_LINES_BASE",
  "INFO_LINES_INTRO",
  "INFO_LINES_STYLE",
  "INFO_LINES_BAND",
  "INFO_MOTION_LEGACY_TAIL",
  "INFO_MOTION_OPENING",
  "INFO_MOTION_ORDER",
  "INFO_MOTION_CAMERA",
  "INFO_MOTION_TEXT",
  // 서버 이미지 프롬프트(시작·정지·참조·immersive 대표 이미지)
  "START_IMAGE_TAIL",
  "STILL_IMAGE_TAIL",
  "SCENE_IMAGE_REFERENCE_1",
  "SCENE_IMAGE_REFERENCE_2",
  "SCENE_IMAGE_REFERENCE_NONE",
  "SOURCE_IMAGE_IMMERSIVE_NOTE",
  // Flow 번들 체크리스트(한국어)
  "FLOW_CHECKLIST",
  "FLOW_INFO_CHECKLIST_NO_TEXT",
  "FLOW_INFO_CHECKLIST_LINES",
  "FLOW_INFO_CHECKLIST_EXPLAINER",
  "FLOW_HYBRID_EYE_CHECK",
] as const;
export type FlowTextKey = (typeof FLOW_TEXT_KEYS)[number];
export type FlowTexts = Readonly<Record<FlowTextKey, string>>;

const TOKEN = /\{\{([A-Za-z@][A-Za-z0-9_]*)\}\}/gu;
// 호출 시점 토큰(`{{name}}`, 소문자)을 채운다. 값 안의 `{{…}}` 는 다시 읽지 않는다(한 번만 훑는다).
// 채우지 못한 토큰이 남으면 오류 — 지시 파일이 코드가 모르는 토큰을 쓴 경우이며, 로더가 미리 걸러 둔다.
export function fillTemplate(
  text: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  const missing: string[] = [];
  const filled = text.replace(TOKEN, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    return String(value);
  });
  if (missing.length > 0)
    throw new Error(`채우지 못한 토큰: ${[...new Set(missing)].map((n) => `{{${n}}}`).join(", ")}`);
  return filled;
}
