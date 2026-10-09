import { expect, test } from "bun:test";
import { join } from "node:path";
import { captionsAss } from "../server/render/ass";
import { ffPath, fontOnlyDir } from "../server/render/ffmpeg";
import { resolveFont } from "../server/render/fonts";
import type { RenderTimeline } from "../shared/render-timeline";
import { removeTemp, renderTemp } from "./render-fixture";

const font = resolveFont();
const available = Boolean(Bun.which("ffmpeg")) && Boolean(font);

test.skipIf(!available)(
  "libass renders the moving target at both sampled positions and leaves its old position clear",
  async () => {
    if (!font) throw new Error("Missing test font");
    const root = await renderTemp("motion-callout-render-");
    try {
      const profile = { width: 360, height: 640, fps: 30 };
      const timeline: RenderTimeline = {
        number: 1,
        durationMs: 4000,
        extendedMs: 0,
        scriptDigest: "synthetic",
        voice: [],
        warnings: [],
        visualPolicy: "immersive_explanations_v1",
        cuts: [
          {
            index: 0,
            startMs: 0,
            endMs: 4000,
            purpose: "proof",
            source: "veo_clip",
            effect: "hard_cut",
            onScreenText: "",
            caption: null,
            graphicKind: "",
            graphicLines: [],
            sourceRef: { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
          },
        ],
        callouts: [
          {
            cutIndex: 0,
            text: "오일 원료",
            kind: "label",
            anchor: "top",
            color: 0,
            startMs: 0,
            endMs: 4000,
            motion: {
              targetId: "oil",
              verification: "verified",
              verifiedSource: "synthetic-frame-path",
              keyframes: [
                { at: 0, target: { x: 0.2, y: 0.48 }, label: { x: 0.25, y: 0.26 } },
                { at: 1, target: { x: 0.8, y: 0.48 }, label: { x: 0.75, y: 0.26 } },
              ],
            },
          },
        ],
      };
      const path = join(root, "motion.ass");
      await Bun.write(path, captionsAss(timeline, profile, font));
      const fonts = await fontOnlyDir(font, root);
      const frames = [1, 3].map((second) => {
        const result = Bun.spawnSync([
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=360x640:r=30:d=4",
          "-vf",
          `ass=${ffPath(path)}:fontsdir=${ffPath(fonts)}`,
          "-ss",
          String(second),
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout;
      });
      const accented = (pixels: Uint8Array, x: number): boolean => {
        for (let yy = 305; yy <= 309; yy++)
          for (let xx = x - 2; xx <= x + 2; xx++) {
            const index = (yy * profile.width + xx) * 3;
            if (
              (pixels[index] ?? 0) > 120 &&
              (pixels[index + 1] ?? 0) > 90 &&
              (pixels[index + 2] ?? 255) < 100
            )
              return true;
          }
        return false;
      };
      const [first, last] = frames;
      if (!first || !last) throw new Error("Missing sampled frame");
      expect(accented(first, 126)).toBe(true);
      expect(accented(first, 234)).toBe(false);
      expect(accented(last, 234)).toBe(true);
      expect(accented(last, 126)).toBe(false);
    } finally {
      await removeTemp(root);
    }
  },
);
