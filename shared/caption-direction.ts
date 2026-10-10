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

export const CAPTION_TONES = {
  plain: {
    label: "또렷한 설명",
    file: "",
    family: "Pretendard",
    px: 64,
    accent: "FFF1A8",
    bold: true,
  },
  handwritten: {
    label: "후기·혼잣말",
    file: "NanumPenScript-Regular.ttf",
    family: "Nanum Pen",
    px: 104,
    accent: "FFD3B0",
    bold: false,
  },
  impact: {
    label: "단호한 강조",
    file: "BlackHanSans-Regular.ttf",
    family: "Black Han Sans",
    px: 82,
    accent: "FF9588",
    bold: false,
  },
  warm: {
    label: "친근한 이야기",
    file: "Jua-Regular.ttf",
    family: "Jua",
    px: 76,
    accent: "ADFFE1",
    bold: false,
  },
  elegant: {
    label: "차분한 강조",
    file: "GowunBatang-Bold.ttf",
    family: "Gowun Batang",
    px: 72,
    accent: "FFE4AA",
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
  const tones = {
    "": "plain",
    pain: "handwritten",
    believed_cause: "handwritten",
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
