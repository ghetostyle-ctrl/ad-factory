import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { probeAudio } from "../server/audio-probe";
import { runFfmpeg, runFfprobeJson } from "../server/render/ffmpeg";
import {
  aiStillSegmentArgs,
  effectFilters,
  lastFrameArgs,
  projectAudioExtractArgs,
  projectSegmentArgs,
  readPlan,
  STILL_WINDOWS,
  segmentDigest,
  stillSegmentArgs,
  stillWindow,
  stillWindowChain,
  stillZoom,
  veoSegmentArgs,
} from "../server/render/segments";
import { buildTimeline, type TimelineCut } from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";
import { CutEffectSchema } from "../shared/video-script";
import {
  projectClip,
  removeTemp,
  renderProfile,
  renderScript,
  renderTemp,
  tinyClip,
  tinyStill,
} from "./render-fixture";

// 순수 인자 빌더 스냅샷 + 효과 8종을 lavfi 108x192 미디어에 실제로 렌더해 길이·크기를 검증한다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 세그먼트 렌더 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      nb_frames: z.string().optional(),
      sample_aspect_ratio: z.string().optional(),
    }),
  ),
});
async function probe(path: string) {
  const parsed = Probe.parse(
    await runFfprobeJson(
      [
        "-count_frames",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,nb_read_frames,sample_aspect_ratio",
        path,
      ],
      signal(),
    ),
  );
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  return {
    durationSec: Number(parsed.format.duration),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === "audio"),
    sar: video?.sample_aspect_ratio ?? "",
  };
}
let root = "";
let clip = "";
let still = "";
let project = "";
beforeAll(async () => {
  root = await renderTemp("studio-segments-");
  if (!hasFfmpeg) return;
  clip = tinyClip(join(root, "clip.mp4"));
  still = tinyStill(join(root, "still.png"));
  project = projectClip(join(root, "project.mp4"), 4);
}, 60_000);
afterAll(async () => {
  await removeTemp(root);
});
function cut(overrides: Partial<TimelineCut>): TimelineCut {
  return {
    index: 0,
    startMs: 0,
    endMs: 2000,
    purpose: "hook",
    source: "veo_clip",
    effect: "hard_cut",
    onScreenText: "",
    caption: null,
    graphicKind: "",
    graphicLines: [],
    sourceRef: { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 },
    ...overrides,
  };
}

test("argument builders escape paths, read extra source for ramps and pad clip overruns", () => {
  const veo = veoSegmentArgs(
    cut({ sourceRef: { kind: "veo", clipId: "A", offsetMs: 6500, padMs: 500 } }),
    "C:\\clips\\clip-1-A-1.mp4",
    renderProfile,
    "C:\\out\\seg.mp4",
  );
  expect(veo.slice(0, 6)).toEqual([
    "-ss",
    "6.500",
    "-t",
    "1.500",
    "-i",
    "C:\\clips\\clip-1-A-1.mp4",
  ]);
  const graph = veo[veo.indexOf("-filter_complex") + 1] ?? "";
  expect(graph).toContain(
    "[0:v]scale=108:192:force_original_aspect_ratio=increase,crop=108:192,fps=10,setsar=1",
  );
  expect(graph).toContain("tpad=stop_mode=clone:stop_duration=0.500");
  expect(graph).toContain("trim=duration=2.000,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[out]");
  expect(veo.slice(-2)).toEqual(["2.000", "C:\\out\\seg.mp4"]);
  expect(veo).toContain("-an");
  expect(readPlan(cut({ effect: "speed_ramp" }))).toEqual({ readMs: 2100, tailMs: 0 });
  expect(readPlan(cut({ effect: "freeze_frame" }))).toEqual({ readMs: 1400, tailMs: 600 });
  const stillArgs = stillSegmentArgs(
    cut({ source: "approved_image", sourceRef: { kind: "image", artifactName: "a.png" } }),
    still || "s.png",
    renderProfile,
    "o.mp4",
    "out",
  );
  expect(stillArgs.slice(0, 4)).toEqual(["-loop", "1", "-framerate", "10"]);
  expect(stillArgs[stillArgs.indexOf("-filter_complex") + 1]).toContain(
    "force_original_aspect_ratio=decrease",
  );
  const whip = effectFilters("whip_pan", 2000, renderProfile, { prevFrame: "C:\\prev.png" });
  expect(whip.inputs).toEqual([
    "-loop",
    "1",
    "-framerate",
    "10",
    "-t",
    "0.3",
    "-i",
    "C:\\prev.png",
  ]);
  expect(whip.chain).toContain("[1:v]scale=108:192");
  expect(whip.chain).toContain("overlay=x='-108*min(1\\,t/0.15)'");
  const ramp = effectFilters("speed_ramp", 2000, renderProfile);
  expect(ramp.chain).toContain("trim=0:1.000,setpts=(PTS-STARTPTS)*1.6");
  expect(ramp.chain).toContain("trim=1.000:2.100,setpts=(PTS-STARTPTS)*0.5");
  const projectArgs = projectSegmentArgs(
    cut({ sourceRef: { kind: "project", assetId: "x", startMs: 1500, audio: "keep" } }),
    "p.mp4",
    renderProfile,
    "o.mp4",
  );
  expect(projectArgs.slice(0, 4)).toEqual(["-ss", "1.500", "-t", "2.000"]);
  expect(
    projectAudioExtractArgs(
      cut({ sourceRef: { kind: "project", assetId: "x", startMs: 1500, audio: "keep" } }),
      "p.mp4",
      "a.wav",
    ),
  ).toEqual([
    "-ss",
    "1.500",
    "-t",
    "2.000",
    "-i",
    "p.mp4",
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    "a.wav",
  ]);
  expect(lastFrameArgs("s.mp4", "f.png")).toEqual([
    "-sseof",
    "-0.050",
    "-i",
    "s.mp4",
    "-frames:v",
    "1",
    "-update",
    "1",
    "f.png",
  ]);
  const base = {
    cut: cut({}),
    sourceDigest: "d",
    themeVersion: 1,
    fontDigest: "f",
    profile: renderProfile,
  };
  expect(segmentDigest(base)).toBe(segmentDigest({ ...base }));
  expect(segmentDigest(base)).not.toBe(segmentDigest({ ...base, prevDigest: "p" }));
  expect(segmentDigest(base)).not.toBe(segmentDigest({ ...base, sourceDigest: "e" }));
});

test.skipIf(!hasFfmpeg)(
  "every effect renders a segment of the exact cut length at the profile size",
  async () => {
    const effects = CutEffectSchema.options;
    for (const [index, effect] of effects.entries()) {
      const durMs = index % 2 === 0 ? 2000 : 1200;
      const base = cut({ index, effect, startMs: 0, endMs: durMs });
      const extras =
        effect === "whip_pan"
          ? { prevFrame: still }
          : effect === "split_screen"
            ? { prevSegment: clip }
            : {};
      const veoOut = join(root, `veo-${effect}.mp4`);
      await runFfmpeg(veoSegmentArgs(base, clip, renderProfile, veoOut, extras), {
        signal: signal(),
        timeoutMs: 120_000,
      });
      const veoInfo = await probe(veoOut);
      expect(veoInfo.width).toBe(108);
      expect(veoInfo.height).toBe(192);
      expect(veoInfo.hasAudio).toBe(false);
      // shake 의 1.06배 확대 스케일이 SAR 를 바꾸지 않도록 모든 효과의 세그먼트는 정사각 픽셀이다
      expect(veoInfo.sar).toBe("1:1");
      expect(Math.abs(veoInfo.durationSec - durMs / 1000)).toBeLessThanOrEqual(0.11);
      const stillOut = join(root, `still-${effect}.mp4`);
      await runFfmpeg(
        stillSegmentArgs(
          { ...base, source: "approved_image", sourceRef: { kind: "image", artifactName: "a" } },
          still,
          renderProfile,
          stillOut,
          index % 2 ? "in" : "out",
          extras,
        ),
        { signal: signal(), timeoutMs: 120_000 },
      );
      const stillInfo = await probe(stillOut);
      expect([stillInfo.width, stillInfo.height]).toEqual([108, 192]);
      expect(stillInfo.sar).toBe("1:1");
      expect(Math.abs(stillInfo.durationSec - durMs / 1000)).toBeLessThanOrEqual(0.11);
    }
    // 8초 초과 pad: 7초 지점부터 2초 컷 → 1초 읽고 1초 복제
    const padded = join(root, "padded.mp4");
    await runFfmpeg(
      veoSegmentArgs(
        cut({ sourceRef: { kind: "veo", clipId: "A", offsetMs: 7000, padMs: 1000 } }),
        clip,
        renderProfile,
        padded,
      ),
      { signal: signal(), timeoutMs: 120_000 },
    );
    expect(Math.abs((await probe(padded)).durationSec - 2)).toBeLessThanOrEqual(0.11);
    // 촬영본: 1.5초부터 2초 + keep 오디오 추출
    const projectOut = join(root, "project-seg.mp4");
    const projectCut = cut({
      source: "project_clip",
      sourceRef: { kind: "project", assetId: "x", startMs: 1500, audio: "keep" },
    });
    await runFfmpeg(projectSegmentArgs(projectCut, project, renderProfile, projectOut), {
      signal: signal(),
      timeoutMs: 120_000,
    });
    const projectInfo = await probe(projectOut);
    expect(projectInfo.hasAudio).toBe(false);
    expect(Math.abs(projectInfo.durationSec - 2)).toBeLessThanOrEqual(0.11);
    const wav = join(root, "project-audio.wav");
    await runFfmpeg(projectAudioExtractArgs(projectCut, project, wav), {
      signal: signal(),
      timeoutMs: 120_000,
    });
    const audio = await probeAudio(wav, signal());
    expect(Math.abs(audio.durationMs - 2000)).toBeLessThanOrEqual(60);
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toBe(2);
    // 직전 세그먼트 마지막 프레임 추출
    const frame = join(root, "last.png");
    await runFfmpeg(lastFrameArgs(veoOutOf("hard_cut"), frame, renderProfile.fps), {
      signal: signal(),
      timeoutMs: 60_000,
    });
    expect(new Uint8Array(await Bun.file(frame).arrayBuffer()).slice(1, 4)).toEqual(
      new Uint8Array([80, 78, 71]),
    );
    function veoOutOf(effect: string) {
      return join(root, `veo-${effect}.mp4`);
    }
  },
  180_000,
);

test("timeline cuts from the fixture script cover every effect and source", () => {
  const script = renderScript(1, "concept-1", 36);
  const built = buildTimeline(
    script,
    // 문장은 컷 범위에 묶여 있으므로 실측은 그 범위(1~3초)보다 0.5초 짧게 둔다
    script.voiceover.map((voice, index) => ({
      index,
      durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
      tempo: 1,
    })),
  );
  if (!("timeline" in built)) throw new Error("timeline expected");
  expect(new Set(built.timeline.cuts.map((item) => item.effect)).size).toBe(
    CutEffectSchema.options.length,
  );
  expect(new Set(built.timeline.cuts.map((item) => item.source)).size).toBe(6);
});

function stillCut(offsetIndex: number, overrides: Partial<TimelineCut> = {}): TimelineCut {
  return cut({
    source: "still_image",
    sourceRef: { kind: "still", stillId: "S1", artifactName: "still-1-S1-1.png", offsetIndex },
    ...overrides,
  });
}
const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";

test("AI still cuts cycle through distinct crop windows and alternate zoom directions", () => {
  const windows = Array.from({ length: STILL_WINDOWS.length }, (_, index) => stillWindow(index));
  expect(new Set(windows.map((window) => window.name)).size).toBe(STILL_WINDOWS.length);
  // 표를 한 바퀴 돌면 처음 창으로 돌아온다
  expect(stillWindow(STILL_WINDOWS.length).name).toBe(stillWindow(0).name);
  // 연속한 컷은 항상 다른 창이고 줌 방향이 반대다
  for (let index = 0; index < 12; index++) {
    expect(stillWindow(index).name).not.toBe(stillWindow(index + 1).name);
    expect(stillZoom(index)).not.toBe(stillZoom(index + 1));
  }
  const chains = Array.from({ length: STILL_WINDOWS.length }, (_, index) =>
    stillWindowChain(renderProfile, index),
  );
  expect(new Set(chains).size).toBe(STILL_WINDOWS.length);
  // 필터 식 안의 쉼표는 이스케이프되고, 켄번즈는 fps 와 무관하게 2초에 15%이다(10fps: 0.0075/프레임)
  expect(chains[0]).toContain("crop=w='min(iw\\,ih*9/16)/1.00'");
  expect(chains[0]).toContain("zoompan=z='min(1+0.00750*on\\,1.15)'");
  expect(chains[1]).toContain("zoompan=z='max(1.15-0.00750*on\\,1)'");
  expect(chains[1]).toContain("x='(iw-ow)*0'");
  expect(chains[2]).toContain("x='(iw-ow)*1'");
  const args = aiStillSegmentArgs(stillCut(2), "C:sstill.png", renderProfile, "o.mp4");
  expect(args.slice(0, 4)).toEqual(["-loop", "1", "-framerate", "10"]);
  expect(graphOf(args)).toContain(chains[2] ?? "missing");
  expect(graphOf(args)).toContain("trim=duration=2.000,setpts=PTS-STARTPTS,setsar=1");
});

test.skipIf(!hasFfmpeg)(
  "rendering one still for several cuts crops different windows of the image",
  async () => {
    // 위치마다 색이 다른 세로 이미지(540x960)와 AI 폴백 크기의 정사각 이미지(512x512)
    const portrait = join(root, "portrait.png");
    const square = join(root, "square.png");
    for (const [path, size] of [
      [portrait, "540x960"],
      [square, "512x512"],
    ] as const) {
      const made = Bun.spawnSync([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=${size}:r=1`,
        "-frames:v",
        "1",
        path,
      ]);
      expect(made.exitCode).toBe(0);
    }
    const hashes: string[] = [];
    for (let offset = 0; offset < STILL_WINDOWS.length; offset++) {
      const out = join(root, `window-${offset}.mp4`);
      await runFfmpeg(aiStillSegmentArgs(stillCut(offset), portrait, renderProfile, out), {
        signal: signal(),
        timeoutMs: 120_000,
      });
      const info = await probe(out);
      expect([info.width, info.height]).toEqual([108, 192]);
      expect(info.sar).toBe("1:1");
      expect(info.hasAudio).toBe(false);
      expect(Math.abs(info.durationSec - 2)).toBeLessThanOrEqual(0.11);
      // 컷 중간(1초) 프레임: 창마다 보이는 영역이 달라 서로 다른 화면이 된다
      const frame = join(root, `window-${offset}.png`);
      await runFfmpeg(["-ss", "1.0", "-i", out, "-frames:v", "1", "-update", "1", frame], {
        signal: signal(),
        timeoutMs: 60_000,
      });
      hashes.push(sha256Hex(new Uint8Array(await Bun.file(frame).arrayBuffer())));
    }
    expect(new Set(hashes).size).toBe(STILL_WINDOWS.length);
    // 정사각 이미지(1024x1024 폴백)도 같은 규격의 세그먼트가 되고, 모든 창에서 렌더된다
    for (const offset of [0, 1, 3]) {
      const out = join(root, `square-${offset}.mp4`);
      await runFfmpeg(aiStillSegmentArgs(stillCut(offset), square, renderProfile, out), {
        signal: signal(),
        timeoutMs: 120_000,
      });
      const info = await probe(out);
      expect([info.width, info.height]).toEqual([108, 192]);
      expect(info.sar).toBe("1:1");
    }
    // 효과(휙 넘김)와 12프레임 짜리 짧은 컷도 문제없다
    const short = join(root, "window-short.mp4");
    await runFfmpeg(
      aiStillSegmentArgs(
        stillCut(1, { effect: "whip_pan", startMs: 0, endMs: 1000 }),
        portrait,
        renderProfile,
        short,
        { prevFrame: still },
      ),
      { signal: signal(), timeoutMs: 120_000 },
    );
    expect(Math.abs((await probe(short)).durationSec - 1)).toBeLessThanOrEqual(0.11);
  },
  180_000,
);
