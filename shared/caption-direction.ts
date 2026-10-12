import { z } from "zod";
import type { VoiceLine } from "./video-script";

export const CaptionToneSchema = z.enum(["plain", "handwritten", "impact", "warm", "elegant"]);
export const CaptionIconSchema = z.enum([
  "none",
  "leaf",
  "drop",
  "capsule",
  "bottle",
  "store",
  "clock",
  "coin",
]);
export const CaptionDirectionSchema = z.strictObject({
  tone: CaptionToneSchema,
  keyword: z.string().trim().max(40),
  icon: CaptionIconSchema,
});
export type CaptionTone = z.infer<typeof CaptionToneSchema>;
export type CaptionIcon = z.infer<typeof CaptionIconSchema>;
export type CaptionDirection = z.infer<typeof CaptionDirectionSchema>;

// 2026-10-12 레퍼런스 쇼츠 스타일(사용자 결정): 자막 모양은 두 가지뿐이다.
// box = 말 자막 기본형(굵은 고딕 + 반투명 검정 박스), emphasis = 강조 문장(박스 없이 크게·외곽선·핵심어 색 + 팝 글자).
// handwritten·warm·elegant 는 선택을 중단했고(기획 지침), 저장된 옛 대본이 그 값을 갖고 있으면 box 로 그린다.
export type CaptionLook = "box" | "emphasis";
export const CAPTION_LOOK = {
  plain: "box",
  handwritten: "box",
  impact: "emphasis",
  warm: "box",
  elegant: "box",
} as const satisfies Record<CaptionTone, CaptionLook>;

// 팝 글자 전용 서체(번들 assets/fonts/captions). 말 자막·강조 문장은 기본 Pretendard Bold 를 쓴다.
export const CAPTION_POP_FONT_FILE = "BlackHanSans-Regular.ttf";

// tone 별 표시용 정보. file 이 비어 있으면 기본 서체(Pretendard)를 쓴다 — 모든 tone 이 같은 서체다.
// px·accent 는 shared/ad-edit-style.ts caption.box / caption.emphasis 와 같은 값이다.
export const CAPTION_TONES = {
  plain: {
    label: "말 자막(박스)",
    file: "",
    family: "Pretendard",
    px: 56,
    accent: "FFE14D",
    bold: true,
  },
  handwritten: {
    label: "말 자막(박스) — 손글씨 선택 중단",
    file: "",
    family: "Pretendard",
    px: 56,
    accent: "FFE14D",
    bold: true,
  },
  impact: {
    label: "강조 문장 + 팝 글자",
    file: "",
    family: "Pretendard",
    px: 74,
    accent: "FF5A4E",
    bold: true,
  },
  warm: {
    label: "말 자막(박스) — 둥근체 선택 중단",
    file: "",
    family: "Pretendard",
    px: 56,
    accent: "FFE14D",
    bold: true,
  },
  elegant: {
    label: "말 자막(박스) — 바탕체 선택 중단",
    file: "",
    family: "Pretendard",
    px: 56,
    accent: "FFE14D",
    bold: true,
  },
} as const satisfies Record<
  CaptionTone,
  {
    readonly label: string;
    readonly file: string;
    readonly family: string;
    readonly px: number;
    readonly accent: string;
    readonly bold: boolean;
  }
>;

const ICON_WORDS = {
  none: [],
  leaf: ["올리브", "식물", "잎", "허브", "채소"],
  drop: ["기름", "오일", "수분", "방울"],
  capsule: ["캡슐", "알약"],
  bottle: ["용기", "물병", "약병", "보틀"],
  store: ["가게", "매장", "상점", "마트"],
  clock: ["시간", "아침", "저녁"],
  coin: ["가격", "금액", "비용"],
} as const satisfies Record<CaptionIcon, readonly string[]>;

export function supportedCaptionIcon(icon: CaptionIcon, keyword: string): CaptionIcon {
  if (ICON_WORDS[icon].some((word) => keyword.includes(word))) return icon;
  const shortWords = { drop: ["물"], bottle: ["병", "통"], clock: ["분", "초"], coin: ["원"] };
  if (icon in shortWords) {
    const units = shortWords[icon as keyof typeof shortWords];
    if (units.some((word) => keyword === word)) return icon;
    if (
      (icon === "clock" || icon === "coin") &&
      /^[0-9,]+(?:만|천|백)?(?:원|분|초)$/.test(keyword)
    ) {
      return (icon === "coin" ? keyword.endsWith("원") : !keyword.endsWith("원")) ? icon : "none";
    }
  }
  return "none";
}

export function captionDirectionFor(voice: VoiceLine): CaptionDirection {
  const planned = voice.captionDirection;
  if (planned) {
    const keyword = planned.keyword && voice.text.includes(planned.keyword) ? planned.keyword : "";
    return { ...planned, keyword, icon: supportedCaptionIcon(planned.icon, keyword) };
  }
  // 연출이 저장되지 않은 대본: 고통(도입 후킹)과 행동 유도만 강조 문장, 나머지는 말 자막.
  const tones = {
    "": "plain",
    pain: "impact",
    believed_cause: "plain",
    real_cause: "plain",
    requirement: "plain",
    product_fact: "plain",
    reason_why: "plain",
    outcome: "plain",
    cta: "impact",
    bridge: "plain",
  } as const satisfies Record<VoiceLine["chainStep"], CaptionTone>;
  return { tone: tones[voice.chainStep], keyword: "", icon: "none" };
}
