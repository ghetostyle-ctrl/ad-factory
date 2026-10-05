import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TimelineCut } from "../../shared/render-timeline";
import { cutGraphicAss } from "./ass";
import { type FfmpegRunner, ffPath, fontOnlyDir, runFfmpeg } from "./ffmpeg";
import type { FontSet } from "./fonts";
import { segmentEncodeArgs } from "./segments";
import { type RenderProfile, THEME } from "./theme";

export const SEGMENT_TIMEOUT_MS = 120_000;
const sec = (ms: number) => (ms / 1000).toFixed(3);
export function graphicFilter(profile: RenderProfile, assPath: string, font: FontSet): string {
  const { width, height, fps } = profile;
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "eq=brightness=-0.08",
    `ass=${ffPath(assPath)}:fontsdir=${ffPath(font.dir)}`,
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}
export async function renderGraphicCut(input: {
  readonly cut: TimelineCut;
  readonly background: string | null;
  readonly font: FontSet;
  readonly profile: RenderProfile;
  readonly out: string;
  readonly signal: AbortSignal;
  readonly run?: FfmpegRunner;
}): Promise<void> {
  const { cut, profile } = input;
  const durMs = cut.endMs - cut.startMs;
  await mkdir(dirname(input.out), { recursive: true });
  const assPath = `${input.out.replace(/\.mp4$/, "")}.ass`;
  await Bun.write(assPath, cutGraphicAss(cut, profile, input.font));
  // fontsdir 는 폰트만 담은 폴더를 쓴다(라이선스 텍스트를 폰트로 읽다 나는 libass 경고 방지).
  const fonts = { ...input.font, dir: await fontOnlyDir(input.font, dirname(input.out)) };
  const source = input.background
    ? ["-loop", "1", "-framerate", String(profile.fps), "-t", sec(durMs), "-i", input.background]
    : [
        "-f",
        "lavfi",
        "-t",
        sec(durMs),
        "-i",
        `color=c=0x${THEME.colors.background}:s=${profile.width}x${profile.height}:r=${profile.fps}`,
      ];
  await (input.run ?? runFfmpeg)(
    [
      ...source,
      "-vf",
      graphicFilter(profile, assPath, fonts),
      ...segmentEncodeArgs(profile),
      "-t",
      sec(durMs),
      input.out,
    ],
    { signal: input.signal, timeoutMs: SEGMENT_TIMEOUT_MS },
  );
}
