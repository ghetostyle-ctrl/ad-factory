import { expect, test } from "bun:test";
import { HfLabelPlanResponseSchema } from "../shared/hf-label-plan";
import { repairHfLabelResponse } from "../shared/hf-label-repair";
import { HfVideoScriptResponseSchema } from "../shared/video-script";
import { hfLabelFixture } from "./hf-label-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

function response() {
  const value = hybridScriptResponse();
  const template = value.infoClips[0];
  if (!template) throw new TypeError("Missing clip");
  value.infoClips.push({ ...structuredClone(template), id: "I3" });
  return {
    ...value,
    infoClips: value.infoClips.map((clip) => ({
      ...clip,
      labelLayer: hfLabelFixture(
        clip.infoLines.length,
        clip.objects.map((o) => o.subjectId),
      ),
    })),
  };
}

test("repairs the observed box and animation failures without changing text or anchors", () => {
  const value = response();
  const first = value.infoClips[0]?.labelLayer.labels[0];
  const third = value.infoClips[2]?.labelLayer.labels[0];
  if (!first || !third) throw new TypeError("Missing labels");
  first.box.x = 0.7;
  first.box.y = 0.8;
  third.startSec = 6.8;
  third.fullSec = 7;
  third.endSec = 8;
  const before = structuredClone(value);
  expect(HfVideoScriptResponseSchema.safeParse(value).success).toBe(false);
  const result = repairHfLabelResponse(value);
  const parsed = HfVideoScriptResponseSchema.parse(result.value);
  expect(value).toEqual(before);
  expect(parsed.sentences).toEqual(before.sentences);
  expect(parsed.infoClips.map((c) => c.infoLines)).toEqual(
    before.infoClips.map((c) => c.infoLines),
  );
  expect(parsed.infoClips.map((c) => c.labelLayer.labels.map((l) => l.anchors))).toEqual(
    before.infoClips.map((c) => c.labelLayer.labels.map((l) => l.anchors)),
  );
  expect(result.repairs.length).toBeGreaterThanOrEqual(2);
  expect(parsed.infoClips[0]?.labelLayer.labels[0]?.box.width).toBe(first.box.width);
  expect(parsed.infoClips[2]?.labelLayer.labels[0]?.fullSec).toBe(6.88);
  expect(repairHfLabelResponse(parsed).repairs).toEqual([]);
});

test("accepts exact minimum times and frame boundaries despite decimal rounding", () => {
  const plan = hfLabelFixture();
  const label = plan.labels[0];
  if (!label) throw new TypeError("Missing label");
  label.box = { x: 0.04, y: 0.1, width: 0.92, height: 0.72 };
  label.startSec = 4.4;
  label.fullSec = 4.8;
  label.endSec = 5.92;
  expect(HfLabelPlanResponseSchema.safeParse(plan).success).toBe(true);
});

test("keeps an already valid response byte-for-byte equivalent", () => {
  const value = response();
  const result = repairHfLabelResponse(value);
  expect(result.value).toEqual(value);
  expect(result.repairs).toEqual([]);
});

for (const reason of ["oversized", "short tracking", "unknown target", "overlap"] as const) {
  test("does not manufacture a safe plan for " + reason, () => {
    const value = response();
    const clip = value.infoClips[0],
      label = clip?.labelLayer.labels[0];
    if (!clip || !label) throw new TypeError("Missing label");
    switch (reason) {
      case "oversized":
        label.box.width = 1;
        break;
      case "short tracking":
        label.anchors = [
          { atSec: 7, x: 0.5, y: 0.4 },
          { atSec: 8, x: 0.5, y: 0.4 },
        ];
        label.startSec = 7;
        label.fullSec = 7.2;
        label.endSec = 8;
        break;
      case "unknown target":
        label.targetId = "missing";
        break;
      case "overlap":
        clip.infoLines.push("다른 문구");
        clip.labelLayer.labels.push({ ...structuredClone(label), lineIndex: 1 });
        break;
      default:
        reason satisfies never;
    }
    expect(HfVideoScriptResponseSchema.safeParse(repairHfLabelResponse(value).value).success).toBe(
      false,
    );
  });
}
