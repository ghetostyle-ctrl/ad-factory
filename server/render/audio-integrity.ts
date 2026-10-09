import { z } from "zod";
import { StudioError } from "../errors";
import { runFfprobeJson } from "./ffmpeg";

const AudioProbeSchema = z.object({
  streams: z.array(z.object({ sample_rate: z.coerce.number().int().positive() })).length(1),
  frames: z
    .array(
      z.object({
        best_effort_timestamp_time: z.coerce.number().finite(),
        nb_samples: z.number().int().positive(),
      }),
    )
    .min(1),
});

export type AudioIntegrity = {
  readonly frames: number;
  readonly sampleRate: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly decodedDurationMs: number;
  readonly maxClockDriftMs: number;
};

export function assertAudioIntegrity(probe: unknown, durationMs: number): AudioIntegrity {
  const parsed = AudioProbeSchema.safeParse(probe);
  if (!parsed.success)
    throw new StudioError("render_failed", "완성 영상의 오디오 프레임 시각을 확인할 수 없습니다.");
  const { frames, streams } = parsed.data;
  const first = frames[0];
  const stream = streams[0];
  if (!first || !stream)
    throw new StudioError("render_failed", "완성 영상에 검증할 오디오 프레임이 없습니다.");
  const startMs = first.best_effort_timestamp_time * 1000;
  let samples = 0;
  let endMs = startMs;
  let maxClockDriftMs = 0;
  for (const frame of frames) {
    const atMs = frame.best_effort_timestamp_time * 1000;
    const driftMs = Math.abs(atMs - startMs - (samples * 1000) / stream.sample_rate);
    maxClockDriftMs = Math.max(maxClockDriftMs, driftMs);
    // AAC priming/padding affects the edges, not the continuous decoded sample clock.
    if (driftMs > 5)
      throw new StudioError(
        "render_failed",
        `완성 영상 오디오 시각이 ${Math.round(atMs)}ms에서 ${driftMs.toFixed(1)}ms 어긋납니다. 다시 조립해야 합니다.`,
      );
    samples += frame.nb_samples;
    endMs = atMs + (frame.nb_samples * 1000) / stream.sample_rate;
  }
  if (Math.abs(startMs) > 250 || Math.abs(endMs - durationMs) > 250)
    throw new StudioError(
      "render_failed",
      `완성 영상 오디오 범위가 영상과 일치하지 않습니다: ${Math.round(startMs)}~${Math.round(endMs)}ms (기대 0~${durationMs}ms).`,
    );
  return {
    frames: frames.length,
    sampleRate: stream.sample_rate,
    startMs,
    endMs,
    decodedDurationMs: (samples * 1000) / stream.sample_rate,
    maxClockDriftMs,
  };
}

export async function probeAudioIntegrity(
  path: string,
  durationMs: number,
  signal: AbortSignal,
): Promise<AudioIntegrity> {
  return assertAudioIntegrity(
    await runFfprobeJson(
      [
        "-select_streams",
        "a:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time,nb_samples:stream=sample_rate",
        path,
      ],
      signal,
    ),
    durationMs,
  );
}
