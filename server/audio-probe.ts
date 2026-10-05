import { z } from "zod";
import { StudioError } from "./errors";
import { runFfmpegInfo, runFfprobeJson } from "./render/ffmpeg";

// 오디오 파일 프로브·라우드니스 실측. production-video-probe 는 영상 스트림이 필수라 wav 에는 못 쓴다.
const AudioProbeSchema = z.object({
  format: z.object({ duration: z.string().optional() }).optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        sample_rate: z.string().optional(),
        channels: z.number().int().optional(),
        duration: z.string().optional(),
      }),
    )
    .default([]),
});
export async function probeAudio(
  path: string,
  signal: AbortSignal,
): Promise<{ durationMs: number; sampleRate: number; channels: number }> {
  const parsed = AudioProbeSchema.safeParse(
    await runFfprobeJson(
      ["-show_entries", "format=duration:stream=codec_type,sample_rate,channels,duration", path],
      signal,
    ),
  );
  const audio = parsed.success
    ? parsed.data.streams.find((stream) => stream.codec_type === "audio")
    : undefined;
  const seconds = Number(parsed.success ? (parsed.data.format?.duration ?? audio?.duration) : NaN);
  if (!audio || !Number.isFinite(seconds) || seconds <= 0)
    throw new StudioError("audio_probe", "오디오 파일의 길이를 확인할 수 없습니다.", 400);
  return {
    durationMs: Math.round(seconds * 1000),
    sampleRate: Number(audio.sample_rate ?? 0),
    channels: audio.channels ?? 0,
  };
}

export type Loudness = { integratedLufs: number; truePeakDb: number; lra: number };
// ebur128 요약(stderr 꼬리)에서 통합 라우드니스·트루피크·LRA 를 읽는다. range 를 주면 그 구간만 잰다.
export function parseLoudness(stderr: string): Loudness {
  const integrated = /^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/m.exec(stderr);
  const peak = /^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/m.exec(stderr);
  const lra = /^\s*LRA:\s+(-?[\d.]+)\s+LU/m.exec(stderr);
  if (!integrated || !peak)
    throw new StudioError("audio_loudness", "ebur128 라우드니스 요약을 읽을 수 없습니다.");
  const number = (value: string) => (value === "-inf" ? Number.NEGATIVE_INFINITY : Number(value));
  return {
    integratedLufs: number(integrated[1] ?? "-inf"),
    truePeakDb: number(peak[1] ?? "-inf"),
    lra: Number(lra?.[1] ?? 0),
  };
}
export async function measureLoudness(
  path: string,
  signal: AbortSignal,
  range?: { readonly fromMs: number; readonly toMs: number },
): Promise<Loudness> {
  const window = range
    ? ["-ss", String(range.fromMs / 1000), "-t", String((range.toMs - range.fromMs) / 1000)]
    : [];
  const result = await runFfmpegInfo(
    [...window, "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { signal, timeoutMs: 120_000 },
  );
  return parseLoudness(result.stderrTail);
}
// 구간 RMS(dBFS). 덕킹 검증처럼 '말 구간 vs 공백 구간' 음량 비교에 쓴다.
export async function measureRms(
  path: string,
  signal: AbortSignal,
  range: { readonly fromMs: number; readonly toMs: number },
): Promise<number> {
  const result = await runFfmpegInfo(
    [
      "-ss",
      String(range.fromMs / 1000),
      "-t",
      String((range.toMs - range.fromMs) / 1000),
      "-i",
      path,
      "-vn",
      "-af",
      "astats=measure_perchannel=none:measure_overall=RMS_level",
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 120_000 },
  );
  const match = /RMS level dB:\s+(-?[\d.]+|-inf)/.exec(result.stderrTail);
  if (!match) throw new StudioError("audio_rms", "astats RMS 값을 읽을 수 없습니다.");
  return match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}
