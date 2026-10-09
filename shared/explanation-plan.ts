import { z } from "zod";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const description = z.string().trim().min(1).max(600);

const ExplanationEntitySchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(60),
  representation: z.enum(["product", "component", "schematic"]),
  appearance: description,
});

const ExplanationBeatSchema = z.strictObject({
  id,
  targetIds: z.array(id).min(1).max(6),
  startProgress: z.number().min(0).max(1),
  endProgress: z.number().min(0).max(1),
  before: description,
  action: description,
  after: description,
  narrationCue: z.string().trim().min(1).max(160),
  viewerTakeaway: description,
});

const ExplanationAnnotationSchema = z.strictObject({
  targetId: id,
  beatId: id,
  label: z.string().trim().min(1).max(24),
  kind: z.enum(["label", "pointer", "direction", "measure"]),
  motionIntent: description,
});

export const ExplanationPlanSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    productForm: description,
    entities: z.array(ExplanationEntitySchema).min(1).max(6),
    beats: z.array(ExplanationBeatSchema).min(1).max(6),
    annotations: z.array(ExplanationAnnotationSchema).max(4),
  })
  .superRefine((plan, ctx) => {
    const entityIds = new Set<string>();
    for (const [index, entity] of plan.entities.entries()) {
      if (entityIds.has(entity.id))
        ctx.addIssue({
          code: "custom",
          path: ["entities", index, "id"],
          message: "대상 ID가 중복됩니다.",
        });
      entityIds.add(entity.id);
    }
    const beatIds = new Set<string>();
    for (const [index, beat] of plan.beats.entries()) {
      if (beatIds.has(beat.id))
        ctx.addIssue({
          code: "custom",
          path: ["beats", index, "id"],
          message: "동작 ID가 중복됩니다.",
        });
      beatIds.add(beat.id);
      const previous = plan.beats[index - 1];
      if (
        beat.startProgress >= beat.endProgress ||
        (previous && beat.startProgress < previous.endProgress)
      )
        ctx.addIssue({
          code: "custom",
          path: ["beats", index, "startProgress"],
          message: "동작은 시작보다 뒤에 끝나고, 앞 동작과 겹치지 않는 시간순이어야 합니다.",
        });
      const targets = new Set<string>();
      for (const [targetIndex, targetId] of beat.targetIds.entries()) {
        if (!entityIds.has(targetId) || targets.has(targetId))
          ctx.addIssue({
            code: "custom",
            path: ["beats", index, "targetIds", targetIndex],
            message: "동작 대상은 선언된 대상 ID를 한 번씩 참조해야 합니다.",
          });
        targets.add(targetId);
      }
    }
    for (const [index, annotation] of plan.annotations.entries()) {
      const beat = plan.beats.find((item) => item.id === annotation.beatId);
      if (!beat)
        ctx.addIssue({
          code: "custom",
          path: ["annotations", index, "beatId"],
          message: "설명 표시는 선언된 동작을 참조해야 합니다.",
        });
      if (
        !entityIds.has(annotation.targetId) ||
        (beat && !beat.targetIds.includes(annotation.targetId))
      )
        ctx.addIssue({
          code: "custom",
          path: ["annotations", index, "targetId"],
          message: "설명 표시는 해당 동작의 대상을 가리켜야 합니다.",
        });
    }
  });

export type ExplanationPlan = z.infer<typeof ExplanationPlanSchema>;
