import { z } from "zod";
import type { TimelineVoice } from "./render-timeline";
import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";

// 자막 선행 시간 기본값. 계산은 thresholds().CAPTION_LEAD_MS(instructions/thresholds.json 주입값)를 호출 때 읽는다.
export const CAPTION_LEAD_MS = DEFAULT_THRESHOLDS.CAPTION_LEAD_MS;
export const CaptionSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  style: z.enum(["bottom", "pop"]),
  // One literal span, never ASS markup. Absent on previously saved timelines.
  keyword: z.string().optional(),
});
export type Caption = z.infer<typeof CaptionSchema>;
// 구절 자막 길이·표시 시간 한도(임계값 CAPTION_MIN_CHARS·CAPTION_LINE_MAX_CHARS·CAPTION_MIN_MS·CAPTION_MAX_MS). 호출 때 읽는다.
function captionLimits() {
  const limits = thresholds();
  return {
    minChars: limits.CAPTION_MIN_CHARS,
    maxChars: limits.CAPTION_LINE_MAX_CHARS,
    minMs: limits.CAPTION_MIN_MS,
    maxMs: limits.CAPTION_MAX_MS,
    leadMs: limits.CAPTION_LEAD_MS,
  };
}
const NUMERIC_SPAN =
  /[+-]?\d+(?:[,.]\d+)*(?:\s?(?:밀리그램|캡슐|개월|만원|천원|억원|퍼센트|kg|mg|ml|cm|mm|km|%|초|분|일|주|년|원|개|배|g|m))?/giu;

type Boundary = { readonly offset: number; readonly timeMs: number };
// 문장 글자 위치(offset, 코드포인트 기준) → 문장 안 시각(ms). 음성 단어 시각(voice.words)이 글과 순서대로 맞으면
// 단어 경계 사이를 보간하고, 하나라도 어긋나면 글자 수 비례로 돌아간다. 자막 끊기와 콜아웃 시각이 같은 규칙을 쓴다.
export function textTiming(voice: TimelineVoice, text: string): (offset: number) => number {
  const points: Boundary[] = [{ offset: 0, timeMs: 0 }];
  let cursor = 0;
  let previousMs = 0;
  let aligned = voice.words.length > 0;
  for (const word of voice.words) {
    const token = word.text.replace(/\s+/g, " ").trim();
    const at = token ? text.indexOf(token, cursor) : -1;
    const startMs = Math.round(word.start * 1000);
    const endMs = Math.round(word.end * 1000);
    if (
      at < 0 ||
      /[\p{L}\p{N}]/u.test(text.slice(cursor, at)) ||
      startMs < previousMs ||
      endMs <= startMs ||
      endMs > voice.durationMs + 50
    ) {
      aligned = false;
      break;
    }
    const offset = [...text.slice(0, at)].length;
    if (offset > 0) points.push({ offset, timeMs: startMs });
    else points[0] = { offset: 0, timeMs: startMs };
    points.push({ offset: offset + [...token].length, timeMs: Math.min(endMs, voice.durationMs) });
    cursor = at + token.length;
    previousMs = endMs;
  }
  const length = [...text].length;
  if (/[\p{L}\p{N}]/u.test(text.slice(cursor))) aligned = false;
  if (!aligned) return (offset) => Math.round((offset / Math.max(1, length)) * voice.durationMs);
  points.push({ offset: length, timeMs: voice.durationMs });
  return (offset) => {
    const next = points.find((point) => point.offset >= offset) ?? points[points.length - 1];
    const previous = points.findLast((point) => point.offset < offset) ?? points[0];
    if (!next || !previous) return 0;
    if (next.offset === previous.offset) return next.timeMs;
    return Math.round(
      previous.timeMs +
        ((offset - previous.offset) / (next.offset - previous.offset)) *
          (next.timeMs - previous.timeMs),
    );
  };
}

// Keep punctuation and ordinary words intact; 7–12 characters is a layout target,
// not semantic phrase analysis. Only overlong words use character-level fallback.
export function narrationCaptions(voices: readonly TimelineVoice[]): Caption[] {
  const { minChars, maxChars, minMs, maxMs, leadMs } = captionLimits();
  return voices.flatMap((voice, voiceIndex) => {
    const text = voice.text.replace(/\s+/g, " ").trim();
    const chars = [...text];
    if (!chars.length || voice.durationMs <= 0) return [];
    const timeAt = textTiming(voice, text);
    const numbers = [...text.matchAll(NUMERIC_SPAN)].map((match) => {
      const start = [...text.slice(0, match.index)].length;
      return { start, end: start + [...match[0]].length };
    });
    const phraseEnds = [...text.matchAll(/[,.!?。！？;；:：…—]+[”’"')\]）]*/gu)]
      .map((match) => [...text.slice(0, match.index + match[0].length)].length)
      .filter((end) => !numbers.some((span) => span.start < end && end < span.end));
    const costs = Array.from({ length: chars.length + 1 }, () => Number.POSITIVE_INFINITY);
    const ends = Array.from({ length: chars.length }, () => chars.length);
    costs[chars.length] = 0;
    for (let start = chars.length - 1; start >= 0; start--) {
      if (chars[start] === " ") {
        costs[start] = costs[start + 1] ?? 0;
        ends[start] = start + 1;
        continue;
      }
      const numberEnd = numbers.find((span) => span.start === start)?.end ?? 0;
      const phraseEnd = phraseEnds.find((end) => end > start) ?? chars.length;
      const wordEnd = chars.findIndex((char, offset) => offset > start && char === " ");
      const tokenEnd = Math.min(phraseEnd, wordEnd < 0 ? chars.length : wordEnd);
      const splitLongWord = tokenEnd - start > maxChars;
      const limit = Math.min(phraseEnd, Math.max(start + maxChars, numberEnd));
      for (let end = start + 1; end <= limit; end++) {
        if (numbers.some((span) => span.start < end && end < span.end)) continue;
        const value = chars.slice(start, end).join("").trimEnd();
        if (!value) continue;
        const length = [...value].length;
        const duration = timeAt(end) - timeAt(start);
        const wordBoundary = end === chars.length || chars[end] === " " || phraseEnds.includes(end);
        if (!wordBoundary && (!splitLongWord || end >= tokenEnd)) continue;
        const timingCost = Math.max(0, minMs - duration, duration - maxMs) / 10;
        // 실측(2026-10-06): "자꾸 깜빡해서 한 / 통을", "'하루 / 한 캡슐'"처럼 꾸밈말 한 글자나 따옴표 안에서 끊으면 어색하다.
        const lastWord = value.split(" ").at(-1) ?? "";
        const danglingWord = end < chars.length && [...lastWord].length === 1 ? 60 : 0;
        const openQuote = (value.match(/['"‘’“”]/gu)?.length ?? 0) % 2 === 1 ? 60 : 0;
        const cost =
          (costs[end] ?? 0) +
          (length - 10) ** 2 +
          Math.max(0, minChars - length) * 10 +
          (wordBoundary ? 0 : 50) +
          danglingWord +
          openQuote +
          timingCost;
        if (cost < (costs[start] ?? Number.POSITIVE_INFINITY)) {
          costs[start] = cost;
          ends[start] = end;
        }
      }
    }
    const chunks: { text: string; startMs: number; endMs: number }[] = [];
    for (let start = 0; start < chars.length; ) {
      const end = ends[start] ?? chars.length;
      const value = chars.slice(start, end).join("").trim();
      if (value) chunks.push({ text: value, startMs: timeAt(start), endMs: timeAt(end) });
      start = end;
    }
    return chunks.map((chunk, index) => {
      const next = chunks[index + 1];
      const followingVoice = voices[voiceIndex + 1];
      const startMs = Math.max(0, voice.startMs + chunk.startMs - leadMs);
      const nextStart = next
        ? voice.startMs + next.startMs - leadMs
        : (followingVoice?.startMs ?? Number.POSITIVE_INFINITY) - leadMs;
      const endMs = Math.min(
        voice.startMs + Math.max(chunk.endMs, chunk.startMs + minMs),
        nextStart,
        startMs + maxMs,
        voice.startMs + voice.durationMs,
      );
      // A numeric expression is a deterministic single keyword; no semantic claim is added.
      const keyword = chunk.text.match(NUMERIC_SPAN)?.[0];
      return {
        text: chunk.text,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        style: "bottom" as const,
        ...(keyword ? { keyword } : {}),
      };
    });
  });
}

// 자막은 내레이션 그 자체다: 음성 단어 시각으로 끊어 말과 글이 같고 싱크가 맞는다(사용자 결정 2026-10-06).
// 예전에는 컷 문구(onScreenText)가 자막을 덮어써서, 말과 다른 글이 단어 시각 없이 컷 길이에 고르게 나뉘어
// "물 한 / 컵 + 한 / 알로 끝"처럼 끊기고 말보다 최대 3초 늦게 떴다. 컷 문구는 말이 없는 컷에서만 자막으로 쓴다.
export function timelineCaptions(
  voices: readonly TimelineVoice[],
  cuts: readonly {
    readonly index: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly caption: Caption | null;
  }[],
): Caption[] {
  const spoken = narrationCaptions(voices);
  const { leadMs } = captionLimits();
  const silent = cuts.filter(
    (cut) =>
      cut.caption?.text.trim() &&
      !voices.some(
        (voice) => voice.startMs < cut.endMs && voice.startMs + voice.durationMs > cut.startMs,
      ),
  );
  const overrides = silent.flatMap((cut) =>
    narrationCaptions([
      {
        index: cut.index,
        text: cut.caption?.text ?? "",
        artifactName: "",
        tempo: 1,
        startMs: cut.startMs + leadMs,
        durationMs: Math.max(1, cut.endMs - cut.startMs - leadMs),
        words: [],
      },
    ]).map((caption) => ({ ...caption, style: cut.caption?.style ?? caption.style })),
  );
  return [...spoken, ...overrides].sort((left, right) => left.startMs - right.startMs);
}
