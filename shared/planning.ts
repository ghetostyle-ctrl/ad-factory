import { z } from "zod";

export const StrategySchema = z
  .object({
    positioning: z.string(),
    audienceInsight: z.string(),
    valueProposition: z.string(),
    messageAngles: z.array(z.string()),
    risks: z.array(z.string()),
    measurementPlan: z.string(),
  })
  .strict();
export type Strategy = z.infer<typeof StrategySchema>;
export const CreativeSchema = z
  .object({
    concept: z.string(),
    headline: z.string(),
    primaryText: z.string(),
    description: z.string(),
    callToAction: z.enum(["SHOP_NOW", "LEARN_MORE"]),
    imagePrompt: z.string(),
    rationale: z.string(),
    checks: z.array(z.string()),
  })
  .strict();
export type Creative = z.infer<typeof CreativeSchema>;

export const ImageReviewResponseSchema = z
  .object({
    status: z.enum(["pass", "revise"]),
    summary: z.string().min(1).max(3000),
    issues: z.array(z.string().min(1).max(1000)).max(20),
    revisionPrompt: z.string().min(1).max(6000).nullable(),
  })
  .strict();
export const ImageReviewSchema = ImageReviewResponseSchema.refine(
  (review) =>
    review.status === "pass"
      ? review.issues.length === 0 && review.revisionPrompt === null
      : review.issues.length > 0 && review.revisionPrompt !== null,
  { message: "Review status must agree with issues and revision instructions." },
);
export type ImageReview = z.infer<typeof ImageReviewSchema>;
export const AnalysisReportSchema = z
  .object({
    summary: z.string().min(1).max(3000),
    observations: z.array(z.string().min(1).max(1000)).min(1).max(20),
    hypotheses: z.array(z.string().min(1).max(1000)).max(20),
    recommendations: z.array(z.string().min(1).max(1000)).max(20),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(20),
  })
  .strict();
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
