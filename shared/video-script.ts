import { z } from "zod";
import {
  EXPLAINER_ACTIONS_MAX,
  EXPLAINER_EMPHASIS_MAX,
  EXPLAINER_OBJECTS_MAX,
  EXPLAINER_SCENE_TYPES,
  ExplainerEmphasisSchema,
  ExplainerObjectSchema,
  ExplainerSceneTypeSchema,
} from "./explainer-scene";
import { ExplanationPlanSchema } from "./explanation-plan";
import { ActionSyncSchema } from "./explanation-sync";
import { HfLabelPlanResponseSchema, HfLabelPlanSchema, hfLabelClipProblems } from "./hf-label-plan";
import { SCRIPT_CHAIN_STEPS } from "./persuasion-chain";
import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";
import { VideoPlanningSchema, type VisualPolicyId } from "./video-planning";

const line = z.string().trim().min(1).max(1200);

// 완성 영상 길이: 30초가 최소, 1분까지. 영상마다 이 범위에서 길이를 정한다(zod .max 에 묶인 코드 고정 값).
export const VIDEO_MIN_SEC = 30;
export const VIDEO_MAX_SEC = 60;
// 아래 숫자 중 DEFAULT_THRESHOLDS 에서 오는 것은 instructions/thresholds.json 으로 바꿀 수 있는 임계값의 기본값이다(분리 전 상수와 같은 값).
// 규칙 함수는 모듈 상수가 아니라 thresholds()(서버·화면이 주입한 지금 값)를 호출 때 읽는다 — shared/thresholds.ts.
// 한국어 쇼츠 레퍼런스 실측 범위(공백 포함). 목표 길이는 힌트이고 30~60초 전체를 허용한다.
// 실제 음성 길이는 합성 뒤 측정하며 글자 수 속도는 경고와 기획 안내에만 쓴다.
export const NARRATION_MIN_CHARS_PER_SEC = DEFAULT_THRESHOLDS.NARRATION_MIN_CHARS_PER_SEC;
export const NARRATION_MAX_CHARS_PER_SEC = DEFAULT_THRESHOLDS.NARRATION_MAX_CHARS_PER_SEC;
export const NARRATION_TARGET_CHARS_PER_SEC = DEFAULT_THRESHOLDS.NARRATION_TARGET_CHARS_PER_SEC;
export const SHOT_MIN_SEC = 0.5;
export const CAPTION_LINE_MAX_CHARS = DEFAULT_THRESHOLDS.CAPTION_LINE_MAX_CHARS;
// Veo 원본 클립: 하나가 8초. Veo 는 사람·손·제품 사용·전후 비교처럼 진짜 움직임이 설득력인 실사 컷에만 쓴다.
// 새 대본은 영상당 4개(A~D)까지. 예전에 저장된 대본은 8개(A~H)까지 읽는다(사용자 결정 2026-10-03).
export const VEO_SHOTS_MAX = 4;
export const VEO_STORED_SHOTS_MAX = 8;
export const VEO_CLIP_SEC = 8;
// Veo 컷 시간 합계가 영상 길이에서 차지할 수 있는 비율: 프롬프트는 약 45%를 권하고 검사는 50%에서 거부한다.
export const VEO_HINT_RATIO = DEFAULT_THRESHOLDS.VEO_HINT_RATIO;
export const VEO_MAX_RATIO = DEFAULT_THRESHOLDS.VEO_MAX_RATIO;
// AI 정지 이미지(분위기·상황·장소·사물 컷): 영상당 최대 14장.
// 같은 이미지를 컷마다 다른 창(크롭·줌·팬)으로 잘라 쓴다.
export const STILL_SHOTS_MAX = 14;
// 반복 노출 검토와 자동 그래픽 배경 재사용의 기준이며, 계획한 정지 이미지 컷의 시간 상한은 아니다.
export const STILL_MAX_SEC = DEFAULT_THRESHOLDS.STILL_MAX_SEC;
// 밀리초 단위 클립 길이. 타임라인·세그먼트 계산은 모두 ms로 한다.
export const VEO_CLIP_MS = VEO_CLIP_SEC * 1000;
// 모션그래픽(앱이 그리는 숫자·목록·비교 화면)은 영상 길이의 40%까지. 나머지는 실사 장면이어야 한다.
export const MOTION_GRAPHIC_MAX_RATIO = DEFAULT_THRESHOLDS.MOTION_GRAPHIC_MAX_RATIO;
// 설명 컷(CREATIVE-PLANNING-DESIGN.md 11절): CLEAN 사진 → 같은 사진에 인포그래픽·글자를 입힌 INFO 사진 →
// 두 장을 첫·마지막 프레임으로 Flow 에서 만든 전환 영상. 컷은 veo_clip 컷처럼 이 클립(I1~I3)을 읽는다.
export const INFO_CLIP_IDS = ["I1", "I2", "I3"] as const;
export const INFO_CLIPS_MAX = 3;
export type InfoClipId = (typeof INFO_CLIP_IDS)[number];
export function isInfoClipId(id: string): id is InfoClipId {
  return (INFO_CLIP_IDS as readonly string[]).includes(id);
}
export const VEO_CLIP_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", ...INFO_CLIP_IDS] as const;

// --- 장면 계획(2026-10-06, 사용자 3단계 프롬프트 R1~R8) ----------------------------------------------------------
// 컷은 기본 3~4초, 5초를 넘으면 거부한다(시각 정보가 바뀌는 지점에서 나누고 한 문장이 여러 컷에 걸쳐도 된다).
export const CUT_MAX_SEC = DEFAULT_THRESHOLDS.CUT_MAX_SEC;
// 컷마다 시청자가 이해해야 할 핵심 한 문장(한국어, 최대 40자).
export const CUT_GOAL_MAX_CHARS = 40;
// Flow 8초 클립의 세 구간: 같은 3D 공간에서 카메라가 이어서 움직이고 구간 끝마다 짧게 멈춘다(컷 경계가 깨끗하도록).
// veo_clip 컷은 이 중 하나(phase)를 읽고, 앱은 그 구간 안에서 클립 offset 을 잡는다(같은 구간의 여러 컷은 이어서 읽는다).
export const CLIP_PHASES = ["early", "mid", "late"] as const;
export type ClipPhaseId = (typeof CLIP_PHASES)[number];
export const ClipPhaseIdSchema = z.enum(CLIP_PHASES);
export const CLIP_PHASE_RANGES_MS: Record<ClipPhaseId, readonly [number, number]> = {
  early: [0, 3000],
  mid: [3000, 5500],
  late: [5500, 8000],
};
export function isClipPhaseId(value: string): value is ClipPhaseId {
  return (CLIP_PHASES as readonly string[]).includes(value);
}
// 컷의 클립 구간. veo_clip 컷은 필수, 다른 소스는 "".
export const CutPhaseSchema = z.enum(["", ...CLIP_PHASES]);
// 구간 계획 한 칸: camera = 시작 위치→이동 방향→접근 대상→끝 위치(영어 한 줄), action = 그 구간에서 피사체·환경이 실제로 하는 움직임.
// 저장본은 빈 문자열을 허용한다(계획이 없던 예전 대본의 기본값). 응답은 아래 ClipPhaseResponseSchema(min 1).
const planLine = z.string().trim().max(1200);
export const ClipPhaseSchema = z.strictObject({ camera: planLine, action: planLine });
export const ClipPlanSchema = z.strictObject({
  early: ClipPhaseSchema,
  mid: ClipPhaseSchema,
  late: ClipPhaseSchema,
});
export type ClipPlan = z.infer<typeof ClipPlanSchema>;
export const ClipPhaseResponseSchema = z.strictObject({ camera: line, action: line });
export const ClipPlanResponseSchema = z.strictObject({
  early: ClipPhaseResponseSchema,
  mid: ClipPhaseResponseSchema,
  late: ClipPhaseResponseSchema,
});
export function emptyClipPlan(): ClipPlan {
  return {
    early: { camera: "", action: "" },
    mid: { camera: "", action: "" },
    late: { camera: "", action: "" },
  };
}
export const EMPTY_CLIP_PLAN: Readonly<ClipPlan> = emptyClipPlan();
export function isClipPlanEmpty(plan: ClipPlan): boolean {
  return CLIP_PHASES.every((phase) => plan[phase].camera === "" && plan[phase].action === "");
}
// 비어 있는 칸 목록("mid.action" 형태). 계획이 통째로 비면 []·전부 채워져도 [].
export function clipPlanMissing(plan: ClipPlan): string[] {
  if (isClipPlanEmpty(plan)) return [];
  const missing: string[] = [];
  for (const phase of CLIP_PHASES) {
    if (plan[phase].camera === "") missing.push(`${phase}.camera`);
    if (plan[phase].action === "") missing.push(`${phase}.action`);
  }
  return missing;
}
// 계획을 한 문단 영어로(설명 컷의 veoPrompt 대체 문구·화면 표시용). 빈 계획은 "".
export function clipPlanText(plan: ClipPlan): string {
  if (isClipPlanEmpty(plan)) return "";
  return CLIP_PHASES.map((phase) => {
    const [from, to] = CLIP_PHASE_RANGES_MS[phase];
    const part = plan[phase];
    return `${phase} (${from / 1000}-${to / 1000}s): camera ${part.camera}; action ${part.action}`;
  }).join(" ");
}
// 대상 ID(R2): 영상에 나오는 인물·제품마다 id 와 외형 한 줄(영어). 모든 이미지 프롬프트가 등장 대상의 traits 를 자체 포함해야 한다.
export const SUBJECTS_MAX = 4;
export const SubjectSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{1,12}$/, "영문 소문자·숫자 1~12자"),
  traits: line,
});
export type Subject = z.infer<typeof SubjectSchema>;
// traits 의 핵심 낱말: 공백으로 자른 토큰에서 앞뒤 문장부호를 떼고 4자 이상인 것(소문자).
export const SUBJECT_KEY_WORD_MIN_CHARS = DEFAULT_THRESHOLDS.SUBJECT_KEY_WORD_MIN_CHARS;
export function subjectKeyWords(traits: string): string[] {
  const minChars = thresholds().SUBJECT_KEY_WORD_MIN_CHARS;
  const words = traits
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => [...token].length >= minChars);
  return [...new Set(words)];
}
// 프롬프트가 대상을 어떻게 가리키는가: id 를 낱말로 언급하는지, traits 의 핵심 낱말을 하나라도 담는지.
export function promptSubjectMention(
  prompt: string,
  subject: Subject,
): { readonly id: boolean; readonly traits: boolean } {
  const body = prompt.toLowerCase();
  const id = new RegExp(`(?<![a-z0-9])${subject.id}(?![a-z0-9])`, "u").test(body);
  const traits = subjectKeyWords(subject.traits).some((word) => body.includes(word));
  return { id, traits };
}
// 콜아웃(R7): 문장 안의 어절(word)이 발음되는 시각에 그 글자(text)를 그려 컷 끝까지 유지한다. 문장당 최대 3개.
// text 는 한국어·숫자 1~16자(영문 금지, 단위는 한글: 밀리그램·퍼센트). text 의 숫자는 그 문장이 말해야 한다.
export const CALLOUTS_MAX = 3;
export const CalloutKindSchema = z.enum(["label", "ring", "arrow", "check"]);
export const CalloutAnchorSchema = z.enum(["subject", "left", "right", "top", "bottom"]);
export const CalloutSchema = z.strictObject({
  word: z.string().trim().min(1).max(20),
  text: z.string().trim().min(1).max(16),
  kind: CalloutKindSchema,
  anchor: CalloutAnchorSchema,
  targetId: z.string().trim().min(1).max(40).nullable().optional(),
});
export type Callout = z.infer<typeof CalloutSchema>;
export const CalloutResponseSchema = CalloutSchema.extend({
  targetId: z.string().trim().min(1).max(40).nullable(),
});
// 콜아웃 word 가 문장의 어절(공백으로 자른 토큰 또는 그 토큰의 문장부호 제거형)과 일치하는가.
export function calloutWordInText(word: string, text: string): boolean {
  const strip = (token: string) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => token === word || strip(token) === word);
}
// 콜아웃 word 의 어절 번호(0부터, 공백 기준). 없으면 -1. 렌더가 음성 단어 시각을 찾을 때 쓴다.
export function calloutWordIndex(word: string, text: string): number {
  const strip = (token: string) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .findIndex((token) => token === word || strip(token) === word);
}
// 클립 구간 읽기 계획(R6): 같은 클립·같은 구간의 컷은 구간 시작부터 이어서 읽는다. 구간 끝을 넘으면 이웃 구간으로 이어 읽고(경고),
// 클립 끝(8초)을 넘으면 거부한다. 렌더 타임라인의 offset 계산과 규칙 검사가 같은 함수를 쓴다. phase 가 없는 컷(예전 대본)은 빠진다.
export type ClipPhaseRead = {
  readonly index: number;
  readonly clipId: string;
  readonly phase: ClipPhaseId;
  readonly offsetMs: number;
  readonly endMs: number;
  // 이 구간의 끝(ms). endMs 가 이보다 크면 이웃 구간으로 이어 읽는다.
  readonly phaseEndMs: number;
};
export function clipPhaseReads(
  cuts: readonly {
    readonly source: string;
    readonly veoClip: string;
    readonly phase: string;
    readonly startSec: number;
    readonly endSec: number;
  }[],
): ClipPhaseRead[] {
  const cursor = new Map<string, number>();
  const reads: ClipPhaseRead[] = [];
  cuts.forEach((cut, index) => {
    if (cut.source !== "veo_clip" || cut.veoClip === "" || !isClipPhaseId(cut.phase)) return;
    const [phaseStart, phaseEnd] = CLIP_PHASE_RANGES_MS[cut.phase];
    const key = `${cut.veoClip}:${cut.phase}`;
    const offsetMs = cursor.get(key) ?? phaseStart;
    const endMs = offsetMs + Math.round(cut.endSec * 1000) - Math.round(cut.startSec * 1000);
    cursor.set(key, endMs);
    reads.push({
      index,
      clipId: cut.veoClip,
      phase: cut.phase,
      offsetMs,
      endMs,
      phaseEndMs: phaseEnd,
    });
  });
  return reads;
}
// 새 대본(모델 응답)이 쓸 수 있는 Veo 클립 ID. 저장본은 A~H 를 모두 받는다.
export const VEO_RESPONSE_CLIP_IDS = ["A", "B", "C", "D"] as const;
const RESPONSE_CUT_CLIP_IDS = ["", ...VEO_RESPONSE_CLIP_IDS, ...INFO_CLIP_IDS] as const;
export const STILL_IDS = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14",
] as const;

// 7단 흐름(후킹→페인→스토리·원인→메커니즘(USP)→신뢰→혜택→행동 유도). problem·solution 은 예전 8초 대본 호환용.
const PurposeSchema = z.enum([
  "hook",
  "pain",
  "story",
  "mechanism",
  "proof",
  "offer",
  "cta",
  "rehook",
  "problem",
  "solution",
]);
// 새로 쓰는 대본에는 예전 8초용 problem·solution 을 쓰지 않는다.
const ResponsePurposeSchema = PurposeSchema.exclude(["problem", "solution"]);
// 화면 소스. motion_graphic 은 앱이 직접 그리는 숫자·체크리스트·비교·질문 화면(무료).
// still_image 는 AI 가 만든 사진풍 정지 이미지를 카메라 무브로 보여 주는 컷(분위기·상황·장소·사물).
const SourceSchema = z.enum([
  "approved_image",
  "card_slide",
  "veo_clip",
  "project_clip",
  "motion_graphic",
  "still_image",
]);
export const GraphicKindSchema = z.enum([
  "",
  "number",
  "checklist",
  "compare",
  "question",
  "callout",
]);
const VeoClipIdSchema = z.enum(VEO_CLIP_IDS);
export const StillIdSchema = z.enum(STILL_IDS);
// 컷 전환·화면 효과. hard_cut 외의 효과가 시선을 다시 잡는 패턴 브레이크다.
export const CutEffectSchema = z.enum([
  "hard_cut",
  "zoom_punch",
  "whip_pan",
  "text_pop",
  "split_screen",
  "speed_ramp",
  "shake",
  "freeze_frame",
]);

export const VideoCutResponseSchema = z.strictObject({
  startSec: z
    .number()
    .min(0)
    .max(VIDEO_MAX_SEC - SHOT_MIN_SEC),
  endSec: z.number().min(SHOT_MIN_SEC).max(VIDEO_MAX_SEC),
  purpose: ResponsePurposeSchema,
  screenComposition: line,
  onScreenText: z.string().trim().max(120),
  source: SourceSchema,
  effect: CutEffectSchema,
  // veo_clip 컷이 잘라 쓰는 클립(대본 앞에 선언한 A~D, 설명 컷은 I1~I3). 다른 소스는 빈 문자열.
  veoClip: z.enum(RESPONSE_CUT_CLIP_IDS),
  // still_image 컷이 쓰는 정지 이미지(대본 앞에 선언한 S1~S14). 다른 소스는 빈 문자열.
  stillId: z.enum(["", ...STILL_IDS]),
  // motion_graphic 컷의 종류와 화면 글줄(1~4줄). 다른 소스는 ""·[].
  graphicKind: GraphicKindSchema,
  graphicLines: z.array(z.string().trim().min(1).max(24)).max(4),
  // 장면 계획(2026-10-06): 컷의 핵심 한 문장과 veo_clip 컷이 읽는 클립 구간. 평면 형태·예전 대본은 기본값("").
  goal: z.string().trim().max(CUT_GOAL_MAX_CHARS).default(""),
  phase: CutPhaseSchema.default(""),
});
// 내레이션은 컷과 따로 쓴 음성 트랙(문장 단위)에서 문장이 시작하는 컷에 옮겨 담는다.
// Veo 프롬프트는 선언한 클립에서 컷마다 옮겨 담는다.
export const VideoCutSchema = VideoCutResponseSchema.extend({
  purpose: PurposeSchema,
  narration: z.string().trim().max(400),
  effect: CutEffectSchema.default("hard_cut"),
  veoClip: z.enum(["", ...VEO_CLIP_IDS]).default(""),
  stillId: z.enum(["", ...STILL_IDS]).default(""),
  veoPrompt: z.string().trim().max(1200).default(""),
  graphicKind: GraphicKindSchema.default(""),
  graphicLines: z.array(z.string().trim().min(1).max(24)).max(4).default([]),
});

// 음성 트랙 한 문장(모델 응답): 시간을 따로 적지 않고 그 문장이 흐르는 컷 범위(fromCut~toCut, 0부터, 양끝 포함)에 묶는다.
// 내레이션과 화면이 따로 놀던 문제(사용자 불만 2026-10-04: "600밀리그램" 문장 아래에 다른 그림)를 구조로 막는다.
// 시간은 videoScriptFromFlat 이 컷 시간에서 유도한다.
export const VoiceLineResponseSchema = z.strictObject({
  fromCut: z
    .number()
    .int()
    .min(0)
    .max(VIDEO_MAX_SEC - 1),
  toCut: z
    .number()
    .int()
    .min(0)
    .max(VIDEO_MAX_SEC - 1),
  // 문장의 편집 목적. 컷 목적과 일치할 필요는 없다.
  purpose: ResponsePurposeSchema,
  text: z.string().trim().min(1).max(200),
  // 설득 사슬 칸(평면 형태·픽스처용). 중첩 응답은 SentenceResponseSchema 가 필수로 받는다.
  chainStep: z.enum(["", ...SCRIPT_CHAIN_STEPS]).default(""),
  // 콜아웃(평면 형태·픽스처용). 중첩 응답은 필수.
  callouts: z.array(CalloutSchema).max(CALLOUTS_MAX).default([]),
  actionSync: ActionSyncSchema.nullable().optional(),
});
// 저장본: 시간(startSec/endSec)은 그대로 두고 컷 범위·목적을 더한다.
// 컷 범위가 없던 예전 대본은 fromCut/toCut -1·purpose "" 로 읽히고, 범위는 시간에서 유도한다(voiceCutRange).
export const VoicePurposeSchema = z.enum(["", ...PurposeSchema.options]);
export const VoiceLineSchema = z.strictObject({
  startSec: z
    .number()
    .min(0)
    .max(VIDEO_MAX_SEC - SHOT_MIN_SEC),
  endSec: z.number().min(SHOT_MIN_SEC).max(VIDEO_MAX_SEC),
  text: z.string().trim().min(1).max(200),
  fromCut: z
    .number()
    .int()
    .min(-1)
    .max(VIDEO_MAX_SEC - 1)
    .default(-1),
  toCut: z
    .number()
    .int()
    .min(-1)
    .max(VIDEO_MAX_SEC - 1)
    .default(-1),
  purpose: VoicePurposeSchema.default(""),
  // 설득 사슬 칸(사용자 결정 2026-10-06). 예전 대본은 "" 로 읽히고 사슬 규칙을 건너뛴다.
  chainStep: z.enum(["", ...SCRIPT_CHAIN_STEPS]).default(""),
  // 콜아웃(2026-10-06). 콜아웃이 없던 예전 대본은 [] 로 읽힌다(다이제스트에서 빈 배열은 뺀다).
  callouts: z.array(CalloutSchema).max(CALLOUTS_MAX).default([]),
  actionSync: ActionSyncSchema.nullable().optional(),
});
export type VoiceLine = z.infer<typeof VoiceLineSchema>;
export type VoiceLineResponse = z.infer<typeof VoiceLineResponseSchema>;

export const VeoClipSchema = z.strictObject({
  id: VeoClipIdSchema,
  startImagePrompt: line,
  prompt: line,
  // 구간 계획(2026-10-06, R5). 계획이 없던 예전 대본은 빈 계획으로 읽힌다(다이제스트에서 뺀다).
  plan: ClipPlanSchema.default(() => emptyClipPlan()),
});
// 새 대본에서 모델이 선언하는 클립은 A~D 만이고 구간 계획은 필수(세 구간 모두 camera·action).
export const VeoClipResponseSchema = VeoClipSchema.extend({
  id: z.enum(VEO_RESPONSE_CLIP_IDS),
  plan: ClipPlanResponseSchema,
});
// 평면 형태(픽스처·편집 경로): ID 는 A~D, 계획은 기본값 허용.
const FlatVeoClipSchema = VeoClipSchema.extend({ id: z.enum(VEO_RESPONSE_CLIP_IDS) });
export const InfoClipStageSchema = z.enum(["real_cause", "criteria", "mechanism", "verification"]);
// --- 혼합형 설명 장면(2026-10-07, hybrid_explainer_v1, 레퍼런스 문법 R1~R6) -------------------------------------
// 장면 종류·색·강조·물체 스키마는 shared/explainer-scene.ts 에 있다(기획 스키마도 같은 것을 쓴다). 이름은 여기서 그대로 내보낸다.
export {
  EXPLAINER_ACTIONS_MAX,
  EXPLAINER_COLORS,
  EXPLAINER_EMPHASIS_KINDS,
  EXPLAINER_EMPHASIS_MAX,
  EXPLAINER_OBJECTS_MAX,
  EXPLAINER_SCENE_TYPES,
  ExplainerColorSchema,
  type ExplainerEmphasis,
  ExplainerEmphasisKindSchema,
  ExplainerEmphasisSchema,
  type ExplainerObject,
  ExplainerObjectSchema,
  ExplainerSceneTypeSchema,
} from "./explainer-scene";
// 설명 컷 하나의 길이 상한(초): 한 단계(phase)만 쓰고 마지막 동작 뒤 보유는 1초까지(R9). 실사 컷의 5초보다 엄격하다.
export const EXPLAINER_CUT_MAX_SEC = DEFAULT_THRESHOLDS.EXPLAINER_CUT_MAX_SEC;
// 설명 컷 시간 합계의 권장 상한(영상 길이 대비). 넘으면 경고(soft).
export const EXPLAINER_MAX_RATIO = DEFAULT_THRESHOLDS.EXPLAINER_MAX_RATIO;
// 저장용 설명 장면 필드: 혼합형 이전 대본은 이 필드 없이 저장돼 있다(기본값; 다이제스트에서 뺀다).
const explainerSceneStored = {
  sceneType: z.enum(["", ...EXPLAINER_SCENE_TYPES]).default(""),
  objects: z.array(ExplainerObjectSchema).max(EXPLAINER_OBJECTS_MAX).default([]),
  actions: z.array(line).max(EXPLAINER_ACTIONS_MAX).default([]),
  emphasis: z.array(ExplainerEmphasisSchema).max(EXPLAINER_EMPHASIS_MAX).default([]),
};
// 설명 컷: explanation이 있으면 이름표·설명선을 INFO 이미지에 먼저 완성한다.
// infoLines는 annotations의 정확한 라벨 목록이며, 이전 저장본의 text-free/legacy 동작도 보존한다.
export const InfoClipSchema = z
  .strictObject({
    id: z.enum(INFO_CLIP_IDS),
    stage: InfoClipStageSchema,
    cleanPrompt: line,
    infoPrompt: line,
    infoLines: z.array(z.string().trim().min(1).max(24)).max(4).default([]),
    motionPrompt: z.string().trim().max(1200).default(""),
    graphicOrder: z.array(line).max(5).default([]),
    plan: ClipPlanSchema.default(() => emptyClipPlan()),
    explanation: ExplanationPlanSchema.nullable().optional(),
    ...explainerSceneStored,
    labelLayer: HfLabelPlanSchema.optional(),
  })
  .superRefine((clip, ctx) => {
    for (const message of hfLabelClipProblems(clip))
      ctx.addIssue({ code: "custom", path: ["labelLayer"], message });
    if (clip.labelLayer && (clip.sceneType === "" || clip.explanation))
      ctx.addIssue({
        code: "custom",
        path: ["labelLayer"],
        message:
          "HyperFrames 라벨은 혼합형 설명 장면에만 사용하고 이전 explanation과 혼용하지 않습니다.",
      });
  });
export type InfoClip = z.infer<typeof InfoClipSchema>;
// 설명 장면이 적힌 설명 컷(혼합형)인가. 예전·immersive 대본의 설명 컷은 sceneType "" 이다.
export function isExplainerScene(clip: Pick<InfoClip, "sceneType">): boolean {
  return clip.sceneType !== "";
}
// 혼합형 모델 응답용 설명 컷: 이름표·지시선 필드(graphicOrder·explanation) 없이 장면 + INFO 문구(infoLines)를 받는다(모든 필드 필수).
export const HybridInfoClipResponseSchema = z.strictObject({
  id: z.enum(INFO_CLIP_IDS),
  stage: InfoClipStageSchema,
  // CLEAN = 설명 세계 기준(explainerAnchor) + 물체 장면, 글자·화살표·이름표·링 없음. INFO = 같은 장면 + 강조 + 인포그래픽(infoLines 글자).
  cleanPrompt: line,
  infoPrompt: line,
  // 2026-10-08(사용자 결정: 인포그래픽은 앱이 아니라 Flow INFO 이미지 안에): INFO 에 찍을 한국어 라벨·숫자 1~4줄(각 24자 이하).
  // 숫자는 FACTS 에 있는 것만(shared/script-rules.ts 가 대조), 업로드 때 앱이 이미지 글자와 대조한다(server/flow-import.ts).
  // 예전 혼합형 저장본은 [] 로 남아 글자 없음 검사 그대로다.
  infoLines: z.array(z.string().trim().min(1).max(24)).min(1).max(4),
  plan: ClipPlanResponseSchema,
  sceneType: ExplainerSceneTypeSchema,
  objects: z.array(ExplainerObjectSchema).min(1).max(EXPLAINER_OBJECTS_MAX),
  // 물체가 하는 일의 순서(영어 한 줄씩): 올라감·쏟아짐·열림·차오름.
  actions: z.array(line).min(1).max(EXPLAINER_ACTIONS_MAX),
  emphasis: z.array(ExplainerEmphasisSchema).max(EXPLAINER_EMPHASIS_MAX),
});
export type HybridInfoClipResponse = z.infer<typeof HybridInfoClipResponseSchema>;
// 모델 응답용 설명 컷(모든 필드 필수, infoLines·motionPrompt 없음).
export const InfoClipResponseSchema = z.strictObject({
  id: z.enum(INFO_CLIP_IDS),
  stage: InfoClipStageSchema,
  cleanPrompt: line,
  infoPrompt: line,
  graphicOrder: z.array(line).min(2).max(5),
  plan: ClipPlanResponseSchema,
  explanation: ExplanationPlanSchema.nullable(),
});
export type InfoClipResponse = z.infer<typeof InfoClipResponseSchema>;
// 카피 먼저 흐름(2026-10-08)의 1단계 응답: 문장(사슬 단계 + 글)만. 장면은 2단계가 이 문장을 고정 입력으로 받아 붙인다.
// 규칙(순서·사실 숫자·40자·문장 수·④ 한 문장·영문/메모체·반복·행동 동사)은 shared/script-rules-v2.ts copyProblems 가 본다.
export const CopyLineSchema = z.strictObject({
  chainStep: z.enum(SCRIPT_CHAIN_STEPS),
  text: z.string().trim().min(1).max(60),
});
export type CopyLine = z.infer<typeof CopyLineSchema>;
export const VideoCopyResponseSchema = z.strictObject({
  lines: z.array(CopyLineSchema).min(4).max(14),
});
export type VideoCopyResponse = z.infer<typeof VideoCopyResponseSchema>;
// 정지 이미지: 사진풍 9:16 이미지 한 장의 영어 프롬프트. styleAnchor 를 따른다.
export const StillSchema = z.strictObject({
  id: StillIdSchema,
  prompt: line,
});

// 평면 대본(컷 배열 + 컷 범위에 묶인 음성 문장): 2026-10-04 이전 모델 응답 형식이었고, 지금은 중첩 응답을 저장 형식으로
// 바꾸는 중간 형태·테스트 픽스처용으로만 쓴다(모델에는 보내지 않는다). videoScriptFromFlat 이 저장 형식으로 바꾼다.
export const VoicePersonaSchema = z.enum(["", "conversational", "storytelling"]);
const fixedTitle = z.array(z.string().trim().min(1).max(40)).max(2);
const disclaimer = z.string().trim().max(240);

export const FlatScriptSchema = z.strictObject({
  fixedTitle: fixedTitle.optional(),
  disclaimer: disclaimer.optional(),
  voicePersona: VoicePersonaSchema.optional(),
  number: z.number().int().min(1).max(10),
  hypothesisId: z.string().min(1),
  title: line,
  durationSec: z.number().min(8).max(VIDEO_MAX_SEC),
  // 시청자의 궁금증과 그 답을 보여주는 시점. 답은 기획에 따라 초반에도 보여줄 수 있다.
  openLoop: line,
  payoffSec: z.number().int().min(1).max(VIDEO_MAX_SEC),
  cuts: z.array(VideoCutResponseSchema).min(2).max(VIDEO_MAX_SEC),
  // 문장은 컷 범위에 묶인다(순서대로·겹침 없이). 시간은 컷에서 유도한다.
  voiceover: z.array(VoiceLineResponseSchema).min(1).max(40),
  styleAnchor: line,
  // 혼합형(2026-10-07)의 설명 세계 기준. 다른 정책의 평면 대본은 적지 않는다(저장 기본값 "").
  explainerAnchor: z.string().trim().max(1200).optional(),
  subjects: z.array(SubjectSchema).max(SUBJECTS_MAX).default([]),
  veoClips: z.array(FlatVeoClipSchema).max(VEO_SHOTS_MAX),
  stills: z.array(StillSchema).max(STILL_SHOTS_MAX),
  infoClips: z.array(InfoClipSchema).max(INFO_CLIPS_MAX).optional(),
  flowPrompt: line,
  editInstructions: line,
  // 카피 먼저 흐름(2026-10-08): 생성기가 평면 대본에 "copy_first" 를 적어 넘기면 저장 대본의 flow 가 된다(없으면 "").
  flow: z.enum(["", "copy_first"]).optional(),
});
export type FlatScript = z.infer<typeof FlatScriptSchema>;
export type FlatCut = z.infer<typeof VideoCutResponseSchema>;

// --- 모델 응답(2026-10-04, 문장 우선·컷 중첩) ------------------------------------------------------------------
// 실전 gpt-5-mini 가 컷 목록과 음성 목록을 따로 쓰면서 약 25개 규칙을 한 번에 지키지 못했다(graphicLines 를 정지 이미지 컷에,
// 3초 범위에 19~23자, mechanism 문장을 proof 컷에, 600mg 를 보이지 않는 컷에서 말함 — 3회 모두 거부). 그래서 모델은 문장을
// 말하는 순서대로 쓰고, 문장마다 그 문장이 흐르는 동안 보이는 컷을 아래에 적는다. 컷 번호·초·범위·목적은 앱이 유도하므로
// 범위 유효·순서·겹침·말 없는 컷·목적 일치는 구조로 성립하고, 남는 교차 검사는 내용(말한 것이 보이는가)뿐이다.
// 응답 스키마에는 .default()/.optional() 을 쓰지 않는다(z.toJSONSchema 가 required 에 넣고 strict 모드가 default 키워드를 거부할 수 있다).
export const SentenceCutResponseSchema = z.strictObject({
  // 컷 길이(초)는 동작·이해에 맞춰 정한다. 전체 길이와 실제 소스 예산은 별도로 검사한다.
  len: z.number().min(SHOT_MIN_SEC).max(VIDEO_MAX_SEC),
  source: SourceSchema,
  screenComposition: line,
  // 한 줄 7~12자가 권장이다. 긴 문구는 경고하되 내용을 자동 삭제하지 않는다.
  onScreenText: z.string().trim().max(120),
  effect: CutEffectSchema,
  veoClip: z.enum(RESPONSE_CUT_CLIP_IDS),
  stillId: z.enum(["", ...STILL_IDS]),
  graphicKind: GraphicKindSchema,
  graphicLines: z.array(z.string().trim().min(1).max(24)).max(4),
  // 시청자가 이 컷에서 이해해야 할 핵심 한 문장(한국어, ≤40자).
  goal: z.string().trim().min(1).max(CUT_GOAL_MAX_CHARS),
  // veo_clip 컷이 읽는 클립 구간(early 0~3초·mid 3~5.5초·late 5.5~8초). 다른 소스는 "".
  phase: CutPhaseSchema,
});
export const SentenceResponseSchema = z.strictObject({
  // 문장의 목적. 아래 컷들은 이 목적을 상속한다.
  purpose: ResponsePurposeSchema,
  // 이 문장이 말하는 설득 사슬 칸: pain → believed_cause → real_cause → requirement → product_fact → reason_why → outcome → cta.
  // bridge 는 사슬에 속하지 않는 연결 문장(순서 검사에서 무시).
  chainStep: z.enum(SCRIPT_CHAIN_STEPS),
  // 응답은 60자까지 받아 수정 피드백을 준다. 대본 규칙의 한 호흡 한도는 40자다.
  text: z.string().trim().min(1).max(60),
  // 이 문장의 어절에 붙는 콜아웃(최대 3개, 없으면 []). 앱이 그 어절의 음성 시각에 그린다.
  callouts: z.array(CalloutResponseSchema).max(CALLOUTS_MAX),
  actionSync: ActionSyncSchema.nullable(),
  // 이 문장이 흐르는 동안 보이는 컷(순서대로). 합계 초 = 문장 시간.
  cuts: z.array(SentenceCutResponseSchema).min(1).max(8),
});
// 응답 최상위 필드(정책 공통). 혼합형은 styleAnchor 뒤에 explainerAnchor 를 더하고 설명 컷 형태가 다르다(아래).
const responseHead = {
  fixedTitle,
  disclaimer,
  voicePersona: VoicePersonaSchema,
  title: line,
  openLoop: line,
  // 영상 범위 밖일 때만 마지막으로 보이는 정수 초에 맞춘다(경고).
  payoffSec: z.number().int().min(1).max(VIDEO_MAX_SEC),
  // 모든 시작 이미지·정지 이미지가 공유하는 시각 기준(인물·장소·톤).
  styleAnchor: line,
};
const responseBody = {
  // 등장 대상(인물·제품, 최대 4개): id 와 외형 한 줄. 이미지 프롬프트는 등장 대상의 traits 를 자체 포함해야 한다.
  subjects: z.array(SubjectSchema).max(SUBJECTS_MAX),
  // Veo 원본 클립은 실사 움직임이 필요한 순간에만 영상당 최대 4개(A~D)를 선언하고, 컷은 그 클립의 여러 순간을 잘라 쓴다.
  veoClips: z.array(VeoClipResponseSchema).max(VEO_SHOTS_MAX),
  // 분위기·상황·장소·사물 컷이 쓰는 AI 정지 이미지(최대 14장).
  stills: z.array(StillSchema).max(STILL_SHOTS_MAX),
};
const responseTail = {
  sentences: z.array(SentenceResponseSchema).min(4).max(40),
  flowPrompt: line,
  editInstructions: line,
};
export const VideoScriptResponseSchema = z.strictObject({
  ...responseHead,
  ...responseBody,
  // 설명 컷(최대 3개, Flow 모드에서만). 없으면 [].
  infoClips: z.array(InfoClipResponseSchema).max(INFO_CLIPS_MAX),
  ...responseTail,
});
export type VideoScriptResponse = z.infer<typeof VideoScriptResponseSchema>;
// 혼합형(hybrid_explainer_v1) 응답: 실사 기준(styleAnchor)과 설명 세계 기준(explainerAnchor)을 따로 받고,
// 설명 컷은 이름표 필드 없는 장면 형태(HybridInfoClipResponseSchema)다. immersive·예전 정책의 응답 스키마는 그대로다.
export const HybridVideoScriptResponseSchema = z.strictObject({
  ...responseHead,
  // 설명 세계의 시각 기준: 클레이·화이트 모형 + 브랜드 강조색 2개 + 흰 발광 + 주광, 사람 없음, 글자 없음.
  explainerAnchor: line,
  ...responseBody,
  // 설명 장면(최대 3개, Flow 모드에서만). 없으면 [].
  infoClips: z.array(HybridInfoClipResponseSchema).max(INFO_CLIPS_MAX),
  ...responseTail,
});
export const HfVideoScriptResponseSchema = HybridVideoScriptResponseSchema.extend({
  infoClips: z
    .array(
      HybridInfoClipResponseSchema.extend({ labelLayer: HfLabelPlanResponseSchema }).superRefine(
        (clip, ctx) => {
          for (const message of hfLabelClipProblems(clip))
            ctx.addIssue({ code: "custom", path: ["labelLayer"], message });
        },
      ),
    )
    .max(INFO_CLIPS_MAX),
});
export type HfVideoScriptResponse = z.infer<typeof HfVideoScriptResponseSchema>;
export type HybridVideoScriptResponse = z.infer<typeof HybridVideoScriptResponseSchema>;
// 정책별 모델 응답 스키마. 수리·평면화(script-repair)는 두 형태를 모두 받는다.
export type ScriptResponseInput =
  | VideoScriptResponse
  | HybridVideoScriptResponse
  | HfVideoScriptResponse;
export function videoScriptResponseSchemaFor(
  policy: VisualPolicyId | undefined,
): z.ZodType<ScriptResponseInput> {
  return policy === "hybrid_explainer_v1"
    ? HybridVideoScriptResponseSchema
    : VideoScriptResponseSchema;
}
export function isHybridResponse(
  response: ScriptResponseInput,
): response is HybridVideoScriptResponse | HfVideoScriptResponse {
  return "explainerAnchor" in response;
}
export type SentenceResponse = z.infer<typeof SentenceResponseSchema>;
export type SentenceCutResponse = z.infer<typeof SentenceCutResponseSchema>;
// 저장본은 예전 8초 대본도 읽는다.
export const VideoScriptSchema = z.strictObject({
  planning: VideoPlanningSchema.optional(),
  fixedTitle: fixedTitle.default([]),
  disclaimer: disclaimer.default(""),
  voicePersona: VoicePersonaSchema.default(""),
  number: z.number().int().min(1).max(10),
  hypothesisId: z.string().min(1),
  title: line,
  durationSec: z.number().min(8).max(VIDEO_MAX_SEC),
  openLoop: z.string().trim().max(1200).default(""),
  payoffSec: z.number().int().min(0).max(VIDEO_MAX_SEC).default(0),
  cuts: z.array(VideoCutSchema).min(2).max(VIDEO_MAX_SEC),
  voiceover: z.array(VoiceLineSchema).max(40).default([]),
  styleAnchor: z.string().trim().max(1200).default(""),
  // 혼합형(2026-10-07)의 설명 세계 기준. 이전 대본은 이 필드 없이 저장돼 있다(기본 ""; 다이제스트에서 뺀다).
  explainerAnchor: z.string().trim().max(1200).default(""),
  // 등장 대상이 없던 예전 대본은 subjects 없이 저장돼 있다(기본 []; 다이제스트에서 뺀다).
  subjects: z.array(SubjectSchema).max(SUBJECTS_MAX).default([]),
  veoClips: z.array(VeoClipSchema).max(VEO_STORED_SHOTS_MAX).default([]),
  // 정지 이미지 소스가 없던 예전 대본은 stills 없이 저장돼 있다(기본 []).
  stills: z.array(StillSchema).max(STILL_SHOTS_MAX).default([]),
  // 설명 컷이 없던 대본은 infoClips 없이 저장돼 있다(기본 []; 다이제스트에서 빈 배열은 뺀다).
  infoClips: z.array(InfoClipSchema).max(INFO_CLIPS_MAX).default([]),
  flowPrompt: line,
  editInstructions: line,
  // 대본 생성 흐름(2026-10-08 사용자 결정 "카피 먼저 → 장면 나중"): "copy_first" 면 규칙은 shared/script-rules-v2.ts(카피 8·제작 안전 12)만 본다.
  // "" 는 예전 흐름(규칙 100개). 저장 기본값이라 다이제스트에서 뺀다.
  flow: z.enum(["", "copy_first"]).default(""),
});

// AI 대본 품질 검토(규칙 검사를 통과한 대본 전체를 한 번 더 읽는다): 말맛·설득 구조·가설 일치·지어낸 주장·인물 이름·메모 말투·자막-내레이션 어울림·반복.
// 모델 응답은 strictObject(json_schema strict), 저장본(renders[].scriptReview)은 아래 StoredVideoScriptReviewSchema.
// 모델 응답용(json_schema strict: 모든 필드 필수). cutIndexes 는 말과 그림이 어긋난 컷 번호(0부터), 해당 없으면 [].
export const VideoScriptReviewIssueResponseSchema = z.strictObject({
  // 문제가 있는 음성 문장 번호(0부터). 특정 문장이 아니면 null.
  sentenceIndex: z.number().int().min(0).max(39).nullable(),
  cutIndexes: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(VIDEO_MAX_SEC - 1),
    )
    .max(VIDEO_MAX_SEC),
  problem: z.string().trim().min(1).max(400),
  fix: z.string().trim().min(1).max(400),
});
// 저장본(renders[].scriptReview·CLI 표시): 컷 번호가 없던 예전 검토 기록은 [] 로 읽는다.
export const VideoScriptReviewIssueSchema = VideoScriptReviewIssueResponseSchema.extend({
  cutIndexes: VideoScriptReviewIssueResponseSchema.shape.cutIndexes.default([]),
});
export const VideoScriptReviewSchema = z.strictObject({
  status: z.enum(["pass", "revise"]),
  issues: z.array(VideoScriptReviewIssueResponseSchema).max(20),
  summary: z.string().trim().min(1).max(800),
});
export type VideoScriptReview = z.infer<typeof VideoScriptReviewSchema>;
export type VideoScriptReviewIssue = z.infer<typeof VideoScriptReviewIssueSchema>;

export type VideoScript = z.infer<typeof VideoScriptSchema>;
// 대본의 시각 정책 분기: 정책이 없으면 예전(legacy), immersive_explanations_v1, hybrid_explainer_v1.
export type VideoPolicyKind = "legacy" | "immersive" | "hybrid";
export function videoPolicyOf(script: {
  readonly planning?: { readonly visualPolicy?: VisualPolicyId | undefined } | undefined;
}): VideoPolicyKind {
  switch (script.planning?.visualPolicy) {
    case "hybrid_explainer_v1":
      return "hybrid";
    case "immersive_explanations_v1":
      return "immersive";
    default:
      return "legacy";
  }
}
// 자연 타이밍(2026-10-06 immersive 에서 도입, 2026-10-07 혼합형도 같이 쓴다 — 검토 지적으로 명시): 창 초과 문장의 템포 재합성(사용자가
// 1.3배 내레이션을 싫어함)·500ms 분산 대신 문장이 묶인 마지막 컷을 말 끝까지 늘리고, 단계 없는 설명 컷은 처음부터 읽는다.
// 내레이션 합성(server/voice-production.ts)·Flow 클립 길이 검사(server/render/clip-need.ts)가 같은 값을 써야 읽는 구간이 같다.
export function usesNaturalTiming(script: Parameters<typeof videoPolicyOf>[0]): boolean {
  return videoPolicyOf(script) !== "legacy";
}
export function isHybrid(script: Parameters<typeof videoPolicyOf>[0]): boolean {
  return videoPolicyOf(script) === "hybrid";
}
export type VideoCut = z.infer<typeof VideoCutSchema>;
export type VeoClip = z.infer<typeof VeoClipSchema>;
export type Still = z.infer<typeof StillSchema>;
export type StillId = z.infer<typeof StillIdSchema>;

// 문장 시간은 계산으로 맞춘다: 문장이 자기 시간보다 길면 끝을 늘리고 뒤 문장을 민다(앞에서부터).
// 그래서 영상 끝을 넘으면 뒤에서부터 앞으로 당긴다. 컷에서 유도한 시작 시점(화면과의 싱크)은 최대한 유지한다.
// 컷 범위 없는 예전 대본에만 쓰는 추정 시간 조정. 새 문장은 컷 경계를 그대로 유지한다.
type TimedLine = { readonly startSec: number; readonly endSec: number; readonly text: string };
export function fitVoiceover<T extends TimedLine>(
  voiceover: readonly T[],
  durationSec: number,
): T[] {
  const needed = (text: string) => Math.ceil([...text].length / NARRATION_MAX_CHARS_PER_SEC);
  const fitted: T[] = [];
  let previousEnd = 0;
  for (const voice of voiceover) {
    const startSec = Math.max(voice.startSec, previousEnd);
    const endSec = Math.max(voice.endSec, startSec + needed(voice.text));
    fitted.push({ ...voice, startSec, endSec });
    previousEnd = endSec;
  }
  let limit = durationSec;
  for (let index = fitted.length - 1; index >= 0; index--) {
    const voice = fitted[index];
    if (!voice) continue;
    const endSec = Math.min(voice.endSec, limit);
    const startSec = Math.min(voice.startSec, endSec - needed(voice.text));
    if (startSec < 0) return spreadVoiceover(voiceover, durationSec);
    fitted[index] = { ...voice, startSec, endSec };
    limit = startSec;
  }
  return fitted;
}

// 시작 시점을 지키면 영상 안에 다 들어가지 않을 때: 첫 문장부터 끝까지 글자 수 비율로 다시 나눈다.
// 총량이 허용 범위면 모든 문장이 대략 같은 속도로 읽힌다(초 단위 반올림 오차는 검사에서 허용).
function spreadVoiceover<T extends TimedLine>(voiceover: readonly T[], durationSec: number): T[] {
  const first = voiceover[0]?.startSec ?? 0;
  const total = voiceover.reduce((sum, voice) => sum + [...voice.text].length, 0);
  if (total === 0) return [...voiceover];
  let before = 0;
  return voiceover.map((voice) => {
    const startSec = first + Math.round((before / total) * (durationSec - first));
    before += [...voice.text].length;
    const endSec = Math.max(
      startSec + 1,
      first + Math.round((before / total) * (durationSec - first)),
    );
    return { ...voice, startSec, endSec: Math.min(endSec, durationSec) };
  });
}

type CutTime = { readonly startSec: number; readonly endSec: number };
type RangedLine = TimedLine & { readonly fromCut: number; readonly toCut: number };
// 문장이 묶인 컷 범위 [from, to](0부터, 양끝 포함). 선언된 범위(fromCut ≥ 0)는 컷 수 안으로 잘라 돌려주고,
// 범위가 없는 예전 대본은 시간에서 유도한다: 문장 시간 [startSec, endSec) 와 겹치는 컷들(문장이 시작하는 컷부터).
// 컷이 없거나 선언 범위가 전부 컷 밖이면 null.
export function voiceCutRange(
  voice: RangedLine,
  cuts: readonly CutTime[],
): readonly [number, number] | null {
  if (cuts.length === 0) return null;
  if (voice.fromCut >= 0) {
    if (voice.fromCut >= cuts.length) return null;
    return [voice.fromCut, Math.min(Math.max(voice.fromCut, voice.toCut), cuts.length - 1)];
  }
  let from = 0;
  let to = 0;
  cuts.forEach((cut, index) => {
    if (cut.startSec <= voice.startSec) from = index;
    if (cut.startSec < voice.endSec) to = index;
  });
  return [from, Math.max(from, to)];
}
// 문장의 목적: 저장된 값이 있으면 그것, 없으면(예전 대본) 첫 컷의 목적.
export function voicePurposeOf(
  voice: RangedLine & { readonly purpose: string },
  cuts: readonly (CutTime & { readonly purpose: string })[],
): string {
  if (voice.purpose) return voice.purpose;
  const range = voiceCutRange(voice, cuts);
  return range ? (cuts[range[0]]?.purpose ?? "") : "";
}
// 컷에 묶인 문장은 첫 컷 시작부터 마지막 컷 끝까지 저장한다. 속도 추정으로 컷 경계를 바꾸지 않는다.
// 범위가 없는 예전 문장(fromCut -1)은 저장된 시간을 그대로 쓴다.
export function bindVoiceover<T extends RangedLine>(
  voiceover: readonly T[],
  cuts: readonly CutTime[],
  durationSec: number,
): T[] {
  const bound = voiceover.map((voice) => {
    const range = voice.fromCut >= 0 ? voiceCutRange(voice, cuts) : null;
    if (!range) return voice;
    const first = cuts[range[0]];
    const last = cuts[range[1]];
    if (!first || !last) return voice;
    return {
      ...voice,
      startSec: first.startSec,
      endSec: last.endSec,
    };
  });
  return voiceover.some((voice) => voice.fromCut >= 0) ? bound : fitVoiceover(bound, durationSec);
}
// 컷별 내레이션: 문장은 그 문장의 컷 범위가 시작하는 컷에 담는다(예전 대본은 문장이 시작하는 시점의 컷).
export function cutNarration(cuts: readonly CutTime[], voiceover: readonly RangedLine[]): string[] {
  const texts = cuts.map(() => [] as string[]);
  for (const voice of voiceover) {
    const range = voiceCutRange(voice, cuts);
    if (range) texts[range[0]]?.push(voice.text);
  }
  return texts.map((items) => items.join(" "));
}

// 평면 대본(컷 + 컷에 묶인 음성 트랙)을 저장 형식으로: 문장 시간은 컷에서 유도하고, 문장은 범위 첫 컷의 내레이션에 담는다.
// 모델의 중첩 응답은 shared/script-repair.ts 의 videoScriptFromResponse 가 수리·평면화한 뒤 여기로 온다.
export function videoScriptFromFlat(flat: FlatScript): VideoScript {
  const voiceover = bindVoiceover(
    flat.voiceover.map((voice) => ({ ...voice, startSec: 0, endSec: flat.durationSec })),
    flat.cuts,
    flat.durationSec,
  );
  const narration = cutNarration(flat.cuts, voiceover);
  return {
    ...flat,
    fixedTitle: flat.fixedTitle ?? [],
    disclaimer: flat.disclaimer ?? "",
    voicePersona: flat.voicePersona ?? "",
    explainerAnchor: flat.explainerAnchor ?? "",
    // 흐름 표시는 생성기(server/script-writer.ts)가 카피 먼저 흐름일 때 "copy_first" 로 바꾼다. 평면 대본에는 없다.
    flow: flat.flow ?? "",
    voiceover,
    // 정지 이미지 선언은 그대로 저장한다(컷은 stillId 로 가리킨다).
    stills: flat.stills.map((still) => ({ ...still })),
    infoClips: (flat.infoClips ?? []).map((clip) => ({ ...clip })),
    cuts: flat.cuts.map((cut, index) => ({
      ...cut,
      veoPrompt:
        flat.veoClips.find((clip) => clip.id === cut.veoClip)?.prompt ??
        infoClipMotionText(flat.infoClips?.find((clip) => clip.id === cut.veoClip)) ??
        "",
      narration: narration[index] ?? "",
    })),
  };
}
// 설명 컷의 움직임 글: 예전 대본은 motionPrompt, 새 대본(2026-10-06)은 구간 계획(plan)을 한 문단으로. 선언이 없으면 undefined.
function infoClipMotionText(clip: InfoClip | undefined): string | undefined {
  if (!clip) return undefined;
  return clip.motionPrompt || clipPlanText(clip.plan);
}

// 나레이션 문장 규칙(사용자 요구 2026-10-04: 첫 실전 영상의 내레이션이 메모체·영문 상품명·출처 낭독·반복으로 쓸 수 없었다).
// 코드로 잡을 수 있는 것은 여기서 잡고(모델이 아니라 계산), 말맛·설득력은 AI 검토(VideoScriptReviewSchema)가 본다.
// 서버 verifyLongVideoScript 와 화면 편집 검증이 같은 함수를 쓴다.
export const NARRATION_MIN_SENTENCE_CHARS = DEFAULT_THRESHOLDS.NARRATION_MIN_SENTENCE_CHARS;
const LATIN_LETTER = /[A-Za-z]/;
const MEMO_MARKER = /예\s*[:：]|출처|FACT|sourceId/;
// 메모체(체언 종결): "600밀리그램, 30캡슐도 확인." "그리고 엑스트라 버진 표기." "원료를 우선하는 선택법."처럼
// 서술어 없이 명사로 끝나는 문장은 TTS 가 읽으면 메모를 읽는 소리가 난다. 문장 끝 문장부호를 뗀 뒤 검사한다.
const MEMO_ENDING_WORDS = [
  "확인",
  "표기",
  "단서",
  "참고",
  "주의",
  "유의",
  "필수",
  "체크",
  "메모",
  "정리",
  "요약",
  "근거",
  "기준",
  "예시",
  "가능",
  "불가",
  "완료",
  "포인트",
  "팁",
  "추천",
  "주목",
  "필요",
  "중요",
  "충분",
  "포함",
  "제공",
  "권장",
  "예정",
  "진행",
  "적용",
  "비교",
  "차이",
  "이유",
  "특징",
  "장점",
  "효과",
  "성분",
  "함량",
  "원료",
  "가격",
  "할인",
  "무료",
  "배송",
  "증정",
  "한정",
  "마감",
] as const;
const MEMO_ENDING = new RegExp(`(?:${MEMO_ENDING_WORDS.join("|")}|[가-힣]법)$`);
// 조사로 끝나는 토막("저도", "이것을", "라벨의")은 문장이 아니다.
const PARTICLE_ENDING = /[가-힣](?:도|은|는|을|를|의|과|와|에서|부터|까지)$/;
// 지어낸 인물: "박씨", "박씨의", "지은 씨는", "김대리". 날씨·솜씨·글씨·말씨·마음씨·아저씨·아가씨 같은 낱말은 뺀다.
// 씨 뒤에는 조사(의·는·가·도…)만 올 수 있다(씨앗·씨름처럼 다른 글자가 이어지면 이름이 아니다).
const PERSONA_SUFFIX = /([가-힣]{1,3})\s?씨(?:(?![가-힣])|(?=[은는이가을를의도와과께한]))/gu;
const COMMON_SSI_WORDS = new Set(["날", "솜", "글", "말", "마음", "아저", "아가", "아줌", "눈"]);
const PERSONA_TITLE =
  /(?<![가-힣])[김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진][가-힣]?(?:대리|과장|부장|팀장|사원|차장|주임)(?:(?![가-힣])|(?=[은는이가을를의도와과께한님]))/u;
// 거의 같은 문장 판정: 글자 2개씩 묶음(bigram)의 자카드 유사도가 NEAR_DUPLICATE_RATIO(임계값) 이상이면 같은 말을 되풀이한 것으로 본다.
// 아주 짧은 문장(묶음 NEAR_DUPLICATE_MIN_BIGRAMS 개 미만)은 우연히 겹치기 쉬워 비교하지 않는다. 두 값은 thresholds() 에서 읽는다.
// 같은 문장 판정용: 공백·문장부호를 빼고 소문자로 맞춘다.
export function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}
function sentenceBody(text: string): string {
  return text.trim().replace(/[\s\p{P}\p{S}]+$/u, "");
}
export function inventedPersona(text: string): string | null {
  for (const match of text.matchAll(PERSONA_SUFFIX)) {
    const name = match[1] ?? "";
    if ([...COMMON_SSI_WORDS].some((word) => name.endsWith(word))) continue;
    return match[0];
  }
  return PERSONA_TITLE.exec(text)?.[0] ?? null;
}
export function memoEnding(text: string): boolean {
  const body = sentenceBody(text);
  return MEMO_ENDING.test(body) || PARTICLE_ENDING.test(body);
}
function bigrams(key: string): Set<string> {
  const chars = [...key];
  const set = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index++)
    set.add(`${chars[index]}${chars[index + 1]}`);
  return set;
}
export function sentenceSimilarity(a: string, b: string): number {
  const left = bigrams(normalizeSentence(a));
  const right = bigrams(normalizeSentence(b));
  const minBigrams = thresholds().NEAR_DUPLICATE_MIN_BIGRAMS;
  if (left.size < minBigrams || right.size < minBigrams) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}
export function narrationProblems(
  voiceover: readonly { readonly startSec: number; readonly text: string }[],
  voicePersona: z.infer<typeof VoicePersonaSchema> = "",
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const { NARRATION_MIN_SENTENCE_CHARS: minChars, NEAR_DUPLICATE_RATIO: nearRatio } = thresholds();
  voiceover.forEach((voice, index) => {
    const where = `${index + 1}번째 문장(${voice.startSec}초)`;
    if (LATIN_LETTER.test(voice.text))
      problems.push(
        `${where}: 나레이션에 영문이 있습니다 — 한글로 적으세요(예: 엑스트라 버진). "${voice.text}"`,
      );
    if (MEMO_MARKER.test(voice.text))
      problems.push(
        `${where}: 나레이션에 메모·출처 표기("예:", "출처", "FACT", "sourceId")가 있습니다. 시청자에게 말하는 완전한 문장으로 쓰세요. "${voice.text}"`,
      );
    const narrativeNominal = /(?:했음|됐음|졌음|었음|았음|있음|없음|거임|였음|함)$/.test(
      sentenceBody(voice.text),
    );
    if (memoEnding(voice.text) || (narrativeNominal && voicePersona !== "storytelling"))
      problems.push(
        `${where}: 서술어 없이 명사·조사로 끝나는 메모체 문장입니다("~확인.", "~표기.", "~선택법."). "~해요", "~예요", "~세요"처럼 시청자에게 말하는 문장으로 끝내세요. "${voice.text}"`,
      );
    const persona = inventedPersona(voice.text);
    if (persona)
      problems.push(
        `${where}: 지어낸 인물 이름("${persona}")이 있습니다. 시청자에게 직접 말하거나 상황을 묘사하세요. "${voice.text}"`,
      );
    if ([...voice.text.trim()].length < minChars)
      problems.push(`${where}: 문장이 ${minChars}자보다 짧습니다. "${voice.text}"`);
    const key = normalizeSentence(voice.text);
    const first = seen.get(key);
    if (first !== undefined && key.length > 0) {
      problems.push(`${where}: ${first + 1}번째 문장과 같은 문장이 반복됩니다. "${voice.text}"`);
      return;
    }
    // 말끝만 바꾼 되풀이("하루 한 알이면 충분해요" ↔ "하루 한 알이면 충분해요, 진짜로")도 반복으로 본다.
    const near = voiceover.findIndex(
      (other, otherIndex) =>
        otherIndex < index && sentenceSimilarity(other.text, voice.text) >= nearRatio,
    );
    if (near >= 0)
      problems.push(
        `${where}: ${near + 1}번째 문장과 거의 같은 말을 되풀이합니다. 새 정보가 없는 문장은 빼거나 다른 사실로 바꾸세요. "${voice.text}"`,
      );
    seen.set(key, index);
  });
  return problems;
}

// --- 말과 그림 일치(2026-10-04, 첫 실전 영상: "600밀리그램, 30캡슐" 문장 아래에 라벨 카드·추천 제스처가 나오고
// 600mg 클로즈업은 "엑스트라 버진 표기" 문장 아래 있었다) -------------------------------------------------
// 문장이 말하는 숫자·제품 낱말은 그 문장이 묶인 컷의 화면(구도·자막·글줄)에 보여야 한다. 한글 표기와 영문 표기를 같은 낱말로 본다.
// 서버 검사(verifyLongVideoScript)·화면 편집 미리 검사·테스트가 같은 표를 쓴다.
export const NARRATION_TERM_TABLE: readonly (readonly string[])[] = [
  ["엑스트라 버진", "엑스트라버진", "extra virgin", "extra-virgin"],
  ["캡슐", "capsule", "capsules"],
  ["밀리그램", "mg"],
  ["밀리리터", "ml"],
  ["종근당", "chong kun dang", "chongkundang"],
  ["올리브 오일", "올리브오일", "올리브유", "olive oil"],
  ["오메가 쓰리", "오메가3", "omega-3", "omega 3"],
];
// 말 없는 컷은 연속 2개까지(마지막 행동 유도 컷은 말이 없어도 된다). 검사는 thresholds().SILENT_CUTS_MAX 를 읽는다.
export const SILENT_CUTS_MAX = DEFAULT_THRESHOLDS.SILENT_CUTS_MAX;
// 비교용 정규화: 소문자, 공백 제거(영문 낱말 안의 띄어쓰기 차이를 무시한다).
const compact = (text: string) => text.toLowerCase().replace(/\s+/g, "");
const digitGroups = (text: string) =>
  new Set(text.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);
// 글에 들어 있는 숫자 묶음(천 단위 쉼표 제거, 소수 유지). 말과 그림·콜아웃 숫자 규칙이 같은 묶음 규칙을 쓴다.
export function spokenDigitGroups(text: string): Set<string> {
  // 독립된 백 퍼센트만 100과 비교한다. 이백·백오·천 백 같은 다른 수의 일부는 바꾸지 않는다.
  const normalized = text.replace(
    /(?<![\p{L}\p{N}])(?<![\uC77C\uC774\uC0BC\uC0AC\uC624\uC721\uCE60\uD314\uAD6C\uC2ED\uBC31\uCC9C\uB9CC\uC5B5\uC870]\s+)\uBC31\s*\uD37C\uC13C\uD2B8/gu,
    "100퍼센트",
  );
  return digitGroups(normalized);
}
// 구도 설명에 적힌 제품 수량(600mg, 30캡슐, 500ml, 1000IU, 30정…): 라벨 클로즈업처럼 화면에 실제로 보이는 숫자다.
// "30대 여성", "2인 가구"처럼 수량이 아닌 숫자는 화면에 글자로 보이는 것이 아니므로 세지 않는다.
const PRODUCT_QUANTITY =
  /(\d+)\s?(?:(?:mg|mcg|ml|iu|kg|g|%|capsules?|caps|tablets?)(?![A-Za-z])|밀리그램|밀리리터|그램|캡슐|정(?!도)|포|알|환|스틱)/giu;
// 렌더 타임라인에서 문장 사이에 두는 최소 간격(초). render-timeline 의 gapMs 와 같은 값(임계값 VOICE_GAP_SEC)이다.
export const VOICE_GAP_SEC = DEFAULT_THRESHOLDS.VOICE_GAP_SEC;
// 추정 속도 안내: 문장 사이 간격을 제외한 시간에 읽을 수 있는 글자 수. 승인 거부 기준이 아니다.
export function rangeCharLimit(seconds: number): number {
  const { VOICE_GAP_SEC: gapSec, NARRATION_MAX_CHARS_PER_SEC: maxRate } = thresholds();
  return Math.floor((seconds - gapSec) * maxRate);
}
// 프롬프트의 대략적인 문장 시간표. 실제 타이밍을 수정하지 않는다.
export function minSentenceSec(chars: number): number {
  let seconds = 1;
  while (rangeCharLimit(seconds) < chars) seconds++;
  return seconds;
}
// 초당 8.5자(임계값 NARRATION_MIN_CHARS_PER_SEC)보다 느린 문장은 검토용 경고를 남긴다.
export function maxSentenceSec(chars: number): number {
  return Math.max(1, Math.ceil(chars / thresholds().NARRATION_MIN_CHARS_PER_SEC));
}
// 컷 화면에 숫자로 보이는 것: 자막·모션그래픽 글줄의 모든 숫자 + 구도 설명의 제품 수량.
// 보이는 숫자 수집은 픽스처·통계에도 쓰인다. 화면 숫자에 발화를 강제하지 않는다.
export function shownDigitGroups(cut: {
  readonly screenComposition: string;
  readonly onScreenText: string;
  readonly graphicLines: readonly string[];
}): Set<string> {
  const shown = digitGroups([cut.onScreenText, ...cut.graphicLines].join("\n"));
  for (const match of cut.screenComposition.matchAll(PRODUCT_QUANTITY)) {
    const digits = match[1];
    if (digits) shown.add(digits);
  }
  return shown;
}
// 글에 들어 있는 표의 낱말(행 번호). 한글·영문 어느 표기든 하나만 있으면 그 낱말이 있는 것이다.
export function narrationTerms(text: string): number[] {
  const body = compact(text);
  const rows: number[] = [];
  NARRATION_TERM_TABLE.forEach((aliases, index) => {
    if (aliases.some((alias) => body.includes(compact(alias)))) rows.push(index);
  });
  return rows;
}
// 컷 화면이 보여 주는 글: 구도 설명 + 자막 + 모션그래픽 글줄.
export function cutShownText(cut: {
  readonly screenComposition: string;
  readonly onScreenText: string;
  readonly graphicLines: readonly string[];
}): string {
  return [cut.screenComposition, cut.onScreenText, ...cut.graphicLines].join("\n");
}
// 제품 낱말 대조에 쓸 가설 쪽 사실 글(인용문·증거·신호). 서버는 여기에 자료 본문(evidence pack)을 더한다.
export function hypothesisFactTexts(hypothesis: {
  readonly claimCitations: readonly { readonly quote: string }[];
  readonly proofShown?: string | undefined;
  readonly difference: string;
  readonly message: string;
  readonly signals?:
    | {
        readonly mechanism: { readonly statement: string };
        readonly offer: { readonly statement: string };
      }
    | undefined;
}): string[] {
  return [
    ...hypothesis.claimCitations.map((item) => item.quote),
    hypothesis.proofShown ?? "",
    hypothesis.difference,
    hypothesis.message,
    hypothesis.signals?.mechanism.statement ?? "",
    hypothesis.signals?.offer.statement ?? "",
  ].filter((text) => text.length > 0);
}
type AlignmentCut = CutTime & {
  readonly purpose: string;
  readonly screenComposition: string;
  readonly onScreenText: string;
  readonly graphicLines: readonly string[];
};
type AlignmentVoice = RangedLine & { readonly purpose: string };
// hard: 잘못된 범위·겹침, 말한 숫자가 해당 컷 묶음에 없음.
// soft: 말 없는 컷·추정 속도·같은 제품 낱말의 부재. 의미 일치는 AI 검토가 판단한다.
// 목적 일치와 화면 숫자의 역방향 발화 요구는 하지 않는다.
export function alignmentProblems(
  script: {
    readonly cuts: readonly AlignmentCut[];
    readonly voiceover: readonly AlignmentVoice[];
  },
  facts: readonly string[] = [],
  severity: "hard" | "soft" = "hard",
): string[] {
  const { cuts, voiceover } = script;
  const problems: string[] = [];
  const { SILENT_CUTS_MAX: silentMax, NARRATION_MAX_CHARS_PER_SEC: maxRate } = thresholds();
  const factTerms = new Set(narrationTerms(facts.join("\n")));
  const owner = new Map<number, number>();
  let previousTo = -1;
  let previousIndex = -1;
  voiceover.forEach((voice, index) => {
    const where = `${index + 1}번째 문장`;
    const quote = `"${voice.text}"`;
    const declared = voice.fromCut >= 0 || voice.toCut >= 0;
    if (
      declared &&
      (voice.fromCut < 0 ||
        voice.toCut < voice.fromCut ||
        voice.toCut >= cuts.length ||
        voice.fromCut >= cuts.length)
    ) {
      if (severity === "hard")
        problems.push(
          `${where} ${quote}: 컷 범위 fromCut ${voice.fromCut}~toCut ${voice.toCut}가 잘못됐습니다(컷은 0~${cuts.length - 1}번, fromCut ≤ toCut).`,
        );
      return;
    }
    const range = voiceCutRange(voice, cuts);
    if (!range) return;
    const [from, to] = range;
    const rangeLabel = `컷[${from}~${to}]`;
    if (from <= previousTo) {
      if (severity === "hard")
        problems.push(
          `${where} ${quote}: ${previousIndex + 1}번째 문장과 컷을 겹쳐 씁니다(${rangeLabel}, 앞 문장은 컷[${previousTo}]까지). 문장은 순서대로, 컷 하나는 한 문장에만 묶으세요.`,
        );
    } else if (severity === "soft" && from - previousTo - 1 > silentMax) {
      problems.push(
        previousIndex < 0
          ? `${where} 앞에 말 없는 컷이 ${from}개입니다(컷[0~${from - 1}], 최대 ${silentMax}개). 첫 문장을 더 앞 컷에서 시작하세요.`
          : `${previousIndex + 1}번째 문장(컷[${previousTo}]까지)과 ${where}(컷[${from}]부터) 사이에 말 없는 컷이 ${from - previousTo - 1}개입니다(최대 ${silentMax}개).`,
      );
    }
    for (let k = from; k <= to; k++) if (!owner.has(k)) owner.set(k, index);
    previousTo = Math.max(previousTo, to);
    previousIndex = index;
    const covered = cuts.slice(from, to + 1);
    const first = cuts[from];
    const last = cuts[to];
    if (severity === "soft" && first && last) {
      const seconds = last.endSec - first.startSec;
      // 오차 없이 초당 상한 × 범위 초. 더 받으면 fitVoiceover 가 저장 시간을 늘려 컷과 어긋나고,
      // 렌더 타임라인은 컷 끝에서 창을 닫으므로 합성 뒤 초과(템포 재합성·컷 연장)가 난다.
      const limit = rangeCharLimit(seconds);
      const length = [...voice.text].length;
      if (length > limit)
        problems.push(
          `${where} ${quote}이 ${length}자인데 묶인 ${rangeLabel}(${seconds}초)에는 ${limit}자까지 들어갑니다. 컷 범위를 늘리거나 문장을 줄이세요(문장은 초당 ${maxRate}자).`,
        );
    }
    const shown = covered.map(cutShownText).join("\n");
    const shownDigits = digitGroups(shown);
    for (const digits of digitGroups(voice.text))
      if (severity === "hard" && !shownDigits.has(digits))
        problems.push(
          `${where} ${quote}이 말하는 숫자 ${digits}가 묶인 ${rangeLabel}의 화면(구도·자막·글줄)에 없습니다. 그 숫자를 보여 주는 컷을 범위에 넣거나 문장에서 빼세요.`,
        );
    const shownTerms = new Set(narrationTerms(shown));
    for (const row of narrationTerms(voice.text)) {
      if (severity !== "soft" || !factTerms.has(row) || shownTerms.has(row)) continue;
      const term = NARRATION_TERM_TABLE[row]?.[0] ?? "";
      problems.push(
        `${where} ${quote}이 말하는 "${term}"이 묶인 ${rangeLabel}의 화면(구도·자막·글줄)에 없습니다. 그 낱말을 보여 주는 컷을 범위에 넣거나 문장을 바꾸세요.`,
      );
    }
  });
  // 끝의 말 없는 컷: 마지막 행동 유도 컷은 말이 없어도 된다.
  const lastIndex = cuts.length - 1;
  const trailingEnd = cuts[lastIndex]?.purpose === "cta" ? lastIndex - 1 : lastIndex;
  const trailing = trailingEnd - previousTo;
  if (severity === "soft" && voiceover.length > 0 && previousTo >= 0 && trailing > silentMax)
    problems.push(
      `마지막 문장(컷[${previousTo}]까지) 뒤에 말 없는 컷이 ${trailing}개입니다(컷[${previousTo + 1}~${trailingEnd}], 최대 ${silentMax}개, 마지막 cta 컷은 예외).`,
    );
  return problems;
}

// 내레이션 전체 글자 수(공백 포함). Typecast는 1자=1크레딧이라 비용 추정·크레딧 선검사에 같이 쓴다.
export function voiceoverChars(script: Pick<VideoScript, "voiceover">): number {
  return script.voiceover.reduce((sum, voice) => sum + [...voice.text].length, 0);
}

// 대본 다이제스트용 JSON. 정지 이미지 소스가 생기기 전에 저장된 대본은 stills·stillId 가 없었고,
// 컷 묶음이 생기기 전의 음성 문장은 fromCut/toCut/purpose 가 없었으므로, 기본값(빈 배열·빈 문자열·-1)인 필드는
// 빼고 직렬화해 예전 대본의 다이제스트(내레이션 합성 기록·승인 기록)가 그대로 유지되게 한다. 키 순서는 보존한다.
// 장면 계획(2026-10-06)으로 생긴 goal·phase(컷)·callouts(문장)·plan(클립)·graphicOrder(설명 컷)·subjects 도 기본값이면 뺀다.
// 설명 컷의 infoLines·motionPrompt 는 예전에는 항상 채워져 있었으므로 비어 있을 때만 뺀다.
// 혼합형(2026-10-07)의 explainerAnchor(대본)·sceneType/objects/actions/emphasis(설명 컷)도 기본값이면 뺀다.
export function scriptDigestJson(script: VideoScript): string {
  const emptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;
  const withoutDefaults = (
    record: Record<string, unknown>,
    isDefault: (key: string, value: unknown) => boolean,
  ) => Object.fromEntries(Object.entries(record).filter(([key, value]) => !isDefault(key, value)));
  const clipDefaults = (key: string, value: unknown) =>
    (key === "plan" && isClipPlanEmpty(value as ClipPlan)) ||
    ((key === "graphicOrder" ||
      key === "infoLines" ||
      key === "objects" ||
      key === "actions" ||
      key === "emphasis") &&
      emptyArray(value)) ||
    ((key === "motionPrompt" || key === "sceneType") && value === "");
  const entries = Object.entries(script)
    .filter(
      ([key, value]) =>
        !(
          ((key === "stills" ||
            key === "fixedTitle" ||
            key === "infoClips" ||
            key === "subjects") &&
            emptyArray(value)) ||
          ((key === "disclaimer" ||
            key === "voicePersona" ||
            key === "explainerAnchor" ||
            key === "flow") &&
            value === "")
        ),
    )
    .map(([key, value]): [string, unknown] => {
      switch (key) {
        case "cuts":
          return [
            key,
            script.cuts.map((cut) =>
              withoutDefaults(
                cut,
                (cutKey, cutValue) =>
                  (cutKey === "stillId" || cutKey === "goal" || cutKey === "phase") &&
                  cutValue === "",
              ),
            ),
          ];
        case "voiceover":
          return [
            key,
            script.voiceover.map((voice) =>
              withoutDefaults(
                voice,
                (voiceKey, voiceValue) =>
                  ((voiceKey === "fromCut" || voiceKey === "toCut") && voiceValue === -1) ||
                  ((voiceKey === "purpose" || voiceKey === "chainStep") && voiceValue === "") ||
                  (voiceKey === "callouts" && emptyArray(voiceValue)),
              ),
            ),
          ];
        case "veoClips":
          return [key, script.veoClips.map((clip) => withoutDefaults(clip, clipDefaults))];
        case "infoClips":
          return [key, script.infoClips.map((clip) => withoutDefaults(clip, clipDefaults))];
        default:
          return [key, value];
      }
    });
  return JSON.stringify(Object.fromEntries(entries));
}

export function videoScriptIsContinuous(script: VideoScript): boolean {
  let end = 0;
  for (const cut of script.cuts) {
    if (cut.startSec !== end || cut.endSec <= cut.startSec) return false;
    end = cut.endSec;
  }
  return end === script.durationSec;
}

// 영상 길이 목표(30~60초). 같은 광고안(타겟)의 첫 영상은 짧은 버전(30~40초), 두 번째부터는 같은 메시지를
// 더 깊게 푸는 긴 버전(45~60초)이다(CREATIVE-PLANNING-DESIGN.md 5절). 작업 ID·영상 번호로 정해 재실행해도 같다.
export const VIDEO_SHORT_MAX_SEC = DEFAULT_THRESHOLDS.VIDEO_SHORT_MAX_SEC;
export const VIDEO_LONG_MIN_SEC = DEFAULT_THRESHOLDS.VIDEO_LONG_MIN_SEC;
export function videoTargetSeconds(jobId: string, number: number, variantIndex = 0): number {
  let hash = 2166136261;
  for (const char of `${jobId}:${number}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // 짧은/긴 버전의 경계는 임계값(thresholds.json)이다. 같은 값이면 재실행해도 같은 길이가 나온다.
  const { VIDEO_SHORT_MAX_SEC: shortMax, VIDEO_LONG_MIN_SEC: longMin } = thresholds();
  const [min, max] = variantIndex > 0 ? [longMin, VIDEO_MAX_SEC] : [VIDEO_MIN_SEC, shortMax];
  return min + (hash % (max - min + 1));
}
/** 이 영상보다 앞 번호에서 같은 광고안을 쓴 영상 수(0이면 짧은 버전, 1 이상이면 긴 버전). */
export function videoVariantIndex(
  scripts: readonly { readonly number: number; readonly hypothesisId: string }[],
  number: number,
  hypothesisId: string,
): number {
  return scripts.filter((script) => script.number < number && script.hypothesisId === hypothesisId)
    .length;
}
