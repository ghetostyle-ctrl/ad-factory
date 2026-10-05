import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { assHeader, captionsAss } from "../server/render/ass";
import { assembleVideo, ffmpegModelId } from "../server/render/assembler";
import { type FfmpegRunner, runFfmpeg, runFfprobeJson } from "../server/render/ffmpeg";
import { resolveFont } from "../server/render/fonts";
import { renderGraphicCut } from "../server/render/motion-graphics";
import {
  lastFrameArgs,
  projectAudioExtractArgs,
  projectSegmentArgs,
  stillSegmentArgs,
  veoSegmentArgs,
} from "../server/render/segments";
import { ModelIdSchema } from "../shared/models";
import { buildTimeline, type RenderTimeline } from "../shared/render-timeline";
import {
  noiseBgm,
  projectClip,
  removeTemp,
  renderProfile,
  renderScript,
  renderTemp,
  tinyClip,
  tinyStill,
  toneWav,
} from "./render-fixture";

// renderScript(소스 5종·효과 8종·클립 A~D·촬영본·카드 2장·모션그래픽) 전체를 108x192 로 조립한다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const font = resolveFont();
if (!hasFfmpeg || !font) console.log("미검증: ffmpeg 또는 폰트가 없어 조립 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-assembler-");
});
afterAll(async () => {
  await removeTemp(root);
});

test("ffmpegModelId normalises the version for ModelIdSchema", () => {
  expect(ffmpegModelId("8.1-full_build-www.gyan.dev")).toBe("ffmpeg-8.1");
  expect(ffmpegModelId("N-120000-g1234abcd")).toBe("ffmpeg-N");
  expect(ModelIdSchema.safeParse(ffmpegModelId("8.1-full_build")).success).toBe(true);
});

test.skipIf(!hasFfmpeg || !font)(
  "assembles a faststart MP4 of the timeline length with captions, narration and BGM",
  async () => {
    if (!font) return;
    const script = renderScript(1, "concept-1", 36);
    const built = buildTimeline(
      script,
      script.voiceover.map((voice, index) => ({
        index,
        // 문장은 컷 범위에 묶여 있으므로 실측은 그 범위(1~3초)보다 0.5초 짧게 둔다
        durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
        tempo: 1,
        artifactName: `voice-1-${String(index + 1).padStart(2, "0")}-1.wav`,
      })),
      {
        sources: {
          approvedImage: "image-concept-1-1.png",
          cards: ["card-concept-1-2-1.png", "card-concept-1-3-1.png"],
          projectAssets: [],
        },
      },
    );
    if (!("timeline" in built)) throw new Error("timeline expected");
    const timeline = built.timeline;
    const clips = Object.fromEntries(
      (["A", "B", "C", "D"] as const).map((id, index) => [
        id,
        tinyClip(join(root, `clip-${id}.mp4`), 8, ["blue", "red", "green", "gray"][index]),
      ]),
    );
    const still = tinyStill(join(root, "approved.png"));
    const card = tinyStill(join(root, "card.png"), "purple");
    const project = projectClip(join(root, "project.mp4"), 4);
    const calls: string[][] = [];
    const spy: FfmpegRunner = (args, options) => {
      calls.push([...args]);
      return runFfmpeg(args, options);
    };
    const segments: string[] = [];
    const projectAudio: { path: string; startMs: number }[] = [];
    let previous: string | null = null;
    for (const cut of timeline.cuts) {
      const out = join(root, `seg-${cut.index}.mp4`);
      const extras: { prevFrame?: string; prevSegment?: string } = {};
      if (cut.effect === "whip_pan" && previous) {
        const frame = join(root, `prev-${cut.index}.png`);
        await spy(lastFrameArgs(previous, frame, renderProfile.fps), {
          signal: signal(),
          timeoutMs: 60_000,
        });
        extras.prevFrame = frame;
      }
      if (cut.effect === "split_screen" && previous) extras.prevSegment = previous;
      const run = (args: string[]) => spy(args, { signal: signal(), timeoutMs: 120_000 });
      switch (cut.sourceRef.kind) {
        case "veo":
          await run(
            veoSegmentArgs(cut, clips[cut.sourceRef.clipId] ?? "", renderProfile, out, extras),
          );
          break;
        case "image":
          await run(stillSegmentArgs(cut, still, renderProfile, out, "in", extras));
          break;
        case "card":
          await run(stillSegmentArgs(cut, card, renderProfile, out, "out", extras));
          break;
        case "project": {
          // 픽스처 대본에 촬영본이 없으면 대표 이미지로 대체되므로 여기서는 직접 촬영본 컷을 만든다
          await run(projectSegmentArgs(cut, project, renderProfile, out, extras));
          break;
        }
        case "graphic":
          await renderGraphicCut({
            cut,
            background: still,
            font,
            profile: renderProfile,
            out,
            signal: signal(),
            run: spy,
          });
          break;
      }
      segments.push(out);
      previous = out;
    }
    // 촬영본 keep 오디오를 하나 섞는다(타임라인 상 project 컷이 대표 이미지로 대체돼도 믹스 경로는 검증)
    const baseCut = timeline.cuts[2];
    if (!baseCut) throw new Error("cut expected");
    const projectCut = {
      ...baseCut,
      sourceRef: { kind: "project" as const, assetId: "x", startMs: 500, audio: "keep" as const },
    };
    const wav = join(root, "proj.wav");
    await spy(projectAudioExtractArgs(projectCut, project, wav), {
      signal: signal(),
      timeoutMs: 60_000,
    });
    projectAudio.push({ path: wav, startMs: projectCut.startMs });
    const voices = timeline.voice.map((line) => ({
      path: toneWav(join(root, line.artifactName), line.durationMs / 1000, 440 + line.index * 20),
      startMs: line.startMs,
    }));
    const bgm = noiseBgm(join(root, "bgm.wav"), 5);
    const captions = join(root, "captions-1.ass");
    await Bun.write(captions, captionsAss(timeline, renderProfile, font));
    const out = join(root, "video-final-1.mp4");
    const report = await assembleVideo({
      timeline,
      segments,
      projectAudio,
      voices,
      bgm: { path: bgm, id: "noise", sha256: "0".repeat(64), license: "fixture" },
      captionsAss: captions,
      font,
      profile: renderProfile,
      scratch: join(root, "scratch"),
      out,
      encoder: "libx264",
      preset: "ultrafast",
      signal: signal(),
      run: spy,
      warnings: ["fixture warning"],
    });
    expect(report.width).toBe(108);
    expect(report.height).toBe(192);
    expect(report.durationMs).toBe(timeline.durationMs);
    expect(Math.abs(report.measuredDurationMs - timeline.durationMs)).toBeLessThanOrEqual(250);
    expect(report.integratedLufs).toBeGreaterThanOrEqual(-16);
    expect(report.integratedLufs).toBeLessThanOrEqual(-12);
    expect(report.truePeakDb).toBeLessThanOrEqual(-1);
    expect(report.bgm?.id).toBe("noise");
    expect(report.warnings).toContain("fixture warning");
    expect(report.segments).toHaveLength(timeline.cuts.length);
    expect(report.ffmpegVersion.length).toBeGreaterThan(0);
    // faststart: moov 가 mdat 앞
    const head = new Uint8Array(await Bun.file(out).slice(0, 4096).arrayBuffer());
    const text = Buffer.from(head).toString("latin1");
    expect(text.indexOf("moov")).toBeGreaterThan(0);
    expect(text.indexOf("mdat") === -1 || text.indexOf("moov") < text.indexOf("mdat")).toBe(true);
    // 최종 패스 인자: 그래프 파일·자막·faststart·48kHz aac
    const final = calls.find((args) => args.includes("-/filter_complex"));
    expect(final).toBeDefined();
    expect(final).toContain("+faststart");
    expect(final?.slice(final.indexOf("-c:a"), final.indexOf("-c:a") + 6)).toEqual([
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
    ]);
    const graph = await Bun.file(final?.[final.indexOf("-/filter_complex") + 1] ?? "").text();
    expect(graph).toContain("ass='");
    expect(graph).toContain("captions-1.ass");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11[aout]");
    expect(calls.some((args) => args[0] === "-f" && args[1] === "concat")).toBe(true);
  },
  300_000,
);

// 첫 세그먼트의 SAR 가 어긋나 있어도(예전 shake 세그먼트) 최종 mp4 는 정사각 픽셀이고,
// 아포스트로피가 든 작업 폴더에서도 자막 번인 패스가 통과해야 한다.
test.skipIf(!hasFfmpeg || !font)(
  "the final mp4 has square pixels and assembles inside a folder whose name contains an apostrophe",
  async () => {
    if (!font) return;
    const dir = join(root, "it's 한글 dir");
    const make = async (name: string, filter: string) => {
      const path = join(dir, name);
      await runFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          `color=c=blue:s=108x192:r=10,${filter}`,
          "-t",
          "1",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-an",
          path,
        ],
        { signal: signal(), timeoutMs: 60_000 },
      );
      return path;
    };
    await Bun.write(join(dir, ".keep"), "");
    const skewed = await make("seg-skewed.mp4", "setsar=100/99");
    const square = await make("seg-square.mp4", "setsar=1");
    const sarOf = async (path: string) =>
      z
        .object({ streams: z.array(z.object({ sample_aspect_ratio: z.string() })) })
        .parse(
          await runFfprobeJson(
            ["-select_streams", "v:0", "-show_entries", "stream=sample_aspect_ratio", path],
            signal(),
          ),
        ).streams[0]?.sample_aspect_ratio;
    expect(await sarOf(skewed)).toBe("100:99");
    const timeline: RenderTimeline = {
      number: 1,
      durationMs: 2000,
      extendedMs: 0,
      scriptDigest: "x",
      cuts: [],
      voice: [],
      warnings: [],
    };
    const captions = join(dir, "captions-1.ass");
    await Bun.write(
      captions,
      `${assHeader(renderProfile, font, [])}\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,x\n`,
    );
    const out = join(dir, "video-final-1.mp4");
    const report = await assembleVideo({
      timeline,
      segments: [skewed, square],
      projectAudio: [],
      voices: [{ path: toneWav(join(dir, "tone.wav"), 2), startMs: 0 }],
      bgm: null,
      captionsAss: captions,
      font,
      profile: renderProfile,
      scratch: join(dir, "scratch"),
      out,
      encoder: "libx264",
      preset: "ultrafast",
      durationBounds: [1, 10],
      signal: signal(),
    });
    expect(report.width).toBe(108);
    expect(await sarOf(out)).toBe("1:1");
  },
  120_000,
);
