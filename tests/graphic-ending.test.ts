import { expect, test } from "bun:test";
import { captionsAss, cutGraphicAss } from "../server/render/ass";
import type { FontSet } from "../server/render/fonts";
import { graphicCaptionSpans } from "../server/render/graphic-captions";
import { DEFAULT_PROFILE } from "../server/render/theme";
import type { Caption } from "../shared/narration-captions";
import { RenderTimelineSchema, TimelineCutSchema } from "../shared/render-timeline";

const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };
const cut = TimelineCutSchema.parse({
  index: 0,
  startMs: 1000,
  endMs: 6000,
  purpose: "cta",
  source: "motion_graphic",
  effect: "hard_cut",
  onScreenText: "",
  caption: null,
  graphicKind: "compare",
  graphicLines: ["제품 이름", "올리브유 100%(스페인산)", "오일 원료 기준", "지금 비교해 보세요"],
  sourceRef: { kind: "graphic" },
  visualPolicy: "immersive_explanations_v1",
});
const caption = (text: string, startMs = 3000, endMs = 4000): Caption => ({
  text,
  startMs,
  endMs,
  style: "bottom",
});

test("immersive CTA keeps product, specification and action in one stack without a false VS", () => {
  const ass = cutGraphicAss(cut, DEFAULT_PROFILE, font);
  expect(ass).not.toContain("}VS");
  for (const line of cut.graphicLines) expect(ass).toContain(line);
  const legacy = { ...cut, visualPolicy: undefined };
  expect(cutGraphicAss(legacy, DEFAULT_PROFILE, font)).toContain("}VS");
  expect(cutGraphicAss({ ...cut, purpose: "proof" }, DEFAULT_PROFILE, font)).toContain("}VS");
});

test("graphic captions omit repeated CTA and spoken hundred percent, retaining new or negated words", () => {
  expect(graphicCaptionSpans(caption("비교해 보세요."), [cut], 350)).toEqual([]);
  expect(graphicCaptionSpans(caption("백 퍼센트거든요."), [cut], 350)).toEqual([]);
  expect(graphicCaptionSpans(caption("이백 퍼센트입니다."), [cut], 350)).toHaveLength(1);
  expect(graphicCaptionSpans(caption("백 퍼센트가 아니에요."), [cut], 350)).toHaveLength(1);
  expect(graphicCaptionSpans(caption("원했던 제품을 골라요."), [cut], 350)).toHaveLength(1);
});

test("caption remains before its graphic appears and after the graphic cut ends", () => {
  expect(graphicCaptionSpans(caption("제품 이름", 500, 6500), [cut], 350)).toEqual([
    caption("제품 이름", 500, 1080),
    caption("제품 이름", 6000, 6500),
  ]);
  expect(graphicCaptionSpans(caption("비교해 보세요.", 1100, 2000), [cut], 350)).toHaveLength(1);
});

test.each(["1100%", "1.00%", "1000%", "-100%"])(
  "a different numeric claim %s keeps the spoken hundred-percent caption",
  (value) => {
    expect(
      graphicCaptionSpans(caption("백 퍼센트거든요."), [{ ...cut, graphicLines: [value] }], 350),
    ).toHaveLength(1);
  },
);

test.each(["question", "compare"] as const)(
  "%s graphics keep their captions because their line reveal timing differs",
  (graphicKind) => {
    expect(
      graphicCaptionSpans(caption("제품 이름"), [{ ...cut, purpose: "proof", graphicKind }], 350),
    ).toHaveLength(1);
  },
);

test("caption ASS applies deduplication only to the new graphic policy", () => {
  const timeline = RenderTimelineSchema.parse({
    number: 1,
    scriptDigest: "saved",
    durationMs: 6000,
    extendedMs: 0,
    cuts: [cut],
    voice: [],
    warnings: [],
    captions: [caption("비교해 보세요."), caption("새로운 설명입니다.")],
  });
  const ass = captionsAss(timeline, DEFAULT_PROFILE, font);
  expect(ass).not.toContain("비교해 보세요.");
  expect(ass).toContain("새로운 설명입니다.");
  expect(
    captionsAss(
      { ...timeline, cuts: [{ ...cut, visualPolicy: undefined }] },
      DEFAULT_PROFILE,
      font,
    ),
  ).toContain("비교해 보세요.");
});
