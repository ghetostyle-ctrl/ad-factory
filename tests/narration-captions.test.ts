import { expect, test } from "bun:test";
import { buildTimeline, RenderTimelineSchema, timelineDigest } from "../shared/render-timeline";
import type { VideoScript } from "../shared/video-script";
import { renderScript } from "./render-fixture";

const voiceText = "매일 바쁜 아침에도 편하게 챙길 수 있어서 저는 이렇게 시작해요.";
function measuredScript(): VideoScript {
  const script = renderScript(1, "concept-1", 36);
  return {
    ...script,
    cuts: script.cuts.map((cut) => ({ ...cut, onScreenText: "" })),
    voiceover: [
      {
        ...script.voiceover[0],
        chainStep: "",
        callouts: [],
        text: voiceText,
        startSec: 0,
        endSec: 5,
        fromCut: 0,
        toCut: 2,
        purpose: "hook",
      },
    ],
  };
}
test("new timelines caption the spoken text in one-line phrases independently of cut text", () => {
  // Given: spoken words have measured timing and the cuts contain different text.
  const script = measuredScript();
  const words = voiceText
    .split(" ")
    .map((text, index) => ({ text, start: index * 0.4, end: index * 0.4 + 0.35 }));
  // When
  const built = buildTimeline(script, [{ index: 0, durationMs: 4700, tempo: 1.2, words }]);
  if (!("timeline" in built)) throw new Error("timeline expected");
  const captions = built.timeline.captions ?? [];
  // Then: words are preserved, phrases fit the reference reading range, and cuts do not dictate caption count.
  expect(captions.length).toBeGreaterThan(2);
  expect(
    captions
      .map((caption) => caption.text)
      .join("")
      .replace(/\s/g, ""),
  ).toBe(voiceText.replace(/\s/g, ""));
  expect(
    captions.every((caption) => !caption.text.includes("\n") && [...caption.text].length <= 12),
  ).toBe(true);
  expect(
    captions.every(
      (caption) =>
        caption.endMs - caption.startMs >= 500 && caption.endMs - caption.startMs <= 2000,
    ),
  ).toBe(true);
  expect(
    captions.every(
      (caption, index) => !index || caption.startMs >= (captions[index - 1]?.endMs ?? 0),
    ),
  ).toBe(true);
  expect(
    captions.some((caption) => !built.timeline.cuts.some((cut) => cut.endMs === caption.endMs)),
  ).toBe(true);
});

test("parsing a saved legacy timeline keeps its digest and does not invent caption or overlay fields", () => {
  // Given
  const legacy = {
    number: 1,
    durationMs: 1000,
    extendedMs: 0,
    scriptDigest: "legacy",
    cuts: [],
    voice: [],
    warnings: [],
  };
  // When
  const parsed = RenderTimelineSchema.parse(legacy);
  // Then
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
  expect(timelineDigest(parsed)).toBe(timelineDigest(legacy));
});

test("caption timing follows uneven relative word timestamps without scaling tempo again", () => {
  const script = measuredScript();
  script.voiceover[0] = {
    ...script.voiceover[0],
    chainStep: "",
    callouts: [],
    text: "아침마다 가볍게 오늘도 산뜻하게",
    startSec: 0,
    endSec: 5,
    fromCut: 0,
    toCut: 2,
    purpose: "hook",
  };
  const built = buildTimeline(script, [
    {
      index: 0,
      durationMs: 4700,
      tempo: 1.3,
      words: [
        { text: "아침마다", start: 0.2, end: 0.5 },
        { text: "가볍게", start: 0.5, end: 0.9 },
        { text: "오늘도", start: 2.1, end: 2.8 },
        { text: "산뜻하게", start: 2.8, end: 3.3 },
      ],
    },
  ]);
  if (!("timeline" in built)) throw new Error("timeline expected");
  const today = built.timeline.captions?.find((caption) => caption.text.startsWith("오늘도"));
  expect(today?.startMs).toBe(1900);
});

test("fractional cuts retain exact millisecond boundaries and overlay values", () => {
  const script = measuredScript();
  const first = script.cuts[0];
  const second = script.cuts[1];
  if (!first || !second) throw new Error("fixture cuts missing");
  script.cuts[0] = { ...first, endSec: 0.5 };
  script.cuts[1] = { ...second, startSec: 0.5 };
  script.fixedTitle = ["바쁜 아침에도", "가볍게 시작해요"];
  script.disclaimer = "원료에 관한 설명입니다.";
  const built = buildTimeline(script, [{ index: 0, durationMs: 4700, tempo: 1.2 }]);
  if (!("timeline" in built)) throw new Error("timeline expected");
  const timeline = RenderTimelineSchema.parse(built.timeline);
  expect(timeline.cuts[0]?.endMs).toBe(500);
  expect(timeline.cuts[1]?.startMs).toBe(500);
  expect(timeline.fixedTitle).toEqual(script.fixedTitle);
  expect(timeline.disclaimer).toBe(script.disclaimer);
});

test("captions follow the narration; cut text appears only on a silent cut", () => {
  const script = measuredScript();
  const first = script.cuts[0];
  const silent = script.cuts[5];
  if (!first || !silent) throw new Error("fixture cuts missing");
  script.cuts[0] = { ...first, onScreenText: "직접 고친 자막이에요" };
  script.cuts[5] = { ...silent, source: "approved_image", onScreenText: "말 없는 컷도 보여요" };
  const built = buildTimeline(script, [{ index: 0, durationMs: 4700, tempo: 1.2 }]);
  if (!("timeline" in built)) throw new Error("timeline expected");
  const captions = built.timeline.captions ?? [];
  const textAt = (from: number, to: number) =>
    captions
      .filter((caption) => caption.startMs >= from && caption.endMs <= to)
      .map((caption) => caption.text)
      .join("")
      .replace(/\s/g, "");
  expect(captions.some((caption) => caption.text.includes("직접 고친"))).toBe(false);
  const spoken = (script.voiceover[0]?.text ?? "").replace(/\s/g, "");
  expect(spoken.startsWith(textAt(0, first.endSec * 1000))).toBe(true);
  expect(textAt(silent.startSec * 1000, silent.endSec * 1000)).toBe("말없는컷도보여요");
  expect(
    captions.every(
      (caption, index) => !index || caption.startMs >= (captions[index - 1]?.endMs ?? 0),
    ),
  ).toBe(true);
});

test("decimal-second cuts resolve to integer millisecond timeline slots", () => {
  const script = measuredScript();
  const ends = [1.2, 1.8, 4, 6];
  script.cuts = script.cuts.map((cut, index) =>
    index < ends.length
      ? { ...cut, startSec: ends[index - 1] ?? 0, endSec: ends[index] ?? cut.endSec }
      : cut,
  );
  const line = script.voiceover[0];
  if (!line) throw new Error("voice missing");
  script.voiceover[0] = { ...line, endSec: 4 };
  const built = buildTimeline(script, [{ index: 0, durationMs: 3600, tempo: 1.2 }]);
  if (!("timeline" in built)) throw new Error("timeline expected");
  const parsed = RenderTimelineSchema.parse(built.timeline);
  expect(parsed.cuts.slice(0, 3).map((cut) => [cut.startMs, cut.endMs])).toEqual([
    [0, 1200],
    [1200, 1800],
    [1800, 4000],
  ]);
});
