import { expect, test } from "bun:test";
import { captionsAss } from "../server/render/ass";
import type { FontSet } from "../server/render/fonts";
import { DEFAULT_PROFILE } from "../server/render/theme";
import { RenderTimelineSchema } from "../shared/render-timeline";

const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };

test.each([
  {
    text: "올리브유만",
    startMs: 121,
    endMs: 742,
    graphicStartMs: 0,
    assStart: "0:00:00.12",
    assEnd: "0:00:00.74",
  },
  {
    text: "올리브유만",
    startMs: 121,
    endMs: 742,
    graphicStartMs: 300,
    assStart: "0:00:00.12",
    assEnd: "0:00:00.74",
  },
])(
  "measured narration survives matching graphic text from $graphicStartMs ms",
  ({ text, startMs, endMs, graphicStartMs, assStart, assEnd }) => {
    // Given: the first measured phrase duplicates part of an independently timed graphic.
    const timeline = RenderTimelineSchema.parse({
      number: 1,
      scriptDigest: "caption-regression",
      durationMs: 4050,
      extendedMs: 0,
      voice: [
        {
          index: 0,
          text: "올리브유만 든 줄 알고 샀는데, 다른 기름도 들어 있었다면?",
          artifactName: "voice-1-01-1.wav",
          startMs: 0,
          durationMs: 4050,
          tempo: 1,
          words: [{ text: "올리브유만", start: 0.321, end: 0.882 }],
        },
      ],
      cuts: [
        {
          index: 0,
          startMs: graphicStartMs,
          endMs: 2000,
          purpose: "pain",
          source: "motion_graphic",
          effect: "hard_cut",
          onScreenText: "",
          caption: null,
          graphicKind: "callout",
          graphicLines: ["올리브유만 든 줄 알았는데"],
          sourceRef: { kind: "graphic" },
          visualPolicy: "immersive_explanations_v1",
        },
      ],
      warnings: [],
      captions: [{ text, startMs, endMs, style: "bottom" }],
      visualPolicy: "immersive_explanations_v1",
    });
    // When: the complete narration caption track is converted to ASS.
    const events = captionsAss(timeline, DEFAULT_PROFILE, font)
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));
    // Then: graphic duplication cannot remove or shorten a spoken phrase.
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`${assStart},${assEnd},Caption`);
    expect(events[0]).toEndWith(text);
  },
);
