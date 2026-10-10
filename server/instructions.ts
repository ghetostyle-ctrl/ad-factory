import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EXPLAINER_ACTIONS_MAX,
  EXPLAINER_EMPHASIS_MAX,
  EXPLAINER_OBJECTS_MAX,
} from "../shared/explainer-scene";
import { CALLOUT_COLORS, TIMELINE_DEFAULTS } from "../shared/render-timeline";
import {
  setThresholds,
  THRESHOLD_NAMES,
  type ThresholdName,
  type Thresholds,
} from "../shared/thresholds";
import {
  CALLOUTS_MAX,
  CLIP_PHASE_RANGES_MS,
  CLIP_PHASES,
  CUT_GOAL_MAX_CHARS,
  INFO_CLIPS_MAX,
  SHOT_MIN_SEC,
  STILL_SHOTS_MAX,
  SUBJECTS_MAX,
  VEO_CLIP_SEC,
  VEO_SHOTS_MAX,
  VEO_STORED_SHOTS_MAX,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
} from "../shared/video-script";

// 지시 파일 로더(사용자 결정 2026-10-07: "창작 판단은 앱 안의 편집 가능한 지시 파일로, 계산과 상태는 코드로").
// - instructions/*.md 의 `## KEY` 절과 instructions/thresholds.json 의 숫자 임계값을 읽는다.
// - 생성 호출마다 load() 를 부르면 파일 mtime·크기를 보고 바뀐 경우에만 다시 읽는다(재시작·빌드 불필요).
// - 파싱·치환·범위 검증에 실패하면 마지막 성공본을 유지하고 warnings 에 한국어 메시지를 남긴다(onWarning 은 같은 원인에 1회).
//   첫 로드 실패는 InstructionsError 를 던진다(서버 기동 실패, 원인 출력).
// - 절 본문의 `{{NAME}}`(대문자)은 thresholds → 파생값(*_PERCENT 등) → 코드 고정 상수 순으로 로드 때 치환하고, 치환할 수 없으면
//   로드 오류다. `{{@KEY}}` 는 다른 절을 끼워 넣는다. `{{name}}`(소문자 포함)은 호출 시점 값이라 로드 때 그대로 두고
//   fillSection() 이 채운다(남으면 오류).
// - 산출물에는 digest(모든 파일의 sha256)와 loadedAt 을 기록한다(D5). 응답 JSON 칸 이름(스키마)은 코드에 남는다.

export const INSTRUCTION_FILES = [
  "planning.md",
  "script.md",
  "hybrid.md",
  "immersive.md",
  "review.md",
  "copy.md",
  "copy-first.md",
  "flow.md",
  "examples.md",
] as const;
export type InstructionFile = (typeof INSTRUCTION_FILES)[number];
// 코드가 실제로 읽는 파일(2026-10-07 구현 단계). flow.md 는 Flow·Veo·이미지 프롬프트 문장(server/flow-instructions.ts flowTexts)이다 —
// shared 의 조립 함수는 글을 인자로만 받고 화면은 서버가 조립한 flow-export 를 받는다.
export const WIRED_INSTRUCTION_FILES: readonly InstructionFile[] = [
  "planning.md",
  "script.md",
  "hybrid.md",
  "immersive.md",
  "review.md",
  "copy.md",
  "copy-first.md",
  "flow.md",
  "examples.md",
];
export const THRESHOLDS_FILE = "thresholds.json";

// --- 임계값(thresholds.json) --------------------------------------------------------------------------------
// 파일에서 고칠 수 있는 숫자. 이름·기본값은 shared/thresholds.ts(브라우저 번들도 쓰는 기본값 + setThresholds 주입)에 있고,
// zod `.max()`·enum·literal 에 묶인 값(VEO_SHOTS_MAX 등)은 코드 고정이라 여기 없고 CODE_CONSTANTS 에 있다.
export { THRESHOLD_NAMES, type ThresholdName, type Thresholds } from "../shared/thresholds";
export const ThresholdEntrySchema = z
  .object({
    value: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    description: z.string().trim().min(1),
  })
  .strict();
export type ThresholdEntry = z.infer<typeof ThresholdEntrySchema>;
// 항목 사이의 관계(한 값만 고쳐 다른 규칙과 어긋나지 않도록).
const THRESHOLD_RELATIONS: readonly (readonly [ThresholdName, "<" | "<=", ThresholdName])[] = [
  ["COPY_BEAT_TARGET_CHARS", "<=", "COPY_BEAT_MAX_CHARS"],
  ["NARRATION_MIN_CHARS_PER_SEC", "<=", "NARRATION_TARGET_CHARS_PER_SEC"],
  ["NARRATION_TARGET_CHARS_PER_SEC", "<=", "NARRATION_MAX_CHARS_PER_SEC"],
  ["HYBRID_ENDING_IMAGE_MAX_SEC", "<=", "CUT_MAX_SEC"],
  ["CAPTION_MIN_CHARS", "<=", "CAPTION_LINE_MAX_CHARS"],
  ["CAPTION_MIN_MS", "<=", "CAPTION_MAX_MS"],
  ["VIDEO_SHORT_MAX_SEC", "<", "VIDEO_LONG_MIN_SEC"],
  ["INFO_GRAPHIC_BAND_TOP", "<", "INFO_GRAPHIC_BAND_BOTTOM"],
];
export const ThresholdsFileSchema = z
  .record(z.string(), ThresholdEntrySchema)
  .superRefine((entries, ctx) => {
    for (const name of THRESHOLD_NAMES)
      if (!(name in entries))
        ctx.addIssue({ code: "custom", message: `임계값 ${name} 항목이 없습니다.` });
    for (const [name, entry] of Object.entries(entries)) {
      if (!(THRESHOLD_NAMES as readonly string[]).includes(name))
        ctx.addIssue({
          code: "custom",
          message: `알 수 없는 임계값 ${name} 입니다(코드가 쓰지 않음).`,
        });
      if (entry.min > entry.max)
        ctx.addIssue({
          code: "custom",
          message: `임계값 ${name} 의 min(${entry.min})이 max(${entry.max})보다 큽니다.`,
        });
      if (entry.value < entry.min || entry.value > entry.max)
        ctx.addIssue({
          code: "custom",
          message: `임계값 ${name} = ${entry.value} 가 허용 범위 [${entry.min}, ${entry.max}] 밖입니다.`,
        });
    }
    for (const [left, op, right] of THRESHOLD_RELATIONS) {
      const a = entries[left]?.value;
      const b = entries[right]?.value;
      if (a === undefined || b === undefined) continue;
      if (op === "<" ? !(a < b) : !(a <= b))
        ctx.addIssue({
          code: "custom",
          message: `임계값 ${left}(${a}) ${op} ${right}(${b}) 이어야 합니다.`,
        });
    }
  });
export function thresholdsOf(entries: Record<string, ThresholdEntry>): Thresholds {
  const out: Partial<Record<ThresholdName, number>> = {};
  for (const name of THRESHOLD_NAMES) {
    const entry = entries[name];
    if (entry) out[name] = entry.value;
  }
  return out as Thresholds;
}
export type ThresholdEntries = Readonly<Record<ThresholdName, ThresholdEntry>>;
// 파일의 항목(값·범위·설명)을 그대로 돌려준다 — 상태 API·카드가 허용 범위와 설명을 보여 주는 데 쓴다.
export function parseThresholdEntries(text: string, file = THRESHOLDS_FILE): ThresholdEntries {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new InstructionsError([`${file}: JSON 이 아닙니다 — ${(error as Error).message}`]);
  }
  const parsed = ThresholdsFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new InstructionsError(parsed.error.issues.map((issue) => `${file}: ${issue.message}`));
  const out: Partial<Record<ThresholdName, ThresholdEntry>> = {};
  for (const name of THRESHOLD_NAMES) {
    const entry = parsed.data[name];
    if (entry) out[name] = entry;
  }
  return out as ThresholdEntries;
}
export function parseThresholds(text: string, file = THRESHOLDS_FILE): Thresholds {
  return thresholdsOf(parseThresholdEntries(text, file));
}

// --- 코드 고정 상수(토큰으로만 쓴다; 값은 코드가 결정) ---------------------------------------------------------------
export const PHASE_TABLE = CLIP_PHASES.map(
  (phase) =>
    `${phase} ${CLIP_PHASE_RANGES_MS[phase][0] / 1000}–${CLIP_PHASE_RANGES_MS[phase][1] / 1000}s`,
).join(", ");
export const CODE_CONSTANTS: Readonly<Record<string, number | string>> = {
  VIDEO_MIN_SEC,
  VIDEO_MAX_SEC,
  SHOT_MIN_SEC,
  VEO_SHOTS_MAX,
  VEO_STORED_SHOTS_MAX,
  VEO_CLIP_SEC,
  STILL_SHOTS_MAX,
  INFO_CLIPS_MAX,
  CUT_GOAL_MAX_CHARS,
  SUBJECTS_MAX,
  CALLOUTS_MAX,
  EXPLAINER_OBJECTS_MAX,
  EXPLAINER_ACTIONS_MAX,
  EXPLAINER_EMPHASIS_MAX,
  CALLOUT_COLORS,
  TIMELINE_MAX_TEMPO: TIMELINE_DEFAULTS.maxTempo,
  PHASE_TABLE,
};
// 파생 토큰: 비율 → 퍼센트(프롬프트가 "40%" 로 적는 자리), 밀리초 → 초(프롬프트가 "0.5 seconds" 로 적는 자리), 띠 아래 여백.
export function derivedTokens(thresholds: Thresholds): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of THRESHOLD_NAMES) {
    if (name.endsWith("_RATIO"))
      out[`${name.slice(0, -"_RATIO".length)}_PERCENT`] = Math.round(thresholds[name] * 100);
    if (name.endsWith("_MS")) out[`${name.slice(0, -"_MS".length)}_SEC`] = thresholds[name] / 1000;
  }
  out["INFO_GRAPHIC_BAND_BOTTOM_FREE"] = 100 - thresholds.INFO_GRAPHIC_BAND_BOTTOM;
  return out;
}

// --- 절(section) 등록부: 어느 파일의 어느 절이 어느 코드 조각을 대체하는지 ------------------------------------------------
export type InstructionSection = {
  readonly file: InstructionFile;
  readonly key: string;
  // 절 본문이 JSON 이면 로드 때 파싱을 검증하고 sectionJson() 으로 꺼낸다(JSON.stringify 로 예전 상수와 같은 바이트가 된다).
  readonly json?: boolean;
  // 호출 시점에 채우는 소문자 토큰(fillSection). 로드 때는 남겨 둔다.
  readonly runtime?: readonly string[];
  // 어느 함수의 어느 상수/조각을 대체하는지(README 표의 '어디서 쓰임').
  readonly usedIn: string;
  // 바꾸면 무엇이 달라지는지(README 표).
  readonly effect: string;
  readonly note?: string;
};
const section = (
  file: InstructionFile,
  key: string,
  usedIn: string,
  effect: string,
  extra: Partial<Pick<InstructionSection, "json" | "runtime" | "note">> = {},
): InstructionSection => ({ file, key, usedIn, effect, ...extra });
const PLANNING = "server/video-planning.ts videoPlanningInstructions";
const COPY_EDIT = "server/video-planning.ts prepareVideoPlanning(video_copy_editing)";
const SOURCE = "server/source-planning.ts SourcePlanner.plan";
const SCRIPT = "server/script-instructions.ts videoScriptInstructions";
const REVIEW = "server/video-scripts.ts reviewVideoScript";
const HYBRID = "server/hybrid-script-instructions.ts";
const COPY_FIRST_COPY = "server/copy-writer.ts generateVideoCopy (편지 1)";
const COPY_FIRST_SCENE = "server/video-scripts.ts generateVideoScript copyLines 있을 때 (편지 2)";
const FLOW =
  "shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음)";
export const INSTRUCTION_SECTIONS: readonly InstructionSection[] = [
  // planning.md — 기획(video_planning)·카피 교정·자료 기획(source_creative_plan)
  section(
    "planning.md",
    "PLANNING_OPENING",
    `${PLANNING} PLANNING_OPENING`,
    "기획 프롬프트 첫 문단(길이 30–60초 선택·말 속도 안내)",
  ),
  section(
    "planning.md",
    "PLANNING_TARGET_AND_SOLUTION",
    `${PLANNING} TARGET_AND_SOLUTION`,
    "타겟·해결 경로(solutionPath) 전개 규칙",
  ),
  section("planning.md", "PLANNING_AUDIENCE", `${PLANNING} AUDIENCE`, "시청자 분석 항목"),
  section("planning.md", "PLANNING_CONCEPT", `${PLANNING} CONCEPT`, "영상 콘셉트 설계 규칙"),
  section(
    "planning.md",
    "PLANNING_DECISIONS",
    `${PLANNING} DECISIONS`,
    "viewerChange·mutedMessage·stopReason 결정 규칙",
  ),
  section(
    "planning.md",
    "PLANNING_COPY",
    `${PLANNING} COPY`,
    "기획 단계 카피 초안 규칙(구어체·사실 한정·경쟁 후기 경계)",
  ),
  section(
    "planning.md",
    "COPY_EDITING_OPENING",
    `${COPY_EDIT} 첫 문단`,
    "카피 교정 역할·보존 기준",
  ),
  section(
    "planning.md",
    "COPY_EDITING_LINE_RULE",
    `${COPY_EDIT} 둘째 문단`,
    "줄 수 고정·수정 기록 형식",
    { runtime: ["lineCount"] },
  ),
  section(
    "planning.md",
    "COPY_EDITING_RHYTHM_NOTE",
    `${COPY_EDIT} 끝 문단`,
    "리듬 교정 허용 범위(줄 분할 금지)",
  ),
  section(
    "planning.md",
    "SOURCE_PLAN_GUARD",
    `${SOURCE} guard (reference_structure·source_creative_plan·creative_plan_critique 공통 머리)`,
    "자료 기획 3개 프롬프트의 공통 경계 문장",
  ),
  section(
    "planning.md",
    "SOURCE_REFERENCE_STRUCTURE",
    `${SOURCE} reference_structure`,
    "레퍼런스 구조 관찰 지시(관찰/추정/미확인 분리)",
  ),
  section(
    "planning.md",
    "SOURCE_CREATIVE_PLAN",
    `${SOURCE} source_creative_plan`,
    "조각·타겟·고객 질문·설득 사슬·퍼널 신호·카드뉴스 등 기획 본문",
    { runtime: ["imageCount"] },
  ),
  section(
    "planning.md",
    "SOURCE_PLAN_CRITIQUE",
    `${SOURCE} creative_plan_critique`,
    "기획 검토 기준(근거·다양성·사슬 a0~f)",
    { runtime: ["imageCount", "singleConceptNote"] },
  ),
  section(
    "planning.md",
    "SOURCE_PLAN_CRITIQUE_SINGLE_CONCEPT",
    `${SOURCE} critique imageCount===1 분기`,
    "광고안 1개일 때 다양성 요구를 끄는 문장",
    { note: "원문은 끝에 공백 한 칸이 있다 — 코드가 붙인다." },
  ),
  section(
    "planning.md",
    "SOURCE_PLAN_RETRY_HINT",
    `${SOURCE} critique revise 뒤 feedback 꼬리`,
    "사슬이 어느 제품에나 맞는다는 지적을 받았을 때 타겟을 바꾸라는 지시",
  ),
  section(
    "planning.md",
    "SOURCE_VOICE_ROLE_COMPETITOR",
    `${SOURCE} DATA.voices[].role (reviewOf=competitor)`,
    "경쟁 제품 후기의 사용 경계(고객 고통·실패·망설임에만, 우리 증거·비방 금지)",
  ),
  section(
    "planning.md",
    "SOURCE_VOICE_ROLE_OWN",
    `${SOURCE} DATA.voices[].role (reviewOf=own)`,
    "우리 제품 후기의 사용 범위(후기에 있는 내용만 넓혀 쓰기)",
  ),
  section(
    "planning.md",
    "SOURCE_VOICE_ROLE_UNKNOWN",
    `${SOURCE} DATA.voices[].role (reviewOf 없음)`,
    "출처 불명 고객 말의 사용 경계(증거·일반화 금지)",
  ),
  section(
    "planning.md",
    "PLANNING_CONTEXT_ASSET_NOTE",
    "server/video-planning-context.ts videoPlanningContext visualAssets.note (기획·카피 교정·대본 생성·검토 DATA 공통)",
    "화면 소스가 AI 생성물이며 생성 포장이 실제 라벨을 재현하지 못한다는 안내",
  ),
  // script.md — 대본 공통(정책 분기 각각의 문구는 따로 절)
  section("script.md", "SCRIPT_OPENING", `${SCRIPT} 첫 줄`, "대본 형식·길이 안내", {
    runtime: ["seconds"],
  }),
  section(
    "script.md",
    "SCRIPT_SHAPE",
    `${SCRIPT} SHAPE`,
    "응답 구조 설명(subjects → 소스 → 문장·컷)",
  ),
  section(
    "script.md",
    "SCRIPT_PACING_HEAD",
    `${SCRIPT} PACING 첫 문장`,
    "한 문장 = 한 호흡(목표·한도 글자 수)",
  ),
  section(
    "script.md",
    "SCRIPT_PACING_BEATS_DEFAULT",
    `${SCRIPT} PACING 비트 분리(legacy·hybrid)`,
    "상황·반전·감정을 짧은 문장으로 끊는 지시",
  ),
  section(
    "script.md",
    "SCRIPT_PACING_SPEECH_DEFAULT",
    `${SCRIPT} pacing(legacy·hybrid)`,
    "초당 글자 수 목표와 참고 범위",
  ),
  section("script.md", "SCRIPT_PACING_CAPACITY", `${SCRIPT} table`, "글자 수 → 초 환산표 안내", {
    runtime: ["table"],
  }),
  section(
    "script.md",
    "SCRIPT_PACING_TAIL",
    `${SCRIPT} PACING 끝`,
    "짧은 문장 + 긴 동작 컷 허용, 채우기 금지",
  ),
  section(
    "script.md",
    "SCRIPT_SCENES",
    `${SCRIPT} SCENES`,
    "컷 정의·길이 상한·분할 기준·goal·효과 목록",
    { runtime: ["maxCutSec", "explainerCutNote"] },
  ),
  section(
    "script.md",
    "SCRIPT_SUBJECTS",
    `${SCRIPT} SUBJECTS`,
    "등장 대상 선언과 traits 전파 규칙",
    { runtime: ["hybridSubjectsNote"] },
  ),
  section(
    "script.md",
    "SCRIPT_CLEAN_KEYFRAMES",
    `${SCRIPT} CLEAN KEYFRAMES`,
    "깨끗한 키프레임 규칙(글자·화살표 금지, 빈 공간)",
    { runtime: ["cleanBaseClause"] },
  ),
  section(
    "script.md",
    "SCRIPT_CLEAN_BASE_DEFAULT",
    `${SCRIPT} CLEAN KEYFRAMES 비-hybrid 분기`,
    "설명 컷 cleanPrompt 가 3D 기본 장면일 수 있다는 문장",
  ),
  section(
    "script.md",
    "SCRIPT_CLIP_PLAN",
    `${SCRIPT} CLIP PLAN`,
    "클립 3구간 계획(camera·action) 규칙",
  ),
  section("script.md", "SCRIPT_CONTINUITY", `${SCRIPT} CONTINUITY`, "장면 연속성 규칙"),
  section(
    "script.md",
    "SCRIPT_MATCH_KEY_CONTENT",
    `${SCRIPT} MATCH KEY CONTENT`,
    "말한 사실·숫자가 화면에 있어야 한다는 규칙",
  ),
  section(
    "script.md",
    "SCRIPT_STRUCTURE",
    `${SCRIPT} STRUCTURE`,
    "콘셉트 전개·scenePlan 소스 대응",
    { runtime: ["structureHybridNote"] },
  ),
  section(
    "script.md",
    "SCRIPT_CHAIN_RULE",
    `${SCRIPT} chainRule(사슬 있음)`,
    "설득 사슬 ①~⑥·결과·행동 문장 규칙",
  ),
  section(
    "script.md",
    "SCRIPT_NO_CHAIN_RULE",
    `${SCRIPT} chainRule(사슬 없음)`,
    "예전 기획의 chainStep bridge 지시",
  ),
  section("script.md", "SCRIPT_OFFER_ALLOWED", `${SCRIPT} offerAllowed 참`, "오퍼 문장 허용 조건"),
  section("script.md", "SCRIPT_OFFER_NONE", `${SCRIPT} offerAllowed 거짓`, "오퍼 지어내기 금지"),
  section("script.md", "SCRIPT_VOICE", `${SCRIPT} VOICE`, "내레이션 말투·영문 금지·인물 금지·CTA"),
  section(
    "script.md",
    "AD_CAPTION_DIRECTION_RULES",
    "영상 장면 기획",
    "상황별 서체·핵심어·아이콘 연출",
  ),
  section("script.md", "SCRIPT_CAPTIONS", `${SCRIPT} CAPTIONS`, "자막 길이·끊기 규칙"),
  section(
    "script.md",
    "SCRIPT_CALLOUTS",
    `${SCRIPT} CALLOUTS`,
    "콜아웃 개수·word·text·kind·anchor 규칙. 콜아웃 문구 금지어는 여기(생성)와 REVIEW_RULE_14(검토)에 프롬프트 지시로 적는다",
    {
      runtime: ["calloutsHybridNote"],
      note: "코드 검사(shared/script-rules.ts 콜아웃 검사)는 word 가 문장 어절인지·영문·숫자만 본다 — 금지어 목록은 코드에 없다(프롬프트 지시만).",
    },
  ),
  section("script.md", "SCRIPT_SNAP_ZOOM", `${SCRIPT} SNAP ZOOM`, "zoom_punch 간격 규칙"),
  section("script.md", "SCRIPT_LAYOUT", `${SCRIPT} LAYOUT`, "고정 제목·면책 규칙"),
  section(
    "script.md",
    "SCRIPT_SOURCES",
    `${SCRIPT} SOURCES`,
    "소스 선택 규칙(veo/still/approved_image/card/project_clip)",
    { runtime: ["approvedImageRule", "projectClipRule"] },
  ),
  section(
    "script.md",
    "SCRIPT_SOURCES_APPROVED_IMAGE_LEGACY",
    `${SCRIPT} SOURCES legacy 분기`,
    "대표 이미지 1회 이상 필수",
  ),
  section(
    "script.md",
    "SCRIPT_SOURCES_PROJECT_CLIP_YES",
    `${SCRIPT} SOURCES hasClips 참`,
    "촬영본 우선 사용",
  ),
  section(
    "script.md",
    "SCRIPT_SOURCES_PROJECT_CLIP_NO",
    `${SCRIPT} SOURCES hasClips 거짓`,
    "project_clip 금지",
  ),
  section("script.md", "SCRIPT_VEO", `${SCRIPT} VEO`, "클립 수·프롬프트·비율 상한"),
  section("script.md", "SCRIPT_CUT_PHASE", `${SCRIPT} CUT PHASE`, "컷의 phase 선택 규칙", {
    runtime: ["cutPhasePolicyNote"],
  }),
  section(
    "script.md",
    "SCRIPT_CUT_PHASE_DEFAULT_NOTE",
    `${SCRIPT} CUT PHASE 비-hybrid 분기`,
    "early 구간 8초 전체 허용 문장",
  ),
  section("script.md", "SCRIPT_STILLS", `${SCRIPT} STILLS`, "정지 이미지 선언·재사용 규칙"),
  section(
    "script.md",
    "SCRIPT_GRAPHICS_DEFAULT",
    `${SCRIPT} graphicsRule(legacy·immersive)`,
    "모션그래픽 사용 조건·비율 상한",
  ),
  section(
    "script.md",
    "SCRIPT_INFO_CLIPS_LEGACY",
    `${SCRIPT} infoRule(legacy·immersive, Flow)`,
    "설명 컷(explanation·graphicOrder 방식) 규칙",
  ),
  section(
    "script.md",
    "SCRIPT_INFO_CLIPS_NONE",
    `${SCRIPT} infoRule(API 모드)`,
    "설명 컷 불가 문장",
  ),
  section(
    "script.md",
    "SCRIPT_FIELD_HYGIENE",
    `${SCRIPT} FIELD HYGIENE`,
    "빈 칸 규칙·flowPrompt·editInstructions",
  ),
  section(
    "script.md",
    "SCRIPT_REFERENCE_NOTE",
    `${SCRIPT} REFERENCE STRUCTURES`,
    "레퍼런스 예시 사용 경계",
  ),
  section("script.md", "SCRIPT_CLOSING", `${SCRIPT} 마지막 문장`, "사실 한정·레퍼런스는 증거 아님"),
  section(
    "script.md",
    "SCRIPT_FEEDBACK_PREFIX",
    `${SCRIPT} feedback 꼬리`,
    "직전 위반을 고치라는 머리말",
    { runtime: ["feedback"] },
  ),
  section(
    "script.md",
    "SCRIPT_USER_FEEDBACK_PREFIX",
    "server/script-writer.ts writeVideoScript userFeedback (다시 쓰기 피드백 머리말, 규칙 위반 feedback 앞에 붙음)",
    "사용자 피드백을 반드시 반영하라는 머리말",
    { runtime: ["feedback"] },
  ),
  section(
    "script.md",
    "SCRIPT_SHAPE_EXAMPLE_NOTE",
    `${SCRIPT} JSON SHAPE 뒤 예시 안내(칸 이름은 코드 고정)`,
    "예시 문장은 모양만이며 숫자·제품 낱말은 FACTS 에서 가져오라는 지시",
  ),
  // hybrid.md — 혼합형(hybrid_explainer_v1)
  section(
    "hybrid.md",
    "HYBRID_SCENE_PLAN",
    `${PLANNING} HYBRID_SCENE_PLAN`,
    "혼합형 기획 scenePlan 규칙",
  ),
  section(
    "hybrid.md",
    "HYBRID_VISUAL_CONTRACT",
    `${PLANNING} HYBRID_VISUAL_CONTRACT`,
    "혼합형 시각 계약(실사/설명 세계 분리, 엔딩)",
    { note: '"at most 3 seconds" 는 {{HYBRID_ENDING_IMAGE_MAX_SEC}} 토큰으로.' },
  ),
  section(
    "hybrid.md",
    "EXPLAINER_GRAMMAR",
    `${HYBRID} EXPLAINER_GRAMMAR`,
    "설명 세계 문법 R1~R9(R8 강조색 출처 = 브랜드·포장, R3 윤곽선 red)",
    {
      note: '브랜드 강조색을 특정 색으로 고정하려면 R8 의 "from the brand or packaging" 과 HYBRID_PLANNING_RULES·HYBRID_SCRIPT_RULES 의 같은 문장을 함께 바꾼다. 색 이름은 영문(blue, orange …)으로 — 코드 검사(shared/hybrid-script-rules.ts COLOR_WORDS, explainerAnchor 에 영문 색 2개 이상)가 한글 색 이름을 모른다. 윤곽 강조색 red 는 R3 와 flow.md EMPHASIS_OUTLINE 두 곳.',
    },
  ),
  section(
    "hybrid.md",
    "HYBRID_PLANNING_RULES",
    `${HYBRID} HYBRID_PLANNING_RULES`,
    "혼합형 기획 explainerScene 규칙(끝에 {{@EXPLAINER_GRAMMAR}}; 강조색 2개를 브랜드·포장에서 고르라는 문장 포함)",
    { note: "강조색 고정은 EXPLAINER_GRAMMAR 의 주의와 같다." },
  ),
  section(
    "hybrid.md",
    "HYBRID_SCRIPT_RULES",
    `${HYBRID} HYBRID_SCRIPT_RULES`,
    "혼합형 제작 계약(비트→소스, 두 기준(TWO ANCHORS 의 강조색 문장), 설명 장면, 컷, 글자, 콜아웃, 엔딩)",
    {
      runtime: ["hybridExample"],
      note: "끝 예시 JSON 은 examples.md HYBRID_EXPLAINER_EXAMPLE 을 코드가 stringify 해 채운다. 강조색 고정은 EXPLAINER_GRAMMAR 의 주의와 같다.",
    },
  ),
  section(
    "hybrid.md",
    "HYBRID_REVIEW_RULES",
    `${HYBRID} HYBRID_REVIEW_RULES → ${REVIEW} 규칙 1c`,
    "검토 규칙 1c(혼합형 계약 위반 a~g)",
  ),
  section(
    "hybrid.md",
    "HYBRID_REVIEW_GRAMMAR_INTRO",
    `${REVIEW} 규칙 15(hybrid) 첫 줄`,
    "설명 세계 문법 검토 지시(뒤에 {{@EXPLAINER_GRAMMAR}} 를 코드가 붙임)",
  ),
  section("hybrid.md", "HYBRID_INFO_RULE", `${SCRIPT} HYBRID_INFO_RULE`, "혼합형 INFO CLIPS 절"),
  section(
    "hybrid.md",
    "HYBRID_SCENES_EXPLAINER_NOTE",
    `${SCRIPT} SCENES hybrid 분기`,
    "설명 컷 2–N초 문장",
    { note: "원문 앞에 공백 한 칸 — 코드가 붙인다." },
  ),
  section(
    "hybrid.md",
    "HYBRID_SUBJECTS_NOTE",
    `${SCRIPT} SUBJECTS hybrid 분기`,
    "설명 물체도 subjects 라는 문장",
  ),
  section(
    "hybrid.md",
    "HYBRID_CLEAN_BASE_CLAUSE",
    `${SCRIPT} CLEAN KEYFRAMES hybrid 분기`,
    "cleanPrompt 가 설명 세계 기본 장면이라는 구절",
  ),
  section(
    "hybrid.md",
    "HYBRID_STRUCTURE_NOTE",
    `${SCRIPT} STRUCTURE hybrid 분기`,
    "graphic 장면 없음 구절",
  ),
  section(
    "hybrid.md",
    "HYBRID_CALLOUTS_NOTE",
    `${SCRIPT} CALLOUTS hybrid 분기`,
    "콜아웃은 실사 문장에만",
  ),
  section(
    "hybrid.md",
    "HYBRID_SOURCES_APPROVED_IMAGE",
    `${SCRIPT} SOURCES hybrid 분기`,
    "대표 이미지 선택적·엔딩 N초 이내",
  ),
  section(
    "hybrid.md",
    "HYBRID_CUT_PHASE_NOTE",
    `${SCRIPT} CUT PHASE hybrid 분기`,
    "설명 컷은 한 구간·8초 보유 금지",
  ),
  section(
    "hybrid.md",
    "HYBRID_GRAPHICS_RULE",
    `${SCRIPT} graphicsRule(hybrid)`,
    "모션그래픽 금지 문장",
  ),
  section(
    "flow.md",
    "HYBRID_LIVE_TAIL",
    "shared/veo-prompt.ts clipPrompt liveAction (texts.HYBRID_LIVE_TAIL)",
    "실사 클립 꼬리(사람·실제 장소·클레이 모형 아님)",
  ),
  // immersive.md — 입체 설명(immersive_explanations_v1, 2026-10-06 정책 보존)
  section(
    "immersive.md",
    "IMMERSIVE_SCENE_PLAN",
    `${PLANNING} IMMERSIVE_SCENE_PLAN`,
    "immersive 기획 scenePlan 규칙",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_VISUAL_CONTRACT",
    `${PLANNING} IMMERSIVE_VISUAL_CONTRACT`,
    "immersive 시각 계약(아이보리·올리브·골드)",
  ),
  section(
    "immersive.md",
    "EXPLANATION_PLANNING_RULES",
    "server/immersive-script-instructions.ts explanationPlanningRules",
    "설명 설계(entities·beats·annotations) 기획 규칙",
  ),
  section(
    "immersive.md",
    "EXPLANATION_SCRIPT_RULES",
    "server/immersive-script-instructions.ts explanationScriptRules",
    "설명 설계 대본 반영 규칙(actionSync·narrationCue)",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_SCRIPT_RULES",
    "server/immersive-script-instructions.ts immersiveScriptRules",
    "입체 설명 제작 계약(끝에 {{@EXPLANATION_SCRIPT_RULES}})",
    { note: "원문은 끝에 줄바꿈 하나가 있다 — 코드가 붙인다." },
  ),
  section(
    "immersive.md",
    "IMMERSIVE_REVIEW_CONTRACT_INTRO",
    `${REVIEW} 규칙 15(immersive) 첫 줄`,
    "입체 설명 계약 검토 지시(뒤에 {{@IMMERSIVE_SCRIPT_RULES}})",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_REVIEW_EXPLANATION",
    `${REVIEW} 규칙 16`,
    "설명 설계 검토 지시(뒤에 {{@EXPLANATION_SCRIPT_RULES}})",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_PACING_SPEECH",
    `${SCRIPT} pacing(immersive)`,
    "초당 6–8자 추정 안내",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_PACING_BEATS",
    `${SCRIPT} PACING 비트(immersive)`,
    "한 사건 한 생각 유지 문장",
  ),
  section(
    "immersive.md",
    "IMMERSIVE_SOURCES_APPROVED_IMAGE",
    `${SCRIPT} SOURCES immersive 분기`,
    "대표 이미지 선택적·INFO 엔딩 대체",
  ),
  // review.md — 대본 AI 검토(번호 절)
  section("review.md", "REVIEW_OPENING", `${REVIEW} 첫 문단`, "검토자 역할·듣고 보는 방식"),
  section("review.md", "REVIEW_RETURN_RULE", `${REVIEW} 둘째 문단`, "pass/revise 응답 규칙"),
  section(
    "review.md",
    "REVIEW_RHYTHM_IMMERSIVE",
    `${REVIEW} 규칙 1b(immersive)`,
    "natural_v1 리듬 검토",
  ),
  section(
    "review.md",
    "REVIEW_RHYTHM_DEFAULT",
    `${REVIEW} 규칙 1b(legacy·hybrid)`,
    "짧은 호흡 리듬 검토(약 N자)",
    { note: '"about 26 characters" 는 {{COPY_BEAT_TARGET_CHARS}} 토큰으로.' },
  ),
  // 검토 규칙 번호 절. 머리말(무엇을 보는 규칙인지)을 함께 적어 README 표에서 찾을 수 있게 한다.
  ...(
    [
      ["1", "자연스러운 한국어·메모체 금지·AI 말투(KOREAN AI-TELL RULES 적용)"],
      [
        "2",
        "설득(stopReason·mutedMessage·viewerChange·scenePlan·solutionPath 과정, 후크 약화 금지)",
      ],
      ["3", "의도·의미 보존(가설·콘셉트, 카피 교정 이력, 오퍼 허용 조건)"],
      ["4", "FACTS 밖 주장 금지(효능·후기·가격·기한·수상·성분·외형)"],
      ["5", "지어낸 인물 이름 금지"],
      ["6", "출처·ID·예:·FACT 낭독 금지, 내레이션 영문 금지(한글 표기)"],
      ["7", "자막·글줄과 내레이션 일치"],
      ["8", "같은 사실 3회 이상 반복 금지"],
      ["8B", "설득 사슬(①~⑥·결과·행동 순서, ⑥은 ⑤에 없는 세부, 사슬 밖 사실 금지, 설명서 말투)"],
      ["9", "핵심 내용 일치(말한 숫자·기능·행사가 그 문장의 컷에 보임)"],
      ["10", "시각 연속성(인물·옷·장소·소품·제품, I1~I3 설명 컷 취급)"],
      ["11", "자연스러운 강조(숫자·질문 자막, 같은 사실 카드 반복 금지, 효과 할당량 없음)"],
      ["12", "소스 정직성(approved_image 는 완성 카드일 수 있음, 없는 라벨 요구 금지)"],
      ["13", "소스 다양성(같은 사진 재노출·유사 정지 이미지)"],
      [
        "14",
        "장면 계획·콜아웃(word 가 문장에 있고 text 가 그 순간의 말, 컷 phase↔plan, goal 은 관계·변화, 이미지 프롬프트의 subjects 낱말)",
      ],
    ] as const
  ).map(([n, head]) =>
    section(
      "review.md",
      `REVIEW_RULE_${n}`,
      `${REVIEW} 규칙 ${n.toLowerCase()}`,
      `검토 규칙 ${n.toLowerCase()} — ${head}`,
    ),
  ),
  // copy.md — 카피 규칙
  section(
    "copy.md",
    "KOREAN_COPY_POLISH_RULES",
    "server/copy-instructions.ts koreanCopyPolishRules (카피 교정·대본 검토)",
    "한국어 AI 말투 교정 규칙 A~F·GUARDS",
  ),
  section(
    "copy.md",
    "KOREAN_COPY_RHYTHM_RULES",
    "server/copy-instructions.ts koreanCopyRhythmRules (legacy_rhythm)",
    "짧은 호흡 리듬 규칙 1~4 + 예시",
  ),
  section(
    "copy.md",
    "NATURAL_COPY_RHYTHM_RULES",
    "server/copy-instructions.ts naturalCopyRhythmRules (natural_v1)",
    "자연 문장 규칙 1~6",
    { note: "원문은 끝에 줄바꿈 하나가 있고 26/40 은 토큰으로 — 코드가 붙인다." },
  ),
  // copy-first.md — 카피 먼저 흐름(2026-10-08): 편지 1(카피) → 편지 2(장면). 혼합형 정책의 새 대본·다시 쓰기에만 쓴다.
  section(
    "copy-first.md",
    "COPY_WRITE_RULES",
    COPY_FIRST_COPY,
    "편지 1 지시: 카피라이터 역할 + 규칙 8개(사슬 순서·사실 한정·한 호흡·길이 6~10문장·requirement 한 문장·구어체·반복·cta 동사)",
  ),
  section(
    "copy-first.md",
    "COPY_SHAPE_EXAMPLE",
    `${COPY_FIRST_COPY} (응답 모양 예시 JSON)`,
    "편지 1 응답 예시 8문장(모양 참고; 숫자·낱말은 FACTS 에서)",
    { json: true },
  ),
  section(
    "copy-first.md",
    "COPY_FEEDBACK_HEAD",
    `${COPY_FIRST_COPY} 피드백 머리말`,
    "카피 다시 쓰기 머리말(규칙 위반 문제 목록 + 추정 발화 초 / 사용자 피드백)",
    { runtime: ["feedback"] },
  ),
  section(
    "copy-first.md",
    "SCENE_FROM_COPY_RULES",
    COPY_FIRST_SCENE,
    "편지 2 지시: 확정 문장 고정 + 장면 규칙만(두 세계·설명 장면 문법·클립 구간·정지 이미지 합계·첫/마지막 컷 실사·앵커·컷 필드·콜아웃)",
    {
      note: "문장 고정(sentences[i].text = DATA.copyLines[i].text)은 프롬프트로 요구하고, 어긋나면 코드가 원문으로 되돌리고 repairs 에 기록한다. 설명 세계 문법은 {{@EXPLAINER_GRAMMAR}}(hybrid.md)를 끼운다.",
    },
  ),
  section(
    "copy-first.md",
    "SCENE_FROM_COPY_HF_RULES",
    COPY_FIRST_SCENE,
    "글자 없는 INFO와 HyperFrames 라벨 계획을 쓰는 편지 2",
  ),
  section(
    "copy-first.md",
    "HF_REVIEW_RULES",
    "server/video-scripts.ts reviewVideoScript",
    "별도 라벨 계획의 문구·대상·시각·배치 검토",
  ),
  section("flow.md", "VEO_HF_INFO_IMAGE", FLOW, "글자 없는 INFO 최종 상태", {
    runtime: ["scene", "actions", "veoGraphics"],
  }),
  section("flow.md", "VEO_HF_MOTION", FLOW, "글자 없는 CLEAN→INFO 전환", {
    runtime: ["scene", "actions", "camera", "veoGraphics"],
  }),
  section("flow.md", "HF_LABEL_LAYER_RULES", COPY_FIRST_SCENE, "라벨 세트 인계와 모바일 가독성"),
  section("flow.md", "FLOW_INFO_CHECKLIST_HF", FLOW, "새 INFO 검사와 합성 대기 안내"),
  // flow.md — Veo·Flow·이미지 프롬프트 고정 문장
  section(
    "flow.md",
    "CLEAN_KEYFRAME_TAIL",
    "shared/veo-prompt.ts CLEAN_KEYFRAME_TAIL (시작·정지·CLEAN 이미지 꼬리)",
    "글자·화살표·숫자·라벨 금지와 빈 공간",
  ),
  section(
    "flow.md",
    "CLIP_PLAN_TAIL",
    "shared/veo-prompt.ts CLIP_PLAN_TAIL",
    "계획 있는 Veo 클립 고정 꼬리",
  ),
  section(
    "flow.md",
    "CLIP_LEGACY_TAIL",
    "shared/veo-prompt.ts LEGACY_TAIL",
    "계획 없는 예전 클립 꼬리(저장 대본 호환)",
  ),
  section("flow.md", "EXPLAINER_WORLD", `${FLOW} EXPLAINER_WORLD`, "설명 세계 재질·사람 없음 문장"),
  section(
    "flow.md",
    "EXPLAINER_TEXT_RULE",
    `${FLOW} EXPLAINER_TEXT_RULE`,
    "설명 세계 글자 금지 문장",
  ),
  section(
    "flow.md",
    "EXPLAINER_COLOR_ACCENT1",
    `${FLOW} COLOR_WORDS.accent1`,
    "강조색 1 자리말(실제 색 이름은 대본의 explainerAnchor 에서 옴)",
    {
      note: '특정 색으로 고정하려면 hybrid.md 의 EXPLAINER_GRAMMAR R8·HYBRID_PLANNING_RULES·HYBRID_SCRIPT_RULES(TWO ANCHORS)의 "from the brand or packaging" 문장을 함께 바꾼다(영문 색 이름).',
    },
  ),
  section(
    "flow.md",
    "EXPLAINER_COLOR_ACCENT2",
    `${FLOW} COLOR_WORDS.accent2`,
    "강조색 2 자리말(실제 색 이름은 대본의 explainerAnchor 에서 옴)",
    { note: "EXPLAINER_COLOR_ACCENT1 과 같다." },
  ),
  section("flow.md", "EXPLAINER_COLOR_NEUTRAL", `${FLOW} COLOR_WORDS.neutral`, "중립색 표현"),
  section(
    "flow.md",
    "EMPHASIS_COLOR_CODE",
    `${FLOW} emphasisText color_code`,
    "색 구분 강조 문장",
    { runtime: ["name", "color"] },
  ),
  section("flow.md", "EMPHASIS_OUTLINE", `${FLOW} emphasisText outline`, "빨간 외곽선 강조 문장", {
    runtime: ["name"],
  }),
  section(
    "flow.md",
    "EMPHASIS_GLOW_LINE",
    `${FLOW} emphasisText glow_line`,
    "흰 발광선 강조 문장",
    { runtime: ["name"] },
  ),
  section(
    "flow.md",
    "EMPHASIS_GHOST_OBJECT",
    `${FLOW} emphasisText ghost_object`,
    "반투명 비유 물체 강조 문장",
    { runtime: ["name"] },
  ),
  section("flow.md", "HYBRID_CLEAN_OBJECTS", `${FLOW} hybridCleanPrompt`, "물체 목록 머리말", {
    runtime: ["objects"],
  }),
  section(
    "flow.md",
    "HYBRID_CLEAN_START_STATE",
    `${FLOW} hybridCleanPrompt`,
    "시작 상태·빈 공간·자막 자리 문장",
  ),
  section("flow.md", "HYBRID_ANCHOR_LINE", `${FLOW} anchorLine`, "설명 세계 기준·강조색 소개 줄", {
    runtime: ["explainerAnchor"],
  }),
  section(
    "flow.md",
    "HYBRID_OVERLAY_BASE",
    `${FLOW} hybridOverlayPrompt`,
    "CLEAN 과 같은 장면 유지 문장",
  ),
  section(
    "flow.md",
    "HYBRID_OVERLAY_ACTIONS",
    `${FLOW} hybridOverlayPrompt`,
    "동작 끝난 상태 머리말",
    { runtime: ["actions"] },
  ),
  section("flow.md", "HYBRID_OVERLAY_EMPHASIS", `${FLOW} hybridOverlayPrompt`, "강조 목록 머리말", {
    runtime: ["emphasis"],
  }),
  section("flow.md", "HYBRID_OVERLAY_NO_EMPHASIS", `${FLOW} hybridOverlayPrompt`, "강조 없음 문장"),
  section(
    "flow.md",
    "HYBRID_OVERLAY_NO_FLAT",
    `${FLOW} hybridOverlayPrompt`,
    "평면 그래픽 금지·구도 유지(infoLines 없는 예전 설명 장면)",
  ),
  section(
    "flow.md",
    "HYBRID_OVERLAY_INFOGRAPHIC",
    `${FLOW} hybridOverlayPrompt (infoLines 있는 설명 장면)`,
    "튜토리얼식 인포그래픽 지시(굵은 화살표·치수선·강조 링·큰 한글 라벨·숫자, 중간 띠, 브랜드 2색+빨강)",
  ),
  section(
    "flow.md",
    "HYBRID_OVERLAY_LABELS",
    `${FLOW} hybridOverlayPrompt (infoLines 있는 설명 장면)`,
    "INFO 에 찍을 정확한 문구 머리말(그 밖의 글자 금지)",
    { runtime: ["infoLines"] },
  ),
  section(
    "flow.md",
    "HYBRID_MOTION_OPENING",
    `${FLOW} hybridMotionPrompt`,
    "CLEAN→INFO 한 샷 문장",
  ),
  section("flow.md", "HYBRID_MOTION_ACTIONS", `${FLOW} hybridMotionPrompt`, "동작 순서 머리말", {
    runtime: ["actions"],
  }),
  section(
    "flow.md",
    "HYBRID_MOTION_EMPHASIS",
    `${FLOW} hybridMotionPrompt`,
    "강조 등장 순서 머리말",
    { runtime: ["emphasis"] },
  ),
  section("flow.md", "HYBRID_MOTION_NO_EMPHASIS", `${FLOW} hybridMotionPrompt`, "강조 없음 문장"),
  section(
    "flow.md",
    "HYBRID_MOTION_CAMERA",
    `${FLOW} hybridMotionPrompt`,
    "카메라 이동·0.4초 정지·페이드 금지",
  ),
  section(
    "flow.md",
    "HYBRID_MOTION_TEXT",
    `${FLOW} hybridMotionPrompt`,
    "마지막 프레임까지 글자 금지(뒤에 {{@EXPLAINER_TEXT_RULE}})",
  ),
  section(
    "flow.md",
    "HYBRID_MOTION_LABELS",
    `${FLOW} hybridMotionPrompt (infoLines 있는 설명 장면)`,
    "라벨·숫자가 둘째 구간부터 완성형으로 나타나 끝까지 유지, 그 밖의 글자 금지",
    { runtime: ["infoLines"] },
  ),
  section("flow.md", "HYBRID_MOTION_LENGTH", `${FLOW} hybridMotionPrompt`, "8초·9:16·말 없음"),
  section("flow.md", "VERTICAL_FRAME", `${FLOW} "Vertical 9:16."`, "세로 비율 문장"),
  section(
    "flow.md",
    "IMMERSIVE_PALETTE",
    `${FLOW} IMMERSIVE_PALETTE (server/source-image-style.ts 도 사용)`,
    "아이보리·올리브·골드 시각 체계",
  ),
  section("flow.md", "IMMERSIVE_TEXT_RULE", `${FLOW} TEXT_RULE`, "immersive 글자 금지"),
  section("flow.md", "IMMERSIVE_BAND", `${FLOW} BAND`, "중간 띠(위/아래 %) 문장"),
  section("flow.md", "IMMERSIVE_INFO_LABELS", `${FLOW} infoLabelsRule`, "완성 라벨 렌더 지시", {
    runtime: ["labels"],
  }),
  section(
    "flow.md",
    "IMMERSIVE_CLEAN_DIMENSIONAL",
    `${FLOW} immersiveCleanPrompt`,
    "입체 설명 첫 프레임 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_CLEAN_ESTABLISH",
    `${FLOW} immersiveCleanPrompt`,
    "분리·비교 대상 설정 문장",
  ),
  section("flow.md", "IMMERSIVE_CLEAN_FORM", `${FLOW} immersiveCleanPrompt`, "제품 형태 보존 문장"),
  section(
    "flow.md",
    "IMMERSIVE_OVERLAY_BASE",
    `${FLOW} immersiveOverlayPrompt`,
    "같은 3D 장면·최종 상태 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_OVERLAY_CAMERA",
    `${FLOW} immersiveOverlayPrompt`,
    "최종 카메라 시점 줄",
    { runtime: ["camera"] },
  ),
  section(
    "flow.md",
    "IMMERSIVE_OVERLAY_STATE_INTRO",
    `${FLOW} immersiveOverlayPrompt`,
    "최종 상태 목록 머리말",
  ),
  section(
    "flow.md",
    "IMMERSIVE_OVERLAY_RELATION",
    `${FLOW} immersiveOverlayPrompt`,
    "절개·분리·비교·흐름 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_OVERLAY_IDENTITY",
    `${FLOW} immersiveOverlayPrompt`,
    "정체성 유지·혼합 분리 금지",
  ),
  section(
    "flow.md",
    "IMMERSIVE_MOTION_OPENING",
    `${FLOW} immersiveMotionPrompt`,
    "CLEAN→INFO 연속 설명 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_MOTION_STAGES",
    `${FLOW} immersiveMotionPrompt`,
    "단계 애니메이션 머리말",
    { runtime: ["stages"] },
  ),
  section(
    "flow.md",
    "IMMERSIVE_MOTION_OBJECTS",
    `${FLOW} immersiveMotionPrompt`,
    "물체 동작·카메라 조정 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_MOTION_PRESERVE",
    `${FLOW} immersiveMotionPrompt`,
    "제품·재질 보존 문장",
  ),
  section(
    "flow.md",
    "IMMERSIVE_MOTION_BEATS",
    `${FLOW} immersiveMotionPrompt`,
    "비트 순서·after 상태 유지",
  ),
  section("flow.md", "IMMERSIVE_MOTION_LABELS", `${FLOW} immersiveMotionPrompt`, "라벨 보존 지시", {
    runtime: ["labels"],
  }),
  section("flow.md", "IMMERSIVE_MOTION_LENGTH", `${FLOW} immersiveMotionPrompt`, "8초·말 없음"),
  section(
    "flow.md",
    "EXPLANATION_CONTRACT_INTRO",
    "shared/explanation-prompt.ts explanationPrompt 첫 문단",
    "설명 계약 사용 지시(뒤에 <explanation-plan> JSON 은 코드)",
  ),
  section(
    "flow.md",
    "INFO_CLEAN_REFERENCE",
    `${FLOW} infoCleanPrompt(예전 R3)`,
    "참조 사진 사용 문장",
  ),
  section(
    "flow.md",
    "INFO_CLEAN_FORMAT",
    `${FLOW} infoCleanPrompt(예전 R3)`,
    "사진·9:16·로고 없음",
  ),
  section(
    "flow.md",
    "INFO_OVERLAY_BASE",
    `${FLOW} infoOverlayPrompt(예전 R4)`,
    "원본 사진 유지 문장",
  ),
  section(
    "flow.md",
    "INFO_OVERLAY_ORDER_INTRO",
    `${FLOW} infoOverlayPrompt(예전 R4)`,
    "그래픽 순서 머리말",
  ),
  section(
    "flow.md",
    "INFO_OVERLAY_NO_TEXT",
    `${FLOW} infoOverlayPrompt(예전 R4)`,
    "ABSOLUTELY NO TEXT",
  ),
  section(
    "flow.md",
    "INFO_OVERLAY_STYLE",
    `${FLOW} infoOverlayPrompt(예전 R4)`,
    "굵고 발광하는 그래픽 스타일",
  ),
  section("flow.md", "INFO_OVERLAY_BAND", `${FLOW} infoOverlayPrompt(예전 R4)`, "중간 띠 % 문장"),
  section(
    "flow.md",
    "INFO_OVERLAY_COLORS",
    `${FLOW} infoOverlayPrompt(예전 R4)`,
    "강조색 2~3개·추가 요소 금지",
  ),
  section(
    "flow.md",
    "INFO_LINES_BASE",
    `${FLOW} legacyInfoOverlayPrompt`,
    "infoLines 방식 원본 유지",
  ),
  section("flow.md", "INFO_LINES_INTRO", `${FLOW} legacyInfoOverlayPrompt`, "지정 문구 머리말"),
  section("flow.md", "INFO_LINES_STYLE", `${FLOW} legacyInfoOverlayPrompt`, "큰 글자·9:16"),
  section(
    "flow.md",
    "INFO_LINES_BAND",
    `${FLOW} legacyInfoOverlayPrompt`,
    "중간 띠 % 문장(글자 포함)",
  ),
  section(
    "flow.md",
    "INFO_MOTION_LEGACY_TAIL",
    `${FLOW} infoMotionPrompt(계획 없음)`,
    "저장 motionPrompt 뒤 예전 문장",
  ),
  section(
    "flow.md",
    "INFO_MOTION_OPENING",
    `${FLOW} infoMotionPrompt(R5)`,
    "첫·마지막 프레임 문장",
  ),
  section(
    "flow.md",
    "INFO_MOTION_ORDER",
    `${FLOW} infoMotionPrompt(R5)`,
    "그래픽 등장 순서 머리말",
    { runtime: ["order"] },
  ),
  section(
    "flow.md",
    "INFO_MOTION_CAMERA",
    `${FLOW} infoMotionPrompt(R5)`,
    "연속 카메라·0.4초·페이드 금지",
  ),
  section(
    "flow.md",
    "INFO_MOTION_TEXT",
    `${FLOW} infoMotionPrompt(R5)`,
    "글자 금지·8초·립싱크 없음",
  ),
  section(
    "flow.md",
    "START_IMAGE_TAIL",
    "server/start-image-production.ts startImagePrompt",
    "시작 이미지 고정 문장(9:16·같은 인물·라벨 보존)",
  ),
  section(
    "flow.md",
    "STILL_IMAGE_TAIL",
    "server/still-production.ts stillPrompt",
    "정지 이미지 고정 문장",
  ),
  section(
    "flow.md",
    "SCENE_IMAGE_REFERENCE_1",
    "server/scene-image-references.ts sceneImagePrompt",
    "참조 이미지 1 설명",
  ),
  section(
    "flow.md",
    "SCENE_IMAGE_REFERENCE_2",
    "server/scene-image-references.ts sceneImagePrompt(참조 2개)",
    "참조 이미지 2 설명",
    { note: "원문 앞에 공백 한 칸 — 코드가 붙인다." },
  ),
  section(
    "flow.md",
    "SCENE_IMAGE_REFERENCE_NONE",
    "server/scene-image-references.ts sceneImagePrompt(참조 1개)",
    "참조 2 없을 때 일관성 문장",
    { note: "원문 앞에 공백 한 칸 — 코드가 붙인다." },
  ),
  section(
    "flow.md",
    "SOURCE_IMAGE_IMMERSIVE_NOTE",
    "server/source-image-style.ts sourceImagePrompt",
    "immersive 대표 이미지·카드 보정 문장",
  ),
  section(
    "flow.md",
    "FLOW_CHECKLIST",
    "shared/flow-mode.ts CHECKLIST (한 줄 = 한 단계)",
    "Flow 번들 공통 순서 8단계",
    { runtime: ["model"] },
  ),
  section(
    "flow.md",
    "FLOW_INFO_CHECKLIST_NO_TEXT",
    "shared/flow-mode.ts INFO_CHECKLIST_NO_TEXT",
    "글자 없는 설명 컷 순서",
  ),
  section(
    "flow.md",
    "FLOW_INFO_CHECKLIST_LINES",
    "shared/flow-mode.ts INFO_CHECKLIST_LINES",
    "지정 문구 설명 컷 순서",
  ),
  section(
    "flow.md",
    "FLOW_INFO_CHECKLIST_EXPLAINER",
    "shared/flow-mode.ts INFO_CHECKLIST_EXPLAINER",
    "혼합형 설명 장면 순서",
  ),
  section(
    "flow.md",
    "FLOW_HYBRID_EYE_CHECK",
    "shared/flow-mode.ts HYBRID_EYE_CHECK",
    "눈으로 확인할 항목",
  ),
  // examples.md — JSON 예시(모양만; 코드가 JSON.stringify 로 끼운다)
  section(
    "examples.md",
    "SCENE_PLAN_EXAMPLE_SENTENCE",
    `${SCRIPT} SCENE_PLAN_EXAMPLE_SENTENCE (JSON SHAPE 뒤 예시)`,
    "대본 예시 문장 1개",
    { json: true },
  ),
  section(
    "examples.md",
    "HYBRID_EXPLAINER_EXAMPLE",
    `${HYBRID} HYBRID_EXPLAINER_EXAMPLE`,
    "혼합형 설명 장면·문장 예시",
    { json: true },
  ),
  section(
    "examples.md",
    "SCRIPT_REFERENCE_EXAMPLES",
    "server/script-instructions.ts scriptReferenceExamples",
    "레퍼런스 구조 예시 3개(JSON 배열)",
    { json: true },
  ),
];
export type SectionSpec = Pick<InstructionSection, "file" | "key" | "json" | "runtime">;
// 기본 로드 대상(코드에 연결된 파일의 절만). 등록부 전체는 INSTRUCTION_SECTIONS.
export const WIRED_INSTRUCTION_SECTIONS: readonly InstructionSection[] =
  INSTRUCTION_SECTIONS.filter((item) => WIRED_INSTRUCTION_FILES.includes(item.file));

// --- 파서·치환 ---------------------------------------------------------------------------------------------
const HEADING = /^## ([A-Z][A-Z0-9_]*)\s*$/u;
const TOKEN = /\{\{(@?[A-Za-z][A-Za-z0-9_]*)\}\}/gu;
const isLoadToken = (name: string) => /^[A-Z][A-Z0-9_]*$/u.test(name);
// `## KEY` 머리글 아래 본문이 한 절. 첫 머리글 앞 글(파일 제목·설명)은 무시한다. 본문 앞뒤의 빈 줄은 지우고 안쪽은 그대로 둔다.
export function parseSections(markdown: string, file: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (key === null) return;
    while (body.length > 0 && body[0]?.trim() === "") body.shift();
    while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();
    if (sections.has(key)) throw new InstructionsError([`${file}: 절 ${key} 이 두 번 있습니다.`]);
    sections.set(key, body.join("\n"));
  };
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      flush();
      key = heading[1];
      body = [];
    } else if (key !== null) body.push(line);
  }
  flush();
  return sections;
}
export type TokenLookup = (name: string) => string | number | undefined;
// 로드 때 치환: 대문자 토큰은 lookup 으로, `{{@KEY}}` 는 다른 절로. 소문자 토큰은 남긴다.
export function resolveTokens(
  text: string,
  lookup: TokenLookup,
): { readonly text: string; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const resolved = text.replace(TOKEN, (match, name: string) => {
    if (!isLoadToken(name)) return match;
    const value = lookup(name);
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    return String(value);
  });
  return { text: resolved, missing: [...new Set(missing)] };
}
// 호출 시점 토큰 채우기. 다 채우지 못하면 오류(지시 파일이 코드가 모르는 토큰을 쓴 경우).
export function fillSection(text: string, vars: Readonly<Record<string, string | number>>): string {
  const missing: string[] = [];
  const filled = text.replace(TOKEN, (match, name: string) => {
    if (name in vars) return String(vars[name]);
    missing.push(name);
    return match;
  });
  if (missing.length > 0)
    throw new InstructionsError([`채우지 못한 토큰: ${[...new Set(missing)].join(", ")}`]);
  return filled;
}

// --- 로더 ---------------------------------------------------------------------------------------------------
export class InstructionsError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`지시 파일 오류:\n- ${problems.join("\n- ")}`);
    this.name = "InstructionsError";
    this.problems = problems;
  }
}
export type InstructionsFileState = {
  readonly name: string;
  readonly digest: string;
  readonly mtimeMs: number;
  readonly size: number;
};
export type InstructionsSnapshot = {
  readonly sections: ReadonlyMap<string, string>;
  readonly thresholds: Thresholds;
  // thresholds.json 항목 그대로(값·허용 범위·설명). 상태 API 가 카드에 범위를 보여 주는 데 쓴다.
  readonly thresholdEntries: ThresholdEntries;
  // 모든 파일(이름+내용)의 sha256. 산출물·이벤트에 앞 8자리를 적는다.
  readonly digest: string;
  readonly loadedAt: string;
  readonly files: readonly InstructionsFileState[];
  // 마지막 읽기가 실패해 이전 성공본을 쓰고 있으면 그 이유(한국어). 성공이면 [].
  readonly warnings: readonly string[];
};
export type InstructionsOptions = {
  readonly root?: string;
  // 읽을 절 목록(기본 WIRED_INSTRUCTION_SECTIONS). 테스트는 작은 집합을 넣는다. 목록의 file 들만 읽는다.
  readonly sections?: readonly SectionSpec[];
  // 코드 고정 토큰(기본 CODE_CONSTANTS). 덧붙이기만 한다.
  readonly constants?: Readonly<Record<string, number | string>>;
  // 실패 때 한 번 부르는 로그 훅(같은 원인은 1회).
  readonly onWarning?: (message: string) => void;
  readonly now?: () => Date;
  // 읽은 임계값을 shared/thresholds.ts(setThresholds)에 주입해 규칙 검사·타임라인·자막이 파일 값을 쓰게 할지.
  // 기본: 앱의 실제 instructions/ 폴더(root 생략 또는 같은 경로)만. 테스트의 임시 root 는 명시해야 주입하고 끝나면 resetThresholds().
  readonly apply?: boolean;
};
export function defaultInstructionsRoot(): string {
  return join(import.meta.dir, "..", "instructions");
}
export class InstructionsLoader {
  readonly root: string;
  readonly apply: boolean;
  private readonly specs: readonly SectionSpec[];
  private readonly constants: Readonly<Record<string, number | string>>;
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly now: () => Date;
  private last: InstructionsSnapshot | null = null;
  private lastWarning: string | null = null;
  constructor(options: InstructionsOptions = {}) {
    this.root = options.root ?? defaultInstructionsRoot();
    this.apply = options.apply ?? this.root === defaultInstructionsRoot();
    this.specs = options.sections ?? WIRED_INSTRUCTION_SECTIONS;
    this.constants = { ...CODE_CONSTANTS, ...(options.constants ?? {}) };
    this.onWarning = options.onWarning;
    this.now = options.now ?? (() => new Date());
  }
  get current(): InstructionsSnapshot | null {
    return this.last;
  }
  private fileNames(): string[] {
    return [THRESHOLDS_FILE, ...new Set(this.specs.map((spec) => spec.file))];
  }
  // 파일이 바뀌었는지(mtime·크기). stat 실패는 '바뀜'으로 본다(읽기 단계가 오류를 만든다).
  private changed(): boolean {
    if (!this.last) return true;
    const previous = new Map(this.last.files.map((file) => [file.name, file]));
    for (const name of this.fileNames()) {
      const before = previous.get(name);
      if (!before) return true;
      try {
        const stat = statSync(join(this.root, name));
        if (stat.mtimeMs !== before.mtimeMs || stat.size !== before.size) return true;
      } catch {
        return true;
      }
    }
    return false;
  }
  load(): InstructionsSnapshot {
    const snapshot = this.reload();
    // 임계값 주입(2): 규칙 검사(shared/script-rules 등)는 모듈 상수가 아니라 thresholds() 를 호출 때 읽으므로 여기서 최신 값을 넣는다.
    // 성공본이 바뀌지 않았어도 매번 넣는다(37개 숫자 복사 — 다른 테스트가 되돌린 값을 다음 로드가 다시 맞춘다).
    if (this.apply) setThresholds(snapshot.thresholds);
    return snapshot;
  }
  private reload(): InstructionsSnapshot {
    if (!this.changed() && this.last) return this.last;
    try {
      const snapshot = this.read();
      this.last = snapshot;
      this.lastWarning = null;
      return snapshot;
    } catch (error) {
      const problems =
        error instanceof InstructionsError ? error.problems : [(error as Error).message];
      if (!this.last) throw new InstructionsError(problems);
      const message = `지시 파일을 다시 읽지 못해 마지막 성공본(${this.last.digest.slice(0, 8)}, ${this.last.loadedAt})을 그대로 씁니다: ${problems.join(" / ")}`;
      if (this.lastWarning !== message) {
        this.lastWarning = message;
        this.onWarning?.(message);
      }
      this.last = { ...this.last, warnings: [message] };
      return this.last;
    }
  }
  private read(): InstructionsSnapshot {
    const problems: string[] = [];
    const files: InstructionsFileState[] = [];
    const contents = new Map<string, string>();
    for (const name of this.fileNames()) {
      const path = join(this.root, name);
      try {
        const stat = statSync(path);
        const text = readFileSync(path, "utf8");
        contents.set(name, text);
        files.push({
          name,
          digest: createHash("sha256").update(text).digest("hex"),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch (error) {
        problems.push(`${name}: 읽을 수 없습니다 — ${(error as Error).message}`);
      }
    }
    if (problems.length > 0) throw new InstructionsError(problems);
    const thresholdEntries = parseThresholdEntries(
      contents.get(THRESHOLDS_FILE) ?? "",
      THRESHOLDS_FILE,
    );
    const thresholds = thresholdsOf(thresholdEntries);
    const raw = new Map<string, { readonly file: string; readonly text: string }>();
    for (const [name, text] of contents) {
      if (name === THRESHOLDS_FILE) continue;
      for (const [key, body] of parseSections(text, name)) {
        if (raw.has(key))
          problems.push(`${name}: 절 ${key} 이 ${raw.get(key)?.file} 에도 있습니다.`);
        raw.set(key, { file: name, text: body });
      }
    }
    for (const spec of this.specs) {
      const found = raw.get(spec.key);
      if (!found) problems.push(`${spec.file}: 절 ${spec.key} 이 없습니다.`);
      else if (found.file !== spec.file)
        problems.push(`절 ${spec.key} 은 ${spec.file} 에 있어야 하는데 ${found.file} 에 있습니다.`);
      else if (found.text.trim() === "")
        problems.push(`${spec.file}: 절 ${spec.key} 이 비어 있습니다.`);
    }
    if (problems.length > 0) throw new InstructionsError(problems);
    const derived = derivedTokens(thresholds);
    const lookup: TokenLookup = (name) =>
      (THRESHOLD_NAMES as readonly string[]).includes(name)
        ? thresholds[name as ThresholdName]
        : (derived[name] ?? this.constants[name]);
    const specByKey = new Map(this.specs.map((spec) => [spec.key, spec]));
    const resolved = new Map<string, string>();
    const resolving = new Set<string>();
    const resolve = (key: string): string => {
      const done = resolved.get(key);
      if (done !== undefined) return done;
      const entry = raw.get(key);
      if (!entry) throw new InstructionsError([`절 ${key} 이 없습니다({{@${key}}} 참조).`]);
      if (resolving.has(key))
        throw new InstructionsError([`절 ${key} 이 자기 자신을 끼워 넣습니다.`]);
      resolving.add(key);
      const spec = specByKey.get(key);
      const runtime = new Set(spec?.runtime ?? []);
      const tokens = resolveTokens(entry.text, lookup);
      if (tokens.missing.length > 0)
        problems.push(
          `${entry.file}: 절 ${key} 의 토큰을 치환할 수 없습니다: ${tokens.missing.map((name) => `{{${name}}}`).join(", ")}`,
        );
      const text = tokens.text.replace(TOKEN, (match, name: string) => {
        if (name.startsWith("@")) return resolve(name.slice(1));
        if (!isLoadToken(name) && !runtime.has(name))
          problems.push(
            `${entry.file}: 절 ${key} 의 호출 시점 토큰 {{${name}}} 은 코드가 채우지 않습니다(허용: ${[...runtime].join(", ") || "없음"}).`,
          );
        return match;
      });
      if (spec?.json) {
        try {
          JSON.parse(text);
        } catch (error) {
          problems.push(
            `${entry.file}: 절 ${key} 은 JSON 이어야 합니다 — ${(error as Error).message}`,
          );
        }
      }
      resolving.delete(key);
      resolved.set(key, text);
      return text;
    };
    for (const spec of this.specs) resolve(spec.key);
    if (problems.length > 0) throw new InstructionsError(problems);
    const sections = new Map<string, string>();
    for (const spec of this.specs) sections.set(spec.key, resolved.get(spec.key) ?? "");
    const digest = createHash("sha256");
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name)))
      digest.update(`${file.name}\0${contents.get(file.name) ?? ""}\0`);
    return {
      sections,
      thresholds,
      thresholdEntries,
      digest: digest.digest("hex"),
      loadedAt: this.now().toISOString(),
      files,
      warnings: [],
    };
  }
}
// root 별 로더 캐시. 생성 경로는 loadInstructions() 를 호출마다 불러도 된다(바뀐 파일이 없으면 stat 만 한다).
const loaders = new Map<string, InstructionsLoader>();
export function loadInstructions(options: InstructionsOptions = {}): InstructionsSnapshot {
  const root = options.root ?? defaultInstructionsRoot();
  let loader = loaders.get(root);
  if (!loader) {
    loader = new InstructionsLoader({ ...options, root });
    loaders.set(root, loader);
  }
  return loader.load();
}
// 규칙 검사·타임라인만 돌리는 경로(대본 편집·승인, 내레이션 합성, Flow 업로드)가 생성 호출 없이도 지금 파일의 임계값을 쓰도록
// 호출 직전에 부른다. 바뀐 파일이 없으면 stat 만 하고, 깨진 편집이면 마지막 성공본 값이 그대로 들어간다.
export function syncThresholds(): Thresholds {
  return loadInstructions().thresholds;
}
// 절 하나(없으면 오류 — 등록부에 있는 절은 로드 때 보장된다).
export function sectionOf(snapshot: InstructionsSnapshot, key: string): string {
  const text = snapshot.sections.get(key);
  if (text === undefined) throw new InstructionsError([`절 ${key} 이 로드되지 않았습니다.`]);
  return text;
}
export function sectionJson(snapshot: InstructionsSnapshot, key: string): unknown {
  return JSON.parse(sectionOf(snapshot, key));
}
// 산출물에 남기는 기록(D5): 저장 스키마는 기본값 ""/null 로 예전 산출물과 호환한다.
export type InstructionsStamp = {
  readonly instructionsDigest: string;
  readonly instructionsLoadedAt: string;
};
export function instructionsStamp(snapshot: InstructionsSnapshot): InstructionsStamp {
  return { instructionsDigest: snapshot.digest, instructionsLoadedAt: snapshot.loadedAt };
}
export function instructionsEventMessage(snapshot: Pick<InstructionsSnapshot, "digest">): string {
  return `지시 파일 ${snapshot.digest.slice(0, 8)} 적용`;
}
