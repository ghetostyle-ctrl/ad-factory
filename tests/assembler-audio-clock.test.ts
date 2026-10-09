import { expect, test } from "bun:test";
import { join } from "node:path";
import { captionsAss } from "../server/render/ass";
import { assembleVideo } from "../server/render/assembler";
import { resolveFont } from "../server/render/fonts";
import type { RenderTimeline } from "../shared/render-timeline";
import { removeTemp, renderProfile, renderTemp, tinyClip, toneWav } from "./render-fixture";

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const font = resolveFont();
const starts = [0, 4350, 7350, 11750, 19350, 22950, 26550, 30950, 35350];
const lengths = [4050, 2850, 3950, 4400, 3300, 2750, 3700, 4100, 3000];

test.skipIf(!hasFfmpeg || !font)(
  "nine delayed narration files remain audible at their scheduled times after video muxing",
  async () => {
    if (!font) return;
    const root = await renderTemp("studio-audio-clock-");
    try {
      const voice = starts.map((startMs, index) => ({
        index,
        text: `sentence ${index + 1}`,
        artifactName: `voice-${index}.wav`,
        startMs,
        durationMs: lengths[index] ?? 3000,
        tempo: 1,
        words: [],
      }));
      const timeline: RenderTimeline = {
        number: 1,
        durationMs: 38650,
        extendedMs: 0,
        scriptDigest: "0".repeat(64),
        cuts: [],
        voice,
        captions: [],
        warnings: [],
      };
      const captions = join(root, "captions.ass");
      await Bun.write(captions, captionsAss(timeline, renderProfile, font));
      const out = join(root, "final.mp4");
      await assembleVideo({
        timeline,
        segments: [tinyClip(join(root, "visual.mp4"), 38.65)],
        voices: voice.map((line) => ({
          path: toneWav(
            join(root, line.artifactName),
            line.durationMs / 1000,
            440 + 70 * line.index,
          ),
          startMs: line.startMs,
        })),
        projectAudio: [],
        bgm: null,
        captionsAss: captions,
        font,
        profile: renderProfile,
        scratch: join(root, "scratch"),
        out,
        encoder: "libx264",
        preset: "ultrafast",
        signal: new AbortController().signal,
      });
      const decoded = Bun.spawnSync([
        "ffmpeg",
        "-v",
        "error",
        "-i",
        out,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      expect(decoded.exitCode).toBe(0);
      const pcm = Buffer.from(decoded.stdout);
      expect(Math.abs((pcm.length / 4 / 8000) * 1000 - timeline.durationMs)).toBeLessThan(100);
      for (const line of voice) {
        const startSample = Math.round(((line.startMs + 1000) / 1000) * 8000);
        const energy = voice.map((candidate) => {
          let real = 0;
          let imaginary = 0;
          for (let sample = 0; sample < 1200; sample++) {
            const value = pcm.readFloatLE((startSample + sample) * 4);
            const angle = (2 * Math.PI * (440 + 70 * candidate.index) * sample) / 8000;
            real += value * Math.cos(angle);
            imaginary += value * Math.sin(angle);
          }
          return Math.hypot(real, imaginary) / 1200;
        });
        expect(energy.indexOf(Math.max(...energy))).toBe(line.index);
        expect(energy[line.index] ?? 0).toBeGreaterThan(0.03);
      }
    } finally {
      await removeTemp(root);
    }
  },
  120_000,
);
