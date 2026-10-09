import type { FlowTexts } from "./flow-texts";
import {
  CLIP_PHASE_RANGES_MS,
  CLIP_PHASES,
  type ClipPhaseId,
  type ClipPlan,
  isClipPlanEmpty,
  type VeoClip,
} from "./video-script";

// Veo(API 모드)와 Google Flow(웹 모드)가 같은 프롬프트를 쓰도록 한 곳에 둔다.
// 2026-10-06(장면 계획 R3·R5): 구간 계획(plan)이 있는 클립은 "첫 줄 + 세 구간 문단 + 고정 꼬리"로, 계획이 없는 예전 대본은
// 예전 문장 그대로 만든다(저장된 대본의 프롬프트가 바뀌지 않도록).
// 2026-10-07(지시 파일 분리): 고정 문장(CLEAN_KEYFRAME_TAIL·CLIP_PLAN_TAIL·CLIP_LEGACY_TAIL·HYBRID_LIVE_TAIL)은
// instructions/flow.md 의 절이고 여기서는 인자(texts)로만 받는다. 서버가 로더로 채운다(server/flow-instructions.ts).

// R3 깨끗한 키프레임: 시작 이미지·CLEAN·정지 이미지에는 글자·자막·화살표·수치·라벨·아이콘·강조 링을 넣지 않고,
// 뒤에 앱(콜아웃)·INFO 그래픽이 놓일 빈 공간을 남긴다. 이미지 생성 프롬프트 끝에 꼬리(CLEAN_KEYFRAME_TAIL 절)를 붙인다.
export function cleanKeyframePrompt(prompt: string, tail: string): string {
  return `${prompt.trim()}\n${tail}`;
}

// 구간 표기("0–3s", "3–5.5s", "5.5–8s"). CLIP_PHASE_RANGES_MS 에서 계산하므로 범위를 바꾸면 같이 바뀐다.
export function phaseLabel(phase: ClipPhaseId): string {
  const [from, to] = CLIP_PHASE_RANGES_MS[phase];
  return `${from / 1000}–${to / 1000}s`;
}
// 계획 한 칸을 문장으로: 끝의 마침표·공백을 정리하고 마침표 하나로 끝낸다(빈 칸은 빈 문자열).
function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/u, "");
  return trimmed ? `${trimmed}.` : "";
}
// 세 구간 계획을 한 문단으로: "0–3s: <camera>. Scene: <action>. 3–5.5s: … 5.5–8s: …"
export function clipPlanParagraph(plan: ClipPlan): string {
  return CLIP_PHASES.map((phase) => {
    const part = plan[phase];
    return `${phaseLabel(phase)}: ${sentence(part.camera)} Scene: ${sentence(part.action)}`;
  }).join(" ");
}

export type ClipPromptTexts = Pick<
  FlowTexts,
  "CLIP_PLAN_TAIL" | "CLIP_LEGACY_TAIL" | "HYBRID_LIVE_TAIL"
>;
// 계획이 있는 클립: 프롬프트 + 구간 문단 + 고정 꼬리(CLIP_PLAN_TAIL). 계획 없는 예전 대본: 프롬프트 + 예전 꼬리(CLIP_LEGACY_TAIL).
// 혼합형(2026-10-07, H3) 실사 클립 A~D 는 사람이 있는 실제 장소의 촬영 영상이어야 하므로 liveAction 이면 HYBRID_LIVE_TAIL 을 한 문장 더 붙인다.
export function clipPrompt(
  clip: Pick<VeoClip, "prompt"> & Partial<Pick<VeoClip, "plan">>,
  texts: ClipPromptTexts,
  options: { readonly liveAction?: boolean } = {},
): string {
  const plan = clip.plan;
  const live = options.liveAction ? ` ${texts.HYBRID_LIVE_TAIL}` : "";
  if (!plan || isClipPlanEmpty(plan)) return `${clip.prompt}\n${texts.CLIP_LEGACY_TAIL}${live}`;
  return `${clip.prompt}\n${clipPlanParagraph(plan)}\n${texts.CLIP_PLAN_TAIL}${live}`;
}
