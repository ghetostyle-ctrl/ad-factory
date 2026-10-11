import { z } from "zod";
import { HfLabelPlanDraftSchema } from "./hf-label-plan";

const draft = z
  .object({
    infoClips: z.array(
      z
        .object({
          id: z.string(),
          labelLayer: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;

// Only model response plans pass here; saved/approved scripts and tracking keyframes stay unchanged.
export function repairHfLabelResponse(value: unknown): {
  readonly value: unknown;
  readonly repairs: readonly string[];
} {
  const parsed = draft.safeParse(value);
  if (!parsed.success) return { value, repairs: [] };
  const repairs: string[] = [];
  const infoClips = parsed.data.infoClips.map((clip) => {
    const parsedPlan = HfLabelPlanDraftSchema.safeParse(clip.labelLayer);
    if (!parsedPlan.success) return clip;
    const plan = parsedPlan.data;
    const labels = plan.labels.map((source, index) => {
      const label = structuredClone(source);
      const name = "설명 컷 " + clip.id + " · 라벨 " + (index + 1);
      if (label.box.width <= 0.92 && label.box.height <= 0.72) {
        const x = rounded(clamp(label.box.x, 0.04, 0.96 - label.box.width));
        const y = rounded(clamp(label.box.y, 0.1, 0.82 - label.box.height));
        if (Math.abs(x - label.box.x) > 1e-6 || Math.abs(y - label.box.y) > 1e-6) {
          label.box = { ...label.box, x, y };
          repairs.push(name + ": 글자 크기와 판 크기를 유지해 안전영역 안으로 이동");
        }
      }
      const first = label.anchors[0],
        last = label.anchors.at(-1);
      const ordered = label.anchors.every(
        (anchor, i) => i === 0 || anchor.atSec > (label.anchors[i - 1]?.atSec ?? 8),
      );
      if (first && last && ordered) {
        const minimum = Math.ceil(first.atSec * 1000);
        const maximum = Math.floor(last.atSec * 1000);
        const timingValid =
          label.startSec >= first.atSec &&
          label.endSec <= last.atSec &&
          label.fullSec + 1e-6 >= label.startSec + 0.4 &&
          label.endSec + 1e-6 >= label.fullSec + 1.12;
        if (!timingValid && maximum - minimum >= 1520) {
          const start = clamp(Math.round(label.startSec * 1000), minimum, maximum - 1520);
          const full = clamp(Math.round(label.fullSec * 1000), start + 400, maximum - 1120);
          const end = clamp(Math.round(label.endSec * 1000), full + 1120, maximum);
          label.startSec = start / 1000;
          label.fullSec = full / 1000;
          label.endSec = end / 1000;
          repairs.push(name + ": 기존 대상 추적 구간 안에서 등장·읽기·퇴장 시간 확보");
        }
      }
      return label;
    });
    return { ...clip, labelLayer: { ...plan, labels } };
  });
  return repairs.length ? { value: { ...parsed.data, infoClips }, repairs } : { value, repairs };
}
