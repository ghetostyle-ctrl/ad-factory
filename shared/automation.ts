import { z } from "zod";

const AdvertisingPolicySchema = z
  .object({
    mode: z.enum(["prepare", "activate"]),
    maxTotalSpend: z.number().positive().max(1000000000),
    endAt: z.iso.datetime(),
    analysisIntervalMinutes: z.number().int().min(15).max(1440),
  })
  .strict();
export const AutomationPolicySchema = z.union([
  z
    .object({
      mode: z.literal("creative"),
      imageCount: z.number().int().min(1).max(10).optional(),
      videoCount: z.number().int().min(0).max(10).optional(),
      videoModel: z
        .enum([
          "veo-3.1-lite-generate-preview",
          "veo-3.1-fast-generate-preview",
          "veo-3.1-generate-preview",
        ])
        .optional(),
    })
    .strict(),
  AdvertisingPolicySchema,
]);
export type AutomationPolicy = z.infer<typeof AutomationPolicySchema>;
export const AutomationStateSchema = z.object({
  policy: AutomationPolicySchema,
  status: z.enum(["queued", "running", "waiting", "blocked", "attention", "stopped", "completed"]),
  phase: z.enum([
    "strategy",
    "creative",
    "script",
    "image",
    "video",
    "review",
    "stage",
    "activate",
    "insights",
    "report",
    "finished",
  ]),
  nextRunAt: z.string().nullable(),
  nextAnalysisAt: z.string().nullable(),
  lastError: z.string().nullable(),
  authorizedAt: z.string(),
  scopeDigest: z.string(),
  imageAttempts: z.number().int().min(0).max(2),
  operation: z.string().nullable(),
  videoOperation: z
    .object({
      index: z.number().int().min(1).max(10),
      name: z.string(),
      startedAt: z.iso.datetime(),
    })
    .nullable()
    .default(null),
  stoppedAt: z.string().nullable(),
  approvedImageId: z.string().nullable().default(null),
  approvedImageDigest: z.string().nullable().default(null),
  approvedCreativeDigest: z.string().nullable().default(null),
  approvedPlanDigest: z.string().nullable().default(null),
  lastAnalysisDigest: z.string().nullable().default(null),
});
export type AutomationState = z.infer<typeof AutomationStateSchema>;
export const AutomationStartSchema = z
  .object({ confirmation: z.literal(true), policy: AutomationPolicySchema })
  .strict();
export const AutomationResumeSchema = z.object({ confirmation: z.literal(true) }).strict();
export const AutomationResetSchema = z.object({ confirmation: z.literal(true) }).strict();
export const EngineStateSchema = z.object({
  running: z.boolean(),
  activeJobs: z.number().int().nonnegative(),
  lastTickAt: z.string().nullable(),
});
