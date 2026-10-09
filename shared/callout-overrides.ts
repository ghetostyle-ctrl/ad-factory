import { z } from "zod";
import { CalloutMotionSchema } from "./callout-motion";
import { TimelineCalloutSchema } from "./render-timeline";

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CalloutOverrideEditSchema = z
  .strictObject({
    index: z.number().int().nonnegative(),
    targetId: CalloutMotionSchema.shape.targetId,
    keyframes: CalloutMotionSchema.shape.keyframes,
  })
  .superRefine((value, ctx) => {
    const result = CalloutMotionSchema.safeParse({
      targetId: value.targetId,
      keyframes: value.keyframes,
      verification: "planned",
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export const CalloutOverridesEditSchema = z
  .strictObject({
    fingerprint: FingerprintSchema,
    confirmReviewed: z.literal(true),
    callouts: z.array(CalloutOverrideEditSchema).max(100),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.callouts.map((item) => item.index)).size !== value.callouts.length)
      ctx.addIssue({
        code: "custom",
        path: ["callouts"],
        message: "설명 도형 번호는 중복할 수 없습니다.",
      });
  });
export type CalloutOverridesEdit = z.infer<typeof CalloutOverridesEditSchema>;
export const CalloutOverridesViewSchema = z.object({
  number: z.number().int().min(1).max(10),
  fingerprint: FingerprintSchema,
  durationMs: z.number().nonnegative(),
  finalUrl: z.string(),
  profile: z.object({ width: z.number().positive(), height: z.number().positive() }),
  sidecarStatus: z.enum(["none", "current", "stale"]),
  callouts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      cutIndex: z.number().int().nonnegative(),
      cutStartMs: z.number().nonnegative(),
      cutDurationMs: z.number().positive(),
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
      text: z.string(),
      kind: TimelineCalloutSchema.shape.kind,
      anchor: TimelineCalloutSchema.shape.anchor,
      targetId: z.string().optional(),
      motion: CalloutMotionSchema.nullable(),
    }),
  ),
});
export type CalloutOverridesView = z.infer<typeof CalloutOverridesViewSchema>;
