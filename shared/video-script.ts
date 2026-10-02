import { z } from "zod";

const line = z.string().trim().min(1).max(1200);

// 완성 영상 길이: 30초가 최소, 1분까지. 영상마다 이 범위에서 길이를 정한다.
export const VIDEO_MIN_SEC = 30;
export const VIDEO_MAX_SEC = 60;
// 한국어 내레이션 실측 속도(공백 포함) 4.5~6.8자/초를 기준으로 한 허용 범위.
export const NARRATION_MIN_CHARS_PER_SEC = 3.5;
export const NARRATION_MAX_CHARS_PER_SEC = 6.5;
export const CUT_MAX_SEC = 4;
export const CAPTION_LINE_MAX_CHARS = 16;
export const VEO_SHOTS_MAX = 2;

// 7단 흐름(후킹→페인→스토리·원인→메커니즘(USP)→신뢰→혜택→행동 유도). problem·solution 은 예전 8초 대본 호환용.
const PurposeSchema = z.enum([
  "hook",
  "pain",
  "story",
  "mechanism",
  "proof",
  "offer",
  "cta",
  "problem",
  "solution",
]);
const SourceSchema = z.enum(["approved_image", "card_slide", "veo_clip", "project_clip"]);

export const VideoCutResponseSchema = z.strictObject({
  startSec: z
    .number()
    .int()
    .min(0)
    .max(VIDEO_MAX_SEC - 1),
  endSec: z.number().int().min(1).max(VIDEO_MAX_SEC),
  purpose: PurposeSchema,
  screenComposition: line,
  onScreenText: z.string().trim().max(120),
  narration: z.string().trim().max(400),
  source: SourceSchema,
  veoPrompt: z.string().trim().max(1200),
});
export const VideoCutSchema = VideoCutResponseSchema.extend({
  veoPrompt: z.string().trim().max(1200).default(""),
});

export const VideoScriptResponseSchema = z.strictObject({
  number: z.number().int().min(1).max(10),
  hypothesisId: z.string().min(1),
  title: line,
  durationSec: z.number().int().min(VIDEO_MIN_SEC).max(VIDEO_MAX_SEC),
  cuts: z.array(VideoCutResponseSchema).min(6).max(40),
  flowPrompt: line,
  editInstructions: line,
});
// 저장본은 예전 8초 대본도 읽는다.
export const VideoScriptSchema = z.strictObject({
  number: z.number().int().min(1).max(10),
  hypothesisId: z.string().min(1),
  title: line,
  durationSec: z.number().int().min(8).max(VIDEO_MAX_SEC),
  cuts: z.array(VideoCutSchema).min(2).max(40),
  flowPrompt: line,
  editInstructions: line,
});

export type VideoScript = z.infer<typeof VideoScriptSchema>;

export function videoScriptIsContinuous(script: VideoScript): boolean {
  let end = 0;
  for (const cut of script.cuts) {
    if (cut.startSec !== end || cut.endSec <= cut.startSec) return false;
    end = cut.endSec;
  }
  return end === script.durationSec;
}

// 영상마다 30~60초 중 하나를 고른다. 작업 ID와 영상 번호로 정해서 다시 실행해도 같은 길이가 나온다.
export function videoTargetSeconds(jobId: string, number: number): number {
  let hash = 2166136261;
  for (const char of `${jobId}:${number}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return VIDEO_MIN_SEC + (hash % (VIDEO_MAX_SEC - VIDEO_MIN_SEC + 1));
}
