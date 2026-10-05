import { z } from "zod";

const insight = z.string().trim().min(1).max(1000);
export const VideoAudienceSchema = z.strictObject({
  viewer: insight,
  situation: insight,
  trigger: insight,
  currentApproach: insight,
  friction: insight,
  concern: insight,
  desiredChange: insight,
  purchaseBarrier: insight,
  proofNeeded: insight,
  awareness: z.enum([
    "unaware",
    "problem_aware",
    "solution_aware",
    "product_aware",
    "ready_to_decide",
  ]),
  evidence: z.array(z.strictObject({ sourceId: z.string().min(1), observation: insight })).max(10),
  assumptions: z.array(insight).max(10),
  unknowns: z.array(insight).max(10),
});
export const VideoConceptSchema = z.strictObject({
  idea: insight,
  viewerQuestion: insight,
  openingScene: insight,
  development: z.array(insight).min(1).max(8),
  payoff: insight,
  proofScene: insight,
  ctaIntent: insight,
  referenceNotes: insight,
});
export const VideoCopyLineSchema = z.strictObject({
  text: z.string().trim().min(1).max(160),
  screenText: z.string().trim().max(120),
});
export const VideoPlanningDraftSchema = z.strictObject({
  audience: VideoAudienceSchema,
  concept: VideoConceptSchema,
  copy: z.strictObject({
    voicePersona: z.enum(["conversational", "storytelling"]),
    lines: z.array(VideoCopyLineSchema).min(4).max(40),
  }),
});
export const VideoCopyEditSchema = z.strictObject({
  lineIndex: z.number().int().min(0).max(39),
  field: z.enum(["narration", "screenText"]),
  before: z.string().max(160),
  after: z.string().max(160),
  reason: insight,
});
export const VideoCopyReviewSchema = z.strictObject({
  status: z.enum(["pass", "revised"]),
  summary: insight,
  edits: z.array(VideoCopyEditSchema).max(80),
});
export const VideoCopyEditingResponseSchema = z.strictObject({
  lines: z.array(VideoCopyLineSchema).min(4).max(40),
  review: VideoCopyReviewSchema,
});
export const VideoPlanningSchema = VideoPlanningDraftSchema.extend({
  copyReview: VideoCopyReviewSchema,
});
export type VideoPlanningDraft = z.infer<typeof VideoPlanningDraftSchema>;
export type VideoPlanning = z.infer<typeof VideoPlanningSchema>;
export type VideoCopyEditingResponse = z.infer<typeof VideoCopyEditingResponseSchema>;
