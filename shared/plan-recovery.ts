import { z } from "zod";
import { CreativeSchema } from "./planning";
import type { Job } from "./schema";

const DraftNameSchema = z.string().regex(/^plan-draft-[1-9][0-9]*[.]json$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanChoiceSchema = z.object({
  action: z.enum(["use", "replan"]),
  draftName: DraftNameSchema,
  draftDigest: DigestSchema,
  planDigest: DigestSchema.nullable(),
  issues: z.array(z.string()),
});
export const PlanChoiceRequestSchema = z
  .object({
    confirmation: z.literal(true),
    action: z.enum(["use", "replan"]),
    draftName: DraftNameSchema,
    draftDigest: DigestSchema,
  })
  .strict();
export type PlanChoiceRequest = z.infer<typeof PlanChoiceRequestSchema>;
export const PlanRecoverySchema = z.object({
  draftName: DraftNameSchema,
  draftDigest: DigestSchema,
  canUse: z.boolean(),
  warnings: z.array(z.string()),
  blockingIssues: z.array(z.string()),
  stageCounts: z.object({
    need_awareness: z.number().int().nonnegative(),
    comparison: z.number().int().nonnegative(),
    final_decision: z.number().int().nonnegative(),
  }),
  hypotheses: z.array(z.object({ id: z.string(), creative: CreativeSchema })),
});
export type PlanRecovery = z.infer<typeof PlanRecoverySchema>;
export function latestPlanDraft(job: Pick<Job, "artifacts">): string | null {
  return (
    job.artifacts
      .map((artifact) => artifact.name)
      .filter((name) => DraftNameSchema.safeParse(name).success)
      .sort(
        (left, right) =>
          Number(right.split("-")[2]?.split(".")[0]) - Number(left.split("-")[2]?.split(".")[0]),
      )[0] ?? null
  );
}
export function canReviewPlan(job: Job): boolean {
  return Boolean(
    job.automation?.policy.mode === "creative" &&
      job.automation.phase === "creative" &&
      ["attention", "blocked", "stopped"].includes(job.automation.status) &&
      !job.creativePlan &&
      !job.videoScripts.length &&
      !job.creativeVariants.length &&
      !job.renders.length &&
      !job.staged &&
      latestPlanDraft(job),
  );
}
