import { z } from "zod";

const ScriptReferenceSchema = z
  .object({
    number: z.number().int().min(1).max(10),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ScriptBatchRequestSchema = z
  .object({
    confirmation: z.literal(true),
    scripts: z
      .array(ScriptReferenceSchema)
      .min(1)
      .max(10)
      .refine((items) => new Set(items.map((item) => item.number)).size === items.length),
  })
  .strict();
export const ScriptApprovalSummarySchema = z.object({
  total: z.number().int().min(0).max(10),
  busy: z.boolean(),
  items: z.array(
    z.object({
      number: z.number().int(),
      digest: z.string().nullable(),
      state: z.enum(["approved", "pending", "blocked", "missing", "automatic", "complete"]),
      problems: z.array(z.string()),
    }),
  ),
});
export const ScriptBatchResultSchema = z.object({
  approved: z.array(z.number().int()),
  summary: ScriptApprovalSummarySchema,
});
export type ScriptApprovalSummary = z.infer<typeof ScriptApprovalSummarySchema>;
