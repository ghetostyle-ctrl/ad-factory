import { z } from "zod";

const line = z.string().trim().min(1).max(1200);

export const VideoCutSchema = z.strictObject({
  startSec: z.number().int().min(0).max(7),
  endSec: z.number().int().min(1).max(8),
  purpose: z.enum(["hook", "problem", "solution", "proof", "cta"]),
  screenComposition: line,
  onScreenText: z.string().trim().max(120),
  narration: z.string().trim().max(240),
  source: z.enum(["approved_image", "veo_clip", "project_clip"]),
});

export const VideoScriptSchema = z.strictObject({
  number: z.number().int().min(1).max(10),
  hypothesisId: z.string().min(1),
  title: line,
  durationSec: z.literal(8),
  cuts: z.array(VideoCutSchema).min(2).max(5),
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
