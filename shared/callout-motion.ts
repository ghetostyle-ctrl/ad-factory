import { z } from "zod";

const unit = z.number().finite().min(0).max(1);
const PointSchema = z.strictObject({ x: unit, y: unit });
const KeyframeSchema = z.strictObject({ at: unit, target: PointSchema, label: PointSchema });

// Coordinates address the final rendered frame; progress addresses the whole cut, not the label window.
export const CalloutMotionSchema = z
  .strictObject({
    targetId: z.string().trim().min(1).max(80),
    verification: z.enum(["planned", "verified"]),
    verifiedSource: z.string().trim().min(1).max(200).optional(),
    keyframes: z.array(KeyframeSchema).min(2).max(12),
  })
  .superRefine((motion, ctx) => {
    if (motion.verification === "verified" && !motion.verifiedSource)
      ctx.addIssue({
        code: "custom",
        path: ["verifiedSource"],
        message: "확인한 원본·화면 구성 식별자가 필요합니다.",
      });
    const frames = motion.keyframes;
    if (frames[0]?.at !== 0 || frames.at(-1)?.at !== 1)
      ctx.addIssue({
        code: "custom",
        path: ["keyframes"],
        message: "경로는 컷의 처음(0)과 끝(1)을 포함해야 합니다.",
      });
    for (let index = 1; index < frames.length; index++) {
      const previous = frames[index - 1];
      const current = frames[index];
      if (previous && current && current.at <= previous.at)
        ctx.addIssue({
          code: "custom",
          path: ["keyframes", index, "at"],
          message: "시점은 중복 없이 오름차순이어야 합니다.",
        });
    }
  });
export type CalloutMotion = z.infer<typeof CalloutMotionSchema>;
export type MotionPoint = Readonly<z.infer<typeof PointSchema>>;
export type MotionPosition = { readonly target: MotionPoint; readonly label: MotionPoint };

export function motionPointAt(motion: CalloutMotion, progress: number): MotionPosition | null {
  const first = motion.keyframes[0];
  if (!first) return null;
  const at = Math.max(0, Math.min(1, progress));
  let before = first;
  for (const after of motion.keyframes.slice(1)) {
    if (after.at >= at) {
      const ratio = (at - before.at) / (after.at - before.at);
      const between = (a: MotionPoint, b: MotionPoint): MotionPoint => ({
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
      });
      return {
        target: between(before.target, after.target),
        label: between(before.label, after.label),
      };
    }
    before = after;
  }
  return { target: before.target, label: before.label };
}
