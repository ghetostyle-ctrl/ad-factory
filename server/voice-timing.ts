import type { VoiceLineRecord } from "../shared/render-state";
import type { VoiceMeasurement } from "../shared/render-timeline";
import { runFfmpegInfo } from "./render/ffmpeg";

// Trim only proven leading/trailing quiet audio; preserve internal pauses and timestamped speech.
export async function speechMeasurement(
  record: VoiceLineRecord,
  path: string,
  signal: AbortSignal,
): Promise<VoiceMeasurement> {
  const result = await runFfmpegInfo(
    ["-i", path, "-vn", "-af", "silencedetect=noise=-38dB:d=0.12", "-f", "null", "-"],
    { signal, timeoutMs: 60_000 },
  );
  const spans: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const match of result.stderrTail.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    const time = Number(match[2]) * 1000;
    if (match[1] === "start") start = time;
    else if (start !== null) {
      spans.push({ start, end: time });
      start = null;
    }
  }
  if (start !== null) spans.push({ start, end: record.durationMs });
  const leading = spans.find((span) => span.start <= 1),
    trailing = spans.find((span) => span.end >= record.durationMs - 30);
  let from = Math.max(0, (leading?.end ?? 0) - 40);
  let to = Math.min(record.durationMs, (trailing?.start ?? record.durationMs) + 100);
  const first = record.words[0],
    last = record.words.at(-1);
  if (first) from = Math.min(from, Math.max(0, first.start * 1000 - 40));
  if (last) to = Math.max(to, Math.min(record.durationMs, last.start * 1000 + 120));
  if (to - from < 200) {
    from = 0;
    to = record.durationMs;
  }
  from = Math.floor(from);
  to = Math.ceil(to);
  return {
    index: record.index,
    durationMs: to - from,
    tempo: record.tempo,
    attempt: record.attempt,
    artifactName: record.name,
    sourceStartMs: from,
    words: record.words.map((word) => ({
      ...word,
      start: Math.max(0, word.start - from / 1000),
      end: Math.min((to - from) / 1000, word.end - from / 1000),
    })),
  };
}
