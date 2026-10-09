import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { StudioError } from "../server/errors";
import { assertAudioIntegrity, probeAudioIntegrity } from "../server/render/audio-integrity";

import { runFfmpeg } from "../server/render/ffmpeg";
import { removeTemp, renderTemp } from "./render-fixture";

function probe(seconds: readonly number[], samples = 1024) {
  return {
    streams: [{ sample_rate: "48000" }],
    frames: seconds.map((time) => ({
      best_effort_timestamp_time: time.toFixed(6),
      nb_samples: samples,
    })),
  };
}

test("rejects AAC frames whose timestamps stop advancing with decoded samples", () => {
  // Given: the consecutive timestamps captured from the affected output at 7.38s.
  const captured = probe([7.36, 7.381333, 7.381354]);
  const frames = probe(Array.from({ length: 345 }, (_, index) => (index * 1024) / 48000)).frames;
  const corrupted = { ...captured, frames: [...frames, ...captured.frames] };
  // When / Then: the output must fail, even though its container duration and audio track exist.
  expect(() => assertAudioIntegrity(corrupted, 7424)).toThrow(StudioError);
});

test("accepts continuous samples with legitimate AAC edge padding", () => {
  // Given: AAC's final 1024-sample frame extends slightly beyond the container.
  const input = probe(Array.from({ length: 47 }, (_, index) => (index * 1024) / 48000));
  // When: decoded frame timestamps are checked against a one-second render.
  const result = assertAudioIntegrity(input, 1000);
  // Then: sub-millisecond timestamp rounding and edge padding remain valid.
  expect(result.maxClockDriftMs).toBeLessThan(0.001);
  expect(result.endMs).toBeCloseTo(1002.667, 2);
});

test("rejects cumulative timestamp drift even when individual intervals differ by less than 5ms", () => {
  // Given: 100 frames gain 0.1ms per interval.
  const input = probe(Array.from({ length: 100 }, (_, index) => index * (1024 / 48000 + 0.0001)));
  // When / Then: errors cannot accumulate below the interval threshold.
  expect(() => assertAudioIntegrity(input, 2143)).toThrow(StudioError);
});

test.each([
  {
    name: "missing timestamps",
    input: { streams: [{ sample_rate: "48000" }], frames: [{ nb_samples: 1024 }] },
    duration: 1000,
  },
  { name: "empty audio", input: { streams: [], frames: [] }, duration: 1000 },
  { name: "late audio start", input: probe([0.4, 0.421333]), duration: 443 },
  { name: "truncated audio ending", input: probe([0, 0.021333]), duration: 1000 },
])("rejects $name with a render failure", ({ input, duration }) => {
  // Given: incomplete audio metadata or an out-of-bounds audio clock.
  // When / Then: callers receive the app's typed production failure.
  try {
    assertAudioIntegrity(input, duration);
    throw new Error("expected audio integrity rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(StudioError);
    if (error instanceof StudioError) expect(error.code).toBe("render_failed");
  }
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-audio-integrity-");
});
afterAll(async () => {
  await removeTemp(root);
});

test.skipIf(!hasFfmpeg)(
  "accepts a real AAC encode and rejects compressed frame timestamps",
  async () => {
    // Given: one continuous AAC fixture and one whose sample timestamps are compressed.
    const signal = new AbortController().signal;
    const normal = join(root, "normal.m4a");
    const compressed = join(root, "compressed.m4a");
    const make = async (out: string, filter: string) =>
      runFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=1.2",
          "-af",
          filter,
          "-c:a",
          "aac",
          out,
        ],
        { signal, timeoutMs: 30_000 },
      );
    await make(normal, "anull");
    await make(compressed, "asetpts=PTS/2");
    // When: the actual ffprobe decoded-frame adapter checks both files.
    const good = await probeAudioIntegrity(normal, 1200, signal);
    // Then: codec priming and padding pass; invalid timestamps cannot become a final video.
    expect(good.maxClockDriftMs).toBeLessThan(0.001);
    await expect(probeAudioIntegrity(compressed, 1200, signal)).rejects.toMatchObject({
      code: "render_failed",
    });
  },
  60_000,
);
