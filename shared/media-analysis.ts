import { z } from "zod";

export const CutObservationSchema = z.strictObject({
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().nonnegative(),
  screenComposition: z.string().max(1000),
  onScreenText: z.string().max(1000),
  messageText: z.string().max(1000),
});
export const CutBatchSchema = z.strictObject({
  cuts: z.array(CutObservationSchema).min(1).max(10),
});
export const TranscriptSegmentSchema = z.strictObject({
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().nonnegative(),
  text: z.string().max(10000),
});
export const MediaAnalysisReportSchema = z.strictObject({
  kind: z.enum(["image", "video"]),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string(),
  createdAt: z.iso.datetime(),
  durationSec: z.number().finite().nonnegative().nullable(),
  sampling: z.string(),
  cuts: z.array(CutObservationSchema).max(120),
  transcript: z.array(TranscriptSegmentSchema).max(500),
  limitations: z.array(z.string()).min(1).max(10),
});
export type MediaAnalysisReport = z.infer<typeof MediaAnalysisReportSchema>;
export const MediaAnalysisStatusSchema = z.strictObject({
  assetId: z.string(),
  status: z.enum(["not_started", "running", "complete", "error"]),
  error: z.string().nullable(),
  report: MediaAnalysisReportSchema.nullable(),
});
export type MediaAnalysisStatus = z.infer<typeof MediaAnalysisStatusSchema>;
