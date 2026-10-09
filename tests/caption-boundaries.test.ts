import { expect, test } from "bun:test";
import { narrationCaptions, timelineCaptions } from "../shared/narration-captions";
import type { TimelineVoice } from "../shared/render-timeline";

const voice = (overrides: Partial<TimelineVoice> = {}): TimelineVoice => ({
  index: 0,
  text: "아침마다 가볍게 오늘도 산뜻하게",
  artifactName: "voice.wav",
  startMs: 6000,
  durationMs: 3200,
  tempo: 1.2,
  words: [],
  ...overrides,
});

test("missing partial or reversed timestamps preserve the same complete transcript using fallback timing", () => {
  const line = voice();
  const baseline = narrationCaptions([line]);
  for (const words of [
    [{ text: "아침마다", start: 0, end: 0.4 }],
    [{ text: "다른문장", start: 0, end: 0.4 }],
    [{ text: "아침마다", start: 0.4, end: 0.1 }],
  ])
    expect(narrationCaptions([{ ...line, words }])).toEqual(baseline);
});

test("short sentence and thirteen-character tail are retained within the measured voice duration", () => {
  for (const text of ["네", "가나다라마바사아자차카타파", "아주긴어절도끝까지보여줍니다"]) {
    const line = voice({ text, durationMs: text === "네" ? 200 : 1900 });
    const captions = narrationCaptions([line]);
    expect(captions.map((caption) => caption.text).join("")).toBe(text);
    expect(
      captions.every(
        (caption) =>
          caption.startMs < caption.endMs && caption.endMs <= line.startMs + line.durationMs,
      ),
    ).toBe(true);
    expect(captions.every((caption) => [...caption.text].length <= 12)).toBe(true);
  }
});

test("word timestamps use the final voice offset and do not caption a long initial silence", () => {
  const captions = narrationCaptions([
    voice({
      text: "아침마다 가볍게",
      durationMs: 4200,
      words: [
        { text: "아침마다", start: 2.1, end: 2.5 },
        { text: "가볍게", start: 2.5, end: 3.1 },
      ],
    }),
  ]);
  expect(captions[0]?.startMs).toBe(7900);
  expect(captions.every((caption) => caption.endMs - caption.startMs <= 2000)).toBe(true);
});

test("numeric amounts and their units stay together even when they exceed the phrase target", () => {
  // Given: a regular amount, a grouped amount and an amount longer than twelve characters.
  for (const [text, amount] of [
    ["지금 가격은 12,900원이에요.", "12,900원"],
    ["가격은 1,234,567원입니다.", "1,234,567원"],
    ["합계는 12,345,678,901,234원입니다.", "12,345,678,901,234원"],
    ["이 원료를 12.5밀리그램 넣었어요.", "12.5밀리그램"],
  ]) {
    if (!text || !amount) throw new Error("amount fixture missing");
    // When
    const captions = narrationCaptions([voice({ text, durationMs: 3000 })]);
    // Then
    expect(captions.some((caption) => caption.text.includes(amount))).toBe(true);
    expect(
      captions
        .map((caption) => caption.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(text.replace(/\s/g, ""));
  }
});

test("captions end at sentence and clause punctuation without borrowing the next phrase", () => {
  // Given: both joins were previously preferred by the character-length score.
  for (const text of [
    "하루 한 알로 안내돼 있어요. 내게 맞는지 확인해요.",
    "이름만 보고 고르기보다, 어떤 원료인지 살펴보세요.",
    "한 번 확인해요!다음에도 살펴보세요.",
  ]) {
    // When
    const captions = narrationCaptions([voice({ text, startMs: 0, durationMs: 4200 })]);
    // Then: punctuation closes the caption, while every spoken character is retained.
    expect(captions.every((caption) => !/[,.!?][^,.!?\s]/u.test(caption.text))).toBe(true);
    expect(captions.every((caption) => !/[,.!?]\s+\S/u.test(caption.text))).toBe(true);
    expect(
      captions
        .map((caption) => caption.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(text.replace(/\s/g, ""));
  }
});

test("ordinary whitespace-delimited words are not split to hit the character target", () => {
  // Given: these words fit individually, but a balanced character partition cut through them.
  for (const text of [
    "한 알에 엑스트라버진올리브오일이 담겼어요.",
    "직접 확인하고 고르기보다 어떤 원료인지부터 살펴보세요.",
  ]) {
    // When
    const captions = narrationCaptions([voice({ text, startMs: 0, durationMs: 4200 })]);
    // Then: joining caption tokens exactly reconstructs the input's whole tokens.
    expect(captions.flatMap((caption) => caption.text.split(" "))).toEqual(text.split(" "));
    expect(captions.every((caption) => [...caption.text].length <= 12)).toBe(true);
    expect(
      captions.every(
        (caption, index) =>
          caption.startMs < caption.endMs &&
          caption.endMs <= 4200 &&
          (!index || caption.startMs >= (captions[index - 1]?.endMs ?? 0)),
      ),
    ).toBe(true);
  }
});

test("a quoted sentence keeps its closing quote and the next sentence keeps its measured start", () => {
  // Given
  const line = voice({
    text: "“안내돼 있어요.” 내게 맞아요.",
    startMs: 0,
    durationMs: 3000,
    words: [
      { text: "“안내돼", start: 0, end: 0.4 },
      { text: "있어요.”", start: 0.4, end: 0.8 },
      { text: "내게", start: 1.4, end: 1.7 },
      { text: "맞아요.", start: 1.7, end: 2.5 },
    ],
  });
  // When
  const captions = narrationCaptions([line]);
  // Then
  expect(captions.map((caption) => caption.text)).toEqual(["“안내돼 있어요.”", "내게 맞아요."]);
  expect(captions[0]?.endMs).toBe(800);
  expect(captions[1]?.startMs).toBe(1200);
});

test("cut text never replaces narration while someone is speaking", () => {
  const line = voice({ startMs: 0 });
  const captions = timelineCaptions(
    [line],
    [
      {
        index: 0,
        startMs: 1510,
        endMs: 2200,
        caption: { text: "직접 쓴 자막", startMs: 1510, endMs: 2200, style: "bottom" },
      },
    ],
  );
  expect(captions.some((caption) => caption.text === "직접 쓴 자막")).toBe(false);
  expect(captions).toEqual(narrationCaptions([line]));
});
