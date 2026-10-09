import { join } from "node:path";
import { buildAudioGraph } from "./audio-mix";
import { type FfmpegRunner, writeFilterGraph } from "./ffmpeg";

type AudioFile = {
  readonly path: string;
  readonly startMs: number;
  readonly sourceStartMs?: number;
  readonly durationMs?: number;
};
type AudioRenderInput = {
  readonly voices: readonly AudioFile[];
  readonly projectAudio: readonly AudioFile[];
  readonly bgm: { readonly path: string } | null;
  readonly durationMs: number;
  readonly scratch: string;
  readonly signal: AbortSignal;
  readonly run: FfmpegRunner;
  readonly timeoutMs: number;
};

// Render the sample clock independently: interleaved video demand can corrupt delayed amix PTS.
export async function renderAudioMix(input: AudioRenderInput): Promise<string> {
  const args: string[] = [];
  let index = 0;
  const voice = input.voices.map((item) => {
    if (item.sourceStartMs !== undefined) args.push("-ss", String(item.sourceStartMs / 1000));
    if (item.durationMs !== undefined) args.push("-t", String(item.durationMs / 1000));
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
  const duration = (input.durationMs / 1000).toFixed(3);
  args.push("-f", "lavfi", "-t", duration, "-i", "anullsrc=r=48000:cl=stereo");
  const graphPath = await writeFilterGraph(
    input.scratch,
    buildAudioGraph({ voice, bgm, project, silence: { index }, durationMs: input.durationMs }),
  );
  const out = join(input.scratch, "mixed-audio.wav");
  await input.run(
    [
      ...args,
      "-/filter_complex",
      graphPath,
      "-map",
      "[aout]",
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-t",
      duration,
      out,
    ],
    { signal: input.signal, timeoutMs: input.timeoutMs },
  );
  return out;
}
