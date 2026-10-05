import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { StudioError } from "../server/errors";
import { MusicLibrary } from "../server/music-library";
import {
  type FfmpegRunner,
  ffmpegCapabilities,
  runFfmpeg,
  runFfprobeJson,
} from "../server/render/ffmpeg";
import { resolveFont } from "../server/render/fonts";
import { renderGraphicCut } from "../server/render/motion-graphics";
import { renderPreflight } from "../server/render/preflight";
import { JobStore } from "../server/store";
import type { TimelineCut } from "../shared/render-timeline";
import { GraphicKindSchema } from "../shared/video-script";
import { automationBrief } from "./automation-fixture";
import { removeTemp, renderProfile, renderScript, renderTemp, tinyStill } from "./render-fixture";

// 모션그래픽 5종을 108x192·1.2초로 실제 렌더(libass). 폰트는 번들 Pretendard → FONT_DIR → malgunbd 순.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const font = resolveFont();
if (!hasFfmpeg || !font)
  console.log("미검증: ffmpeg 또는 한글 폰트가 없어 모션그래픽 렌더 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
});
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-graphics-");
});
afterAll(async () => {
  await removeTemp(root);
});
function graphicCut(
  kind: Exclude<z.infer<typeof GraphicKindSchema>, "">,
  lines: string[],
  index = 0,
): TimelineCut {
  return {
    index,
    startMs: 0,
    endMs: 1200,
    purpose: "mechanism",
    source: "motion_graphic",
    effect: "hard_cut",
    onScreenText: "",
    caption: null,
    graphicKind: kind,
    graphicLines: lines,
    sourceRef: { kind: "graphic" },
  };
}

test.skipIf(!hasFfmpeg || !font)(
  "renders every graphic kind as a silent portrait segment of the cut length",
  async () => {
    if (!font) return;
    const still = tinyStill(join(root, "bg.png"));
    const kinds = GraphicKindSchema.options.filter(
      (kind): kind is Exclude<typeof kind, ""> => kind !== "",
    );
    expect(kinds).toHaveLength(5);
    // 아포스트로피가 든 폴더에 렌더한다: ass·fontsdir 경로 이스케이프가 5종 모두에서 실제로 통과해야 한다
    const outDir = join(root, "it's 한글 dir");
    for (const [index, kind] of kinds.entries()) {
      const out = join(outDir, `seg-${kind}.mp4`);
      await renderGraphicCut({
        cut: graphicCut(kind, ["600mg", "하루 한 번", "국내 생산"], index),
        background: index % 2 === 0 ? still : null,
        font,
        profile: renderProfile,
        out,
        signal: signal(),
      });
      const parsed = Probe.parse(
        await runFfprobeJson(
          ["-show_entries", "format=duration:stream=codec_type,width,height", out],
          signal(),
        ),
      );
      const video = parsed.streams.find((stream) => stream.codec_type === "video");
      expect([video?.width, video?.height]).toEqual([108, 192]);
      expect(parsed.streams.some((stream) => stream.codec_type === "audio")).toBe(false);
      expect(Math.abs(Number(parsed.format.duration) - 1.2)).toBeLessThanOrEqual(0.11);
      expect(await Bun.file(out.replace(/\.mp4$/, ".ass")).exists()).toBe(true);
    }
  },
  120_000,
);

test.skipIf(!hasFfmpeg || !font)(
  "an injected runner sees the ass filter with escaped fontsdir and no drawtext",
  async () => {
    if (!font) return;
    const calls: string[][] = [];
    const spy: FfmpegRunner = async (args) => {
      calls.push([...args]);
      return { stderrTail: "" };
    };
    await renderGraphicCut({
      cut: graphicCut("number", ["7"]),
      background: null,
      font,
      profile: renderProfile,
      out: join(root, "spy.mp4"),
      signal: signal(),
      run: spy,
    });
    expect(calls).toHaveLength(1);
    const filter = calls[0]?.[calls[0].indexOf("-vf") + 1] ?? "";
    expect(filter).toContain("ass='");
    // fontsdir 는 번들 폰트 폴더가 아니라 출력 폴더 아래의 폰트 전용 폴더(라이선스 텍스트 제외)
    const fontsDir = join(root, "fonts").replace(/\\/g, "/");
    expect(filter).toContain(`:fontsdir='${fontsDir.replace(/:/g, "\\:")}'`);
    expect(filter).not.toContain(font.dir.replace(/:/g, "\\:"));
    expect((await readdir(fontsDir)).sort()).toEqual([font.bold, font.medium].sort());
    expect(filter).not.toContain("drawtext");
    expect(filter).not.toContain("drawbox=");
    expect(filter).not.toContain("gblur=");
    expect(calls[0]?.slice(0, 4)).toEqual(["-f", "lavfi", "-t", "1.200"]);
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "preflight stops with render_unavailable when FONT_DIR points nowhere",
  async () => {
    const store = new JobStore(await renderTemp("studio-preflight-"));
    try {
      const job = store.create(automationBrief);
      const withScript = store.change(job.id, (draft) => {
        draft.videoScripts = [renderScript(1, "concept-1", 36)];
      });
      const deps = {
        capabilities: ffmpegCapabilities,
        resolveFont: () => null,
        music: new MusicLibrary(join(root, "no-bgm")),
        subscription: async () => ({
          plan: "lite",
          planCredits: 1000,
          usedCredits: 0,
          concurrencyLimit: 5,
        }),
        credentials: () => ({ openai: "k", gemini: "k", typecast: "k" }),
        encoder: "libx264" as const,
      };
      const failure = renderPreflight(withScript, 1, deps);
      await expect(failure).rejects.toBeInstanceOf(StudioError);
      await expect(failure).rejects.toMatchObject({ code: "render_unavailable", status: 503 });
      // 폰트가 있으면 통과하고 빈 BGM 은 경고
      const ok = await renderPreflight(withScript, 1, { ...deps, resolveFont });
      expect(ok.concurrencyLimit).toBe(5);
      expect(ok.warnings.some((warning) => warning.includes("BGM"))).toBe(true);
      // 크레딧 부족
      await expect(
        renderPreflight(withScript, 1, {
          ...deps,
          resolveFont,
          subscription: async () => ({
            plan: "lite",
            planCredits: 100,
            usedCredits: 90,
            concurrencyLimit: 5,
          }),
        }),
      ).rejects.toMatchObject({ code: "typecast_credit" });
      // 키 부재는 blocked 계열
      await expect(
        renderPreflight(withScript, 1, {
          ...deps,
          resolveFont,
          credentials: () => ({ openai: "k", gemini: "k", typecast: "" }),
        }),
      ).rejects.toMatchObject({ name: "MissingConnectionError" });
    } finally {
      store.close();
      await removeTemp(store.root);
    }
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "runFfmpeg with the real binary is available for the segment tests",
  async () => {
    await runFfmpeg(
      ["-f", "lavfi", "-i", "color=c=red:s=16x16:r=5", "-t", "0.2", join(root, "ok.mp4")],
      { signal: signal(), timeoutMs: 20_000 },
    );
    expect(await Bun.file(join(root, "ok.mp4")).exists()).toBe(true);
  },
  60_000,
);
