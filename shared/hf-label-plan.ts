import { z } from "zod";

const coordinate = z.number().min(0).max(1);
const point = z.strictObject({ x: coordinate, y: coordinate });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const second = z.number().min(0).max(8);
const label = z.strictObject({
  lineIndex: z.number().int().min(0).max(3),
  targetId: z.string().regex(/^[a-z0-9]{1,12}$/),
  targetDescription: z.string().trim().min(1).max(300),
  box: z.strictObject({
    x: coordinate,
    y: coordinate,
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
  fontSizePx: z.number().int().min(48).max(80),
  role: z.enum(["primary", "supporting"]).optional(),
  textColor: color,
  plateColor: color,
  lineColor: color,
  startSec: second,
  fullSec: second,
  endSec: second,
  connector: z.enum(["line", "arrow"]),
  elbow: point,
  anchors: z
    .array(point.extend({ atSec: second }))
    .min(2)
    .max(12),
});

function luminance(hex: string): number {
  const rgb = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
}

export const HfLabelPlanSchema = z
  .strictObject({
    version: z.literal("hyperframes_v1"),
    // 좌표는 원본 9:16 프레임의 0~1 비율, 글자 크기는 1080x1920 출력 기준이다.
    coordinateSpace: z.literal("source_1080x1920"),
    tracking: z.literal("planned"),
    veoGraphics: z.array(z.string().trim().min(1).max(600)).min(1).max(8),
    labels: z.array(label).min(1).max(4),
  })
  .superRefine((plan, ctx) => {
    const issue = (index: number, field: string, message: string) =>
      ctx.addIssue({ code: "custom", path: ["labels", index, field], message });
    plan.labels.forEach((item, index) => {
      const box = item.box;
      if (item.role === "supporting" ? item.fontSizePx !== 48 : item.fontSizePx < 64)
        issue(index, "fontSizePx", "주 라벨은 64~72px, 보조 정보만 48px로 계획하세요.");
      if (box.x < 0.04 || box.y < 0.1 || box.x + box.width > 0.96 || box.y + box.height > 0.82)
        issue(index, "box", "라벨판은 좌우 4% 여백과 자막 위 82% 높이 안에 있어야 합니다.");
      if (item.startSec >= item.fullSec || item.endSec - item.fullSec < 1)
        issue(index, "fullSec", "라벨은 등장 뒤 완성되고, 완성된 글자를 최소 1초 유지해야 합니다.");
      const first = item.anchors[0];
      const last = item.anchors[item.anchors.length - 1];
      if (!first || !last || first.atSec > item.startSec || last.atSec < item.endSec)
        issue(
          index,
          "anchors",
          "대상 좌표는 라벨 등장부터 퇴장까지의 원본 시각을 포함해야 합니다.",
        );
      item.anchors.forEach((anchor, k) => {
        const previous = item.anchors[k - 1];
        if (previous && anchor.atSec <= previous.atSec)
          issue(index, "anchors", "대상 좌표 시각은 오름차순이어야 합니다.");
      });
      const light = luminance(item.textColor),
        dark = luminance(item.plateColor);
      if ((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) < 4.5)
        issue(index, "textColor", "글자와 라벨판의 명암 대비는 4.5:1 이상이어야 합니다.");
      for (const other of plan.labels.slice(0, index)) {
        const a = other.box;
        if (
          item.startSec < other.endSec &&
          other.startSec < item.endSec &&
          box.x < a.x + a.width &&
          a.x < box.x + box.width &&
          box.y < a.y + a.height &&
          a.y < box.y + box.height
        )
          issue(index, "box", "동시에 표시되는 라벨판은 겹칠 수 없습니다.");
      }
    });
  });
export const HfLabelPlanResponseSchema = HfLabelPlanSchema.safeExtend({
  labels: z
    .array(
      label.required({ role: true }).superRefine((item, ctx) => {
        if (item.role === "primary" && item.fontSizePx > 72)
          ctx.addIssue({
            code: "custom",
            path: ["fontSizePx"],
            message: "주 라벨은 64~72px입니다.",
          });
        if (item.fullSec < item.startSec + 0.4 || item.endSec < item.fullSec + 1.12)
          ctx.addIssue({
            code: "custom",
            path: ["fullSec"],
            message: "배지 등장 0.4초와 완성 문구 1초 읽기·퇴장 시간을 확보하세요.",
          });
      }),
    )
    .min(1)
    .max(4),
});
export type HfLabelPlan = z.infer<typeof HfLabelPlanSchema>;
export type LabelledClip = {
  readonly infoLines: readonly string[];
  readonly objects: readonly { readonly subjectId: string }[];
  readonly labelLayer?: HfLabelPlan | undefined;
};

export function hfLabelClipProblems(clip: LabelledClip): string[] {
  if (!clip.labelLayer) return [];
  const problems: string[] = [];
  const indexes = clip.labelLayer.labels.map((item) => item.lineIndex);
  if (
    indexes.length !== clip.infoLines.length ||
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index >= clip.infoLines.length)
  )
    problems.push("라벨 계획은 infoLines의 모든 문구를 한 번씩 그대로 참조해야 합니다.");
  for (const item of clip.labelLayer.labels)
    if (!clip.objects.some((object) => object.subjectId === item.targetId))
      problems.push(`라벨 대상 ${item.targetId}이 이 장면의 물체에 없습니다.`);
  return problems;
}
