import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RenderTimeline } from "../../shared/render-timeline";
import { measureLoudness } from "../audio-probe";
import { StudioError } from "../errors";
import { probeProductionVideo } from "../production-video-probe";
import type { RenderEncoder } from "../provider-environment";
import { buildAudioGraph, MIX } from "./audio-mix";
import {
  type FfmpegRunner,
  ffmpegCapabilities,
  ffPath,
  fontOnlyDir,
  runFfmpeg,
  runFfprobeJson,
  writeFilterGraph,
} from "./ffmpeg";
import type { FontSet } from "./fonts";
import type { RenderProfile } from "./theme";

// 세그먼트 concat(-c copy) → 최종 1패스(자막 번인 + 오디오 믹스 + 인코딩) → 검증 → 리포트.
export const FINAL_TIMEOUT_MS = 600_000;
export type RenderReport = {
  readonly number: number;
  readonly durationMs: number;
  readonly measuredDurationMs: number;
  readonly width: number;
  readonly height: number;
  readonly segments: readonly string[];
  readonly inputDigests: Readonly<Record<string, string>>;
  readonly ffmpegVersion: string;
  readonly encoder: string;
  readonly integratedLufs: number;
  readonly truePeakDb: number;
  readonly lra: number;
  readonly bgm: { readonly id: string; readonly sha256: string; readonly license: string } | null;
  readonly warnings: readonly string[];
};
export type AssembleInput = {
  readonly timeline: RenderTimeline;
  readonly segments: readonly string[];
  readonly projectAudio: readonly { readonly path: string; readonly startMs: number }[];
  readonly voices: readonly { readonly path: string; readonly startMs: number }[];
  readonly bgm: {
    readonly path: string;
    readonly id: string;
    readonly sha256: string;
    readonly license: string;
  } | null;
  readonly captionsAss: string;
  readonly font: FontSet;
  readonly profile: RenderProfile;
  readonly scratch: string;
  readonly out: string;
  readonly encoder: RenderEncoder;
  readonly signal: AbortSignal;
  readonly run?: FfmpegRunner;
  readonly inputDigests?: Readonly<Record<string, string>>;
  readonly warnings?: readonly string[];
  // 길이 허용 범위(초). 기본은 완성 광고 규격 30~63초.
  readonly durationBounds?: readonly [number, number];
  // 테스트용 빠른 인코딩 프리셋
  readonly preset?: string;
};
const sec = (ms: number) => (ms / 1000).toFixed(3);
function concatEntry(path: string): string {
  return `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}
export function encoderArgs(
  encoder: RenderEncoder,
  profile: RenderProfile,
  preset?: string,
): string[] {
  const common = ["-pix_fmt", "yuv420p", "-r", String(profile.fps), "-g", String(profile.fps * 2)];
  if (encoder === "h264_nvenc")
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      preset ?? "p5",
      "-cq",
      "20",
      "-profile:v",
      "high",
      ...common,
    ];
  return [
    "-c:v",
    "libx264",
    "-preset",
    preset ?? "slow",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    ...common,
  ];
}
// 영상 스트림의 sample_aspect_ratio. ffprobe 가 값을 주지 않으면(N/A·0:1) 정사각으로 본다.
const AspectProbe = z.object({
  streams: z.array(z.object({ sample_aspect_ratio: z.string().optional() })),
});
async function probeSampleAspect(path: string, signal: AbortSignal): Promise<string> {
  const parsed = AspectProbe.parse(
    await runFfprobeJson(
      ["-select_streams", "v:0", "-show_entries", "stream=sample_aspect_ratio", path],
      signal,
    ),
  );
  const ratio = parsed.streams[0]?.sample_aspect_ratio;
  return !ratio || ratio === "N/A" || ratio === "0:1" ? "1:1" : ratio;
}
export async function assembleVideo(input: AssembleInput): Promise<RenderReport> {
  const run = input.run ?? runFfmpeg;
  const { timeline, profile, signal } = input;
  await mkdir(input.scratch, { recursive: true });
  const list = join(input.scratch, "concat.txt");
  await Bun.write(list, `${input.segments.map(concatEntry).join("\n")}\n`);
  const visual = join(input.scratch, "visual.mp4");
  await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", visual], {
    signal,
    timeoutMs: FINAL_TIMEOUT_MS,
  });
  // 입력 순서: 0 visual, 1..k 음성, bgm, 촬영본 오디오, 마지막 무음 베이스
  const args: string[] = ["-i", visual];
  let index = 1;
  const voice = input.voices.map((item) => {
    args.push("-i", item.path);
    return { index: index++, startMs: item.startMs };
  });
  let bgm: { index: number } | null = null;
  if (input.bgm) {
    args.push("-stream_loop", "-1", "-i", input.bgm.path);
    bgm = { index: index++ };
  }
  const project = input.projectAudio.map((item) => {
    args.push("-i", item.path);
    return { index: index++, startMs: item.startMs };
  });
  args.push("-f", "lavfi", "-t", sec(timeline.durationMs), "-i", "anullsrc=r=48000:cl=stereo");
  const silence = { index: index++ };
  // fontsdir 는 폰트만 담은 폴더(라이선스 텍스트가 섞이면 libass 가 컷마다 경고한다).
  const fontsDir = await fontOnlyDir(input.font, input.scratch);
  // setsar=1: 세그먼트 SAR 가 어긋나 있어도 최종 mp4 는 항상 정사각 픽셀로 낸다.
  const graph = [
    `[0:v]ass=${ffPath(input.captionsAss)}:fontsdir=${ffPath(fontsDir)},setsar=1[vout]`,
    buildAudioGraph({ voice, bgm, project, silence, durationMs: timeline.durationMs }),
  ].join(";\n");
  const graphPath = await writeFilterGraph(input.scratch, graph);
  const partial = `${input.out}.partial.mp4`;
  await rm(partial, { force: true });
  await run(
    [
      ...args,
      "-/filter_complex",
      graphPath,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      ...encoderArgs(input.encoder, profile, input.preset),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-t",
      sec(timeline.durationMs),
      "-f",
      "mp4",
      partial,
    ],
    { signal, timeoutMs: FINAL_TIMEOUT_MS },
  );
  await rename(partial, input.out);
  const probed = await probeProductionVideo(input.out, "mp4");
  const [minSec, maxSec] = input.durationBounds ?? [30, 63];
  const measuredMs = Math.round(probed.durationSec * 1000);
  if (
    probed.width !== profile.width ||
    probed.height !== profile.height ||
    !probed.hasAudio ||
    Math.abs(measuredMs - timeline.durationMs) > 250 ||
    probed.durationSec < minSec ||
    probed.durationSec > maxSec
  )
    throw new StudioError(
      "render_failed",
      `완성 영상 검증 실패: ${probed.width}x${probed.height} · ${probed.durationSec.toFixed(2)}초 · 오디오 ${probed.hasAudio ? "있음" : "없음"} (기대 ${profile.width}x${profile.height} · ${sec(timeline.durationMs)}초).`,
    );
  const pixelShape = await probeSampleAspect(input.out, signal);
  if (pixelShape !== "1:1")
    throw new StudioError(
      "render_failed",
      `완성 영상의 픽셀 비율이 정사각(1:1)이 아닙니다: ${pixelShape}.`,
    );
  const loudness = await measureLoudness(input.out, signal);
  if (
    loudness.integratedLufs < MIX.verify.minLufs ||
    loudness.integratedLufs > MIX.verify.maxLufs ||
    loudness.truePeakDb > MIX.verify.maxTruePeakDb
  )
    throw new StudioError(
      "render_loudness",
      `완성 영상 라우드니스가 범위를 벗어났습니다: ${loudness.integratedLufs.toFixed(1)} LUFS · 피크 ${loudness.truePeakDb.toFixed(1)} dBTP (허용 ${MIX.verify.minLufs}~${MIX.verify.maxLufs} LUFS · ≤${MIX.verify.maxTruePeakDb} dBTP).`,
    );
  const capabilities = await ffmpegCapabilities(signal).catch(() => null);
  return {
    number: timeline.number,
    durationMs: timeline.durationMs,
    measuredDurationMs: measuredMs,
    width: probed.width,
    height: probed.height,
    segments: input.segments.map((path) => path.replace(/\\/g, "/").split("/").pop() ?? path),
    inputDigests: input.inputDigests ?? {},
    ffmpegVersion: capabilities?.version ?? "unknown",
    encoder: input.encoder,
    integratedLufs: loudness.integratedLufs,
    truePeakDb: loudness.truePeakDb,
    lra: loudness.lra,
    bgm: input.bgm
      ? { id: input.bgm.id, sha256: input.bgm.sha256, license: input.bgm.license }
      : null,
    warnings: [...timeline.warnings, ...(input.warnings ?? [])],
  };
}
// ModelIdSchema 규칙에 맞는 ffmpeg 모델 ID(예: ffmpeg-8.1)
export function ffmpegModelId(version: string): string {
  const core = (version.split(/[-\s_]/)[0] ?? version).replace(/[^A-Za-z0-9.]/g, "");
  return `ffmpeg-${core || "unknown"}`;
}
