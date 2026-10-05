import { z } from "zod";
import type { TimelineVoice } from "./render-timeline";

export const CAPTION_LEAD_MS = 200;
export const CaptionSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  style: z.enum(["bottom", "pop"]),
  // One literal span, never ASS markup. Absent on previously saved timelines.
  keyword: z.string().optional(),
});
export type Caption = z.infer<typeof CaptionSchema>;
const MIN_CHARS = 7;
const MAX_CHARS = 12;
const MIN_MS = 500;
const MAX_MS = 2000;
const NUMERIC_SPAN =
  /[+-]?\d+(?:[,.]\d+)*(?:\s?(?:밀리그램|캡슐|개월|만원|천원|억원|퍼센트|kg|mg|ml|cm|mm|km|%|초|분|일|주|년|원|개|배|g|m))?/giu;

type Boundary = { readonly offset: number; readonly timeMs: number };
function textTiming(voice: TimelineVoice, text: string): (offset: number) => number {
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
  return voices.flatMap((voice, voiceIndex) => {
    const text = voice.text.replace(/\s+/g, " ").trim();
    const chars = [...text];
    if (!chars.length || voice.durationMs <= 0) return [];
    const timeAt = textTiming(voice, text);
    const numbers = [...text.matchAll(NUMERIC_SPAN)].map((match) => {
      const start = [...text.slice(0, match.index)].length;
      return { start, end: start + [...match[0]].length };
    });
    const phraseEnds = [...text.matchAll(/[,.!?。！？;；:：…]+[”’"')\]）]*/gu)]
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
      const splitLongWord = tokenEnd - start > MAX_CHARS;
      const limit = Math.min(phraseEnd, Math.max(start + MAX_CHARS, numberEnd));
      for (let end = start + 1; end <= limit; end++) {
        if (numbers.some((span) => span.start < end && end < span.end)) continue;
        const value = chars.slice(start, end).join("").trimEnd();
        if (!value) continue;
        const length = [...value].length;
        const duration = timeAt(end) - timeAt(start);
        const wordBoundary = end === chars.length || chars[end] === " " || phraseEnds.includes(end);
        if (!wordBoundary && (!splitLongWord || end >= tokenEnd)) continue;
        const timingCost = Math.max(0, MIN_MS - duration, duration - MAX_MS) / 10;
        const cost =
          (costs[end] ?? 0) +
          (length - 10) ** 2 +
          Math.max(0, MIN_CHARS - length) * 10 +
          (wordBoundary ? 0 : 50) +
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
      const startMs = Math.max(0, voice.startMs + chunk.startMs - CAPTION_LEAD_MS);
      const nextStart = next
        ? voice.startMs + next.startMs - CAPTION_LEAD_MS
        : (followingVoice?.startMs ?? Number.POSITIVE_INFINITY) - CAPTION_LEAD_MS;
      const endMs = Math.min(
        voice.startMs + Math.max(chunk.endMs, chunk.startMs + MIN_MS),
        nextStart,
        startMs + MAX_MS,
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

// Authored on-screen text remains an explicit override, including silent cuts.
// Uncovered intervals keep the measured speech track, independent of cut boundaries.
export function timelineCaptions(
  voices: readonly TimelineVoice[],
  cuts: readonly {
    readonly index: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly caption: Caption | null;
  }[],
): Caption[] {
  const authored = cuts.filter((cut) => cut.caption?.text.trim());
  let spoken = narrationCaptions(voices).map((caption) => ({ caption, clipped: false }));
  for (const cut of authored) {
    spoken = spoken.flatMap((item) => {
      const { caption } = item;
      if (caption.endMs <= cut.startMs || caption.startMs >= cut.endMs) return [item];
      return [
        ...(caption.startMs < cut.startMs
          ? [{ caption: { ...caption, endMs: cut.startMs }, clipped: true }]
          : []),
        ...(caption.endMs > cut.endMs
          ? [{ caption: { ...caption, startMs: cut.endMs }, clipped: true }]
          : []),
      ];
    });
  }
  const merge = (left: Caption, right: Caption): Caption | null => {
    const duration = right.endMs - left.startMs;
    if (left.endMs !== right.startMs || duration < MIN_MS || duration > MAX_MS) return null;
    if (/[,.!?。！？;；:：…][”’"')\]）]*$/u.test(left.text)) return null;
    const text = [[left.text, right.text].join(" "), left.text + right.text].find(
      (value) =>
        [...value].length <= MAX_CHARS && voices.some((voice) => voice.text.includes(value)),
    );
    return text ? { ...left, text, endMs: right.endMs } : null;
  };
  const readable: Caption[] = [];
  for (let index = 0; index < spoken.length; index++) {
    const item = spoken[index];
    if (!item) continue;
    if (!item.clipped || item.caption.endMs - item.caption.startMs >= MIN_MS) {
      readable.push(item.caption);
      continue;
    }
    const previous = readable.at(-1);
    const before = previous ? merge(previous, item.caption) : null;
    if (before) {
      readable[readable.length - 1] = before;
      continue;
    }
    const next = spoken[index + 1];
    const after = next ? merge(item.caption, next.caption) : null;
    if (after) {
      readable.push(after);
      index++;
    }
    // The authored override covers the rest; omit only an unreadable clipped fragment.
  }
  const overrides = authored.flatMap((cut) =>
    narrationCaptions([
      {
        index: cut.index,
        text: cut.caption?.text ?? "",
        artifactName: "",
        tempo: 1,
        startMs: cut.startMs + CAPTION_LEAD_MS,
        durationMs: Math.max(1, cut.endMs - cut.startMs - CAPTION_LEAD_MS),
        words: [],
      },
    ]).map((caption) => ({ ...caption, style: cut.caption?.style ?? caption.style })),
  );
  return [...readable, ...overrides].sort((left, right) => left.startMs - right.startMs);
}
