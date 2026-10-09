import { expect, test } from "bun:test";
import { calloutEvents } from "../server/render/ass";
import type { FontSet } from "../server/render/fonts";
import { DEFAULT_PROFILE } from "../server/render/theme";
import { CalloutMotionSchema, motionPointAt } from "../shared/callout-motion";
import type { TimelineCallout, TimelineCut } from "../shared/render-timeline";

const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };
const keyframes = [
  { at: 0, target: { x: 0.2, y: 0.4 }, label: { x: 0.35, y: 0.25 } },
  { at: 0.5, target: { x: 0.5, y: 0.5 }, label: { x: 0.55, y: 0.3 } },
  { at: 1, target: { x: 0.8, y: 0.4 }, label: { x: 0.65, y: 0.25 } },
];
const verified = {
  targetId: "oil",
  verification: "verified" as const,
  verifiedSource: "source-and-framing-fingerprint",
  keyframes,
};
const cut: TimelineCut = {
  index: 0,
  startMs: 2000,
  endMs: 6000,
  purpose: "proof",
  source: "veo_clip",
  effect: "hard_cut",
  onScreenText: "",
  caption: null,
  graphicKind: "",
  graphicLines: [],
  sourceRef: { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
};
const base: TimelineCallout = {
  cutIndex: 0,
  text: "오일 원료",
  kind: "label",
  anchor: "top",
  color: 0,
  startMs: 3000,
  endMs: 5000,
};

test("motion interpolates the target and label separately within the cut", () => {
  expect(motionPointAt(CalloutMotionSchema.parse(verified), 0.25)).toEqual({
    target: { x: 0.35, y: 0.45 },
    label: { x: 0.45, y: 0.275 },
  });
});

test.each([
  { ...verified, verifiedSource: undefined },
  { ...verified, keyframes: [keyframes[0], keyframes[0], keyframes[2]] },
  { ...verified, keyframes: [...keyframes].reverse() },
  { ...verified, keyframes: keyframes.slice(1) },
  {
    ...verified,
    keyframes: [keyframes[0], { at: 1, target: { x: Number.NaN, y: 0 }, label: { x: 0, y: 0 } }],
  },
  {
    ...verified,
    keyframes: [keyframes[0], { at: 1, target: { x: 1.1, y: 0 }, label: { x: 0, y: 0 } }],
  },
])("invalid or unverified coordinate evidence is rejected %#", (input) => {
  expect(CalloutMotionSchema.safeParse(input).success).toBe(false);
});

test("motion events respect the active window and start at cut progress instead of path zero", () => {
  const events = calloutEvents(
    {
      cuts: [cut],
      callouts: [{ ...base, motion: CalloutMotionSchema.parse(verified) }],
      visualPolicy: "immersive_explanations_v1",
    },
    DEFAULT_PROFILE,
    font,
  );
  expect(
    events.every((event) => {
      const [start, end] = event.split(",").slice(1, 3);
      return (start ?? "") >= "0:00:03.00" && (end ?? "") <= "0:00:05.00";
    }),
  ).toBe(true);
  const points = events.filter((event) => event.includes(",MotionTarget,"));
  expect(points[0]).toContain("\\pos(378,864)");
  expect(new Set(points.map((event) => event.match(/\\pos\(([^)]+)\)/)?.[1])).size).toBeGreaterThan(
    20,
  );
});

test("planned motion produces only a fixed label, without a detached target or leader", () => {
  const events = calloutEvents(
    {
      cuts: [cut],
      callouts: [
        {
          ...base,
          kind: "arrow",
          motion: CalloutMotionSchema.parse({
            targetId: "oil",
            verification: "planned",
            keyframes,
          }),
        },
      ],
      visualPolicy: "immersive_explanations_v1",
    },
    DEFAULT_PROFILE,
    font,
  );
  expect(events).toHaveLength(2);
  expect(events.join("\n")).toContain("오일 원료");
  expect(events.join("\n")).not.toContain(",MotionTarget,");
  expect(events.join("\n")).not.toContain(",MotionLeader,");
});

test("motion ends at its cut boundary even when the stored callout spans further", () => {
  const events = calloutEvents(
    {
      cuts: [cut],
      callouts: [
        {
          ...base,
          startMs: 0,
          endMs: 8000,
          motion: CalloutMotionSchema.parse(verified),
        },
      ],
    },
    DEFAULT_PROFILE,
    font,
  );
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    const [start, end] = event.split(",").slice(1, 3);
    expect(start).toBeDefined();
    expect((start ?? "") >= "0:00:02.00").toBe(true);
    expect((end ?? "") <= "0:00:06.00").toBe(true);
  }
});

test("targets outside the safe area are hidden instead of moving the pointer to a false location", () => {
  const motion = CalloutMotionSchema.parse({
    ...verified,
    keyframes: [
      { at: 0, target: { x: 0.02, y: 0.4 }, label: { x: 0.3, y: 0.25 } },
      { at: 1, target: { x: 0.02, y: 0.4 }, label: { x: 0.3, y: 0.25 } },
    ],
  });
  const events = calloutEvents(
    { cuts: [cut], callouts: [{ ...base, motion }] },
    DEFAULT_PROFILE,
    font,
  );
  expect(events.length).toBeGreaterThan(0);
  expect(events.some((event) => event.includes(",MotionTarget,"))).toBe(false);
  expect(events.some((event) => event.includes(",MotionLeader,"))).toBe(false);
});
