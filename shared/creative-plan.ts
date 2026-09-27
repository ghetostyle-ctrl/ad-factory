import { z } from "zod";
import { CreativeSchema } from "./planning";

const concise = z.string().trim().min(1).max(1500);
export const ReferenceAnalysisResponseSchema = z
  .object({
    observedStructure: z.array(concise).max(10),
    inferences: z.array(concise).max(10),
    unknowns: z.array(concise).min(1).max(10),
  })
  .strict();
export const ReferenceAnalysisSchema = ReferenceAnalysisResponseSchema.extend({
  sourceId: z.string(),
});
export type ReferenceAnalysis = z.infer<typeof ReferenceAnalysisSchema>;
export const HypothesisSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    angle: z.enum(["problem_solution", "usage_context", "objection_answer"]),
    targetAudience: concise,
    targetReason: concise,
    customerSituation: concise,
    problem: concise,
    message: concise,
    hook: concise,
    difference: concise,
    visualMechanism: concise,
    claimCitations: z
      .array(z.object({ sourceId: z.string(), quote: concise }).strict())
      .min(1)
      .max(10),
    referenceSourceIds: z.array(z.string()).max(8),
    creative: CreativeSchema,
  })
  .strict();
export const CreativePlanResponseSchema = z
  .object({
    hypotheses: z.array(HypothesisSchema).min(1).max(10),
    diversityRationale: concise,
    limitations: z.array(concise).min(1).max(15),
  })
  .strict();
export const CreativePlanSchema = CreativePlanResponseSchema.extend({
  sourceDigest: z.string(),
  referenceAnalyses: z.array(ReferenceAnalysisSchema).max(8),
  sourceCoverage: z.object({
    factsUsed: z.array(z.string()).max(8),
    referencesUsed: z.array(z.string()).max(5),
    voicesUsed: z.array(z.string()).max(4),
    excluded: z.array(z.object({ sourceId: z.string(), reason: z.string() })).max(100),
    limits: z.object({
      maxFactSources: z.literal(8),
      maxFactCharacters: z.literal(24000),
      maxReferenceSources: z.literal(5),
      maxReferenceCharacters: z.literal(8000),
      maxVoiceSources: z.literal(4),
      maxVoiceCharacters: z.literal(8000),
    }),
  }),
});
export type CreativePlan = z.infer<typeof CreativePlanSchema>;
export const PlanCritiqueSchema = z
  .object({
    status: z.enum(["pass", "revise"]),
    issues: z.array(concise).max(15),
  })
  .strict();
export const CreativeVariantSchema = z.object({
  id: z.string(),
  creative: CreativeSchema,
  imageAttempts: z.number().int().min(0).max(2),
  approvedImageId: z.string().nullable(),
  approvedImageDigest: z.string().nullable(),
  approvedCreativeDigest: z.string().nullable(),
  reviewStatus: z.enum(["pending", "pass", "revise"]),
});
export type CreativeVariant = z.infer<typeof CreativeVariantSchema>;
export const StagedVariantSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  creativeSnapshot: CreativeSchema,
  creativeId: z.string().nullable(),
  adId: z.string().nullable(),
  imageHash: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
});
