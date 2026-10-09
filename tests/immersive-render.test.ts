import { expect, test } from "bun:test";
import { assColor, calloutEvents, captionsAss, graphicAss } from "../server/render/ass";
import type { FontSet } from "../server/render/fonts";
import { DEFAULT_PROFILE, renderColors, renderStylePolicy, THEME } from "../server/render/theme";
import type { RenderTimeline, TimelineCut } from "../shared/render-timeline";

const policy = "immersive_explanations_v1" as const;
const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };
const cut: TimelineCut = {
  index: 0,
  startMs: 0,
  endMs: 4000,
  purpose: "proof",
  source: "motion_graphic",
  effect: "hard_cut",
  onScreenText: "",
  caption: null,
  graphicKind: "checklist",
  graphicLines: ["원재료 종류", "원재료 비율", "다른 기름 혼합"],
  sourceRef: { kind: "graphic" },
};
const timeline: RenderTimeline = {
  number: 1,
  durationMs: 4000,
  extendedMs: 0,
  scriptDigest: "fixture",
  cuts: [cut],
  voice: [],
  warnings: [],
  callouts: [
    {
      cutIndex: 0,
      text: "종류",
      kind: "check",
      anchor: "subject",
      color: 1,
      startMs: 0,
      endMs: 4000,
    },
    {
      cutIndex: 0,
      text: "혼합",
      kind: "ring",
      anchor: "subject",
      color: 2,
      startMs: 0,
      endMs: 4000,
    },
  ],
};

test("immersive graphics retain one accent while legacy palette stays unchanged", () => {
  const colors = renderColors(policy);
  expect(new Set(colors.accents).size).toBe(1);
  expect(colors.background).toBe("F6F2E8");
  expect(colors.text).toBe("28382C");
  expect(renderColors()).toBe(THEME.colors);
});

test("immersive dense graphics suppress duplicate check and ring overlays", () => {
  const actual = calloutEvents({ ...timeline, visualPolicy: policy }, DEFAULT_PROFILE, font);
  expect(actual).toEqual([]);
  expect(calloutEvents(timeline, DEFAULT_PROFILE, font)).toHaveLength(4);
});

test("immersive scene labels keep text and use a single accent without glowing decoration", () => {
  const scene: RenderTimeline = {
    ...timeline,
    visualPolicy: policy,
    cuts: [
      {
        ...cut,
        source: "veo_clip",
        sourceRef: { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
      },
    ],
    callouts: [
      {
        cutIndex: 0,
        text: "오일 원재료 기준",
        kind: "label",
        anchor: "bottom",
        color: 2,
        startMs: 0,
        endMs: 4000,
      },
    ],
  };
  const actual = calloutEvents(scene, DEFAULT_PROFILE, font);
  expect(actual).toHaveLength(2);
  expect(actual.some((line) => line.includes("오일 원재료 기준"))).toBe(true);
  expect(actual.some((line) => line.includes("\blur"))).toBe(false);
});

test("immersive typography and retained global notice use readable dark ink with light outlines", () => {
  const actual = captionsAss(
    { ...timeline, visualPolicy: policy, disclaimer: "오일 원재료 기준입니다." },
    DEFAULT_PROFILE,
    font,
  );
  const notice = actual.split("\n").find((line) => line.startsWith("Style: Disclaimer,"));
  expect(notice).toContain(",42,");
  expect(notice).toContain(assColor("28382C"));
  expect(notice).toContain(assColor("F6F2E8"));
  expect(graphicAss("checklist", cut.graphicLines, 4000, DEFAULT_PROFILE, font, policy)).toContain(
    assColor("28382C"),
  );
});

test("the hybrid policy renders captions and callouts in the legacy style: glow, per-callout accent, dark outline", () => {
  // 검토 지적(2026-10-07): timeline.visualPolicy 진릿값 분기 때문에 혼합형이 immersive 콜아웃(글로우 없음·단일 강조색)을 탔다.
  // 혼합형은 실사 위주라 예전 스타일을 쓴다; immersive 스타일은 renderStylePolicy 가 immersive 만 통과시킨다.
  const hybrid = "hybrid_explainer_v1" as const;
  expect(renderStylePolicy(hybrid)).toBeUndefined();
  expect(renderStylePolicy(policy)).toBe(policy);
  expect(renderStylePolicy(undefined)).toBeUndefined();
  expect(renderColors(hybrid)).toBe(THEME.colors);
  const legacyEvents = calloutEvents(timeline, DEFAULT_PROFILE, font);
  const hybridEvents = calloutEvents({ ...timeline, visualPolicy: hybrid }, DEFAULT_PROFILE, font);
  expect(hybridEvents).toEqual(legacyEvents);
  expect(hybridEvents.some((line) => line.includes("\\blur"))).toBe(true);
  const legacyCaptions = captionsAss(
    { ...timeline, disclaimer: "표기 기준" },
    DEFAULT_PROFILE,
    font,
  );
  const hybridCaptions = captionsAss(
    { ...timeline, visualPolicy: hybrid, disclaimer: "표기 기준" },
    DEFAULT_PROFILE,
    font,
  );
  expect(hybridCaptions).toBe(legacyCaptions);
  expect(hybridCaptions).not.toContain(",42,");
});
