import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { runFfmpeg } from "../server/render/ffmpeg";
import { segmentDigest, stillSegmentArgs } from "../server/render/segments";
import { artworkTopRatio } from "../server/render/theme";
import type { TimelineCut } from "../shared/render-timeline";
import { removeTemp, renderProfile, renderTemp } from "./render-fixture";

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-text-framing-");
});
afterAll(async () => {
  await removeTemp(root);
});
const cut: TimelineCut = {
  index: 0,
  startMs: 0,
  endMs: 800,
  purpose: "proof",
  source: "approved_image",
  effect: "zoom_punch",
  onScreenText: "",
  caption: null,
  graphicKind: "",
  graphicLines: [],
  sourceRef: { kind: "image", artifactName: "art.png" },
};

test("approved artwork and cards keep a stable frame even when their old cut requests a crop effect", () => {
  // Given: text-bearing source types from existing scripts.
  for (const source of ["approved_image", "card_slide"] as const) {
    for (const effect of ["zoom_punch", "shake", "split_screen", "whip_pan"] as const) {
      // When
      const args = stillSegmentArgs(
        { ...cut, source, effect },
        "art.png",
        renderProfile,
        "o.mp4",
        "in",
      );
      const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
      // Then: no image area is discarded to animate a text card.
      expect(graph).toContain("force_original_aspect_ratio=decrease");
      expect(graph).not.toContain("zoompan");
      expect(graph).not.toContain("hstack");
      expect(graph).not.toContain("rgbashift");
      expect(graph).not.toContain("dblur");
    }
  }
});

test.skipIf(!hasFfmpeg)(
  "real render preserves all four artwork corners for tall and wide cards",
  async () => {
    // Given: colored corner labels at the very edge of unusually tall/wide artwork.
    for (const [width, height] of [
      [160, 320],
      [320, 160],
    ] as const) {
      const image = join(root, `art-${width}.png`);
      const out = join(root, `art-${width}.mp4`);
      await runFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          `color=c=black:s=${width}x${height}:r=1`,
          "-vf",
          [
            "drawbox=x=0:y=0:w=24:h=24:color=red:t=fill",
            `drawbox=x=${width - 24}:y=0:w=24:h=24:color=lime:t=fill`,
            `drawbox=x=0:y=${height - 24}:w=24:h=24:color=blue:t=fill`,
            `drawbox=x=${width - 24}:y=${height - 24}:w=24:h=24:color=yellow:t=fill`,
          ].join(","),
          "-frames:v",
          "1",
          image,
        ],
        { signal: new AbortController().signal, timeoutMs: 20_000 },
      );
      // When: the legacy zoom-punch cut renders a full segment.
      await runFfmpeg(stillSegmentArgs(cut, image, renderProfile, out, "out"), {
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      // Then: every corner remains visible above the spoken-caption region, at both ends.
      for (const seconds of [0.1, 0.6]) {
        const frame = Bun.spawnSync([
          "ffmpeg",
          "-v",
          "error",
          "-ss",
          String(seconds),
          "-i",
          out,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        expect(frame.exitCode).toBe(0);
        const counts = [0, 0, 0, 0];
        for (let y = 58; y < 131; y++) {
          for (let x = 7; x < 101; x++) {
            const offset = (y * 108 + x) * 3;
            const r = frame.stdout[offset] ?? 0;
            const g = frame.stdout[offset + 1] ?? 0;
            const b = frame.stdout[offset + 2] ?? 0;
            const color =
              r > 150 && g < 80 && b < 80
                ? 0
                : g > 150 && r < 80 && b < 80
                  ? 1
                  : b > 150 && r < 80 && g < 80
                    ? 2
                    : r > 150 && g > 150 && b < 80
                      ? 3
                      : -1;
            if (color >= 0) counts[color] = (counts[color] ?? 0) + 1;
          }
        }
        for (const count of counts) expect(count).toBeGreaterThan(4);
      }
    }
  },
  60_000,
);

test("artwork uses only the space reserved by its actual headers and invalidates cached geometry", () => {
  expect(artworkTopRatio({})).toBe(0.067);
  expect(artworkTopRatio({ fixedTitle: ["", " "] })).toBe(0.067);
  expect(artworkTopRatio({ fixedTitle: ["첫 줄", "둘째 줄"] })).toBe(0.22);
  expect(artworkTopRatio({ fixedTitle: ["첫 줄"], disclaimer: "원료에 관한 설명입니다" })).toBe(
    0.3,
  );
  const base = {
    cut,
    sourceDigest: "source",
    themeVersion: 2,
    fontDigest: "font",
    profile: renderProfile,
  };
  expect(segmentDigest({ ...base, artworkTop: 0.22 })).not.toBe(
    segmentDigest({ ...base, artworkTop: 0.3 }),
  );
});
