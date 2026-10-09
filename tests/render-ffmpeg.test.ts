import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { StudioError } from "../server/errors";
import { assDialogue, assHeader } from "../server/render/ass";
import {
  extractFrames,
  ffmpegCapabilities,
  ffmpegReady,
  ffPath,
  fontOnlyDir,
  runFfmpeg,
  runFfprobeJson,
  writeFilterGraph,
} from "../server/render/ffmpeg";
import { BUNDLED_FONT_DIR, type FontSet, fontDigest, resolveFont } from "../server/render/fonts";
import { REQUIRED_FILTERS } from "../server/render/preflight";
import { DEFAULT_PROFILE, THEME_VERSION, themePx } from "../server/render/theme";
import {
  noiseBgm,
  projectClip,
  removeTemp,
  renderProfile,
  renderTemp,
  tinyClip,
  tinyStill,
  toneWav,
} from "./render-fixture";

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg)
  console.log("미검증: 이 PC 에 ffmpeg/ffprobe 가 없어 실제 실행 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
// 한 줄짜리 ASS(스타일 1개): 경로·폰트 로딩만 확인하는 테스트용
function minimalAss(font: FontSet): string {
  const style = {
    name: "T",
    fontSize: 20,
    primary: "&H00FFFFFF",
    outline: 1,
    shadow: 0,
    alignment: 5,
    marginL: 0,
    marginR: 0,
    marginV: 0,
  };
  const event = assDialogue({ startMs: 0, endMs: 500, style: "T", text: "안녕" });
  return `${assHeader(renderProfile, font, [style])}
${event}
`;
}
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-ffmpeg-");
});
afterAll(async () => {
  await removeTemp(root);
});

test("ffPath quotes the path, flips backslashes and escapes drive colons for filter graphs", () => {
  expect(ffPath("C:\\Users\\a\\x y\\captions-1.ass")).toBe("'C\\:/Users/a/x y/captions-1.ass'");
  expect(ffPath("/tmp/plain.ass")).toBe("'/tmp/plain.ass'");
  // 작은따옴표는 그래프 → 옵션 값 두 단계 파싱을 모두 통과하는 \'\'' 로 쓴다(실제 필터로 아래에서 확인)
  expect(ffPath("D:\\it's.ass")).toBe("'D\\:/it\\'\\''s.ass'");
});

// 아포스트로피가 든 폴더(예: C:\Users\O'Brien\...)에서도 ass 필터가 -vf 와 -/filter_complex 양쪽에서 열려야 한다.
// 예전 셸 관용구('\'')는 ffmpeg 8.1 에서 뒤의 :fontsdir= 까지 파일명으로 삼켜 libass 트랙 생성 실패(exit 234)였다.
test.skipIf(!hasFfmpeg)(
  "the ass filter opens subtitle and font paths that contain an apostrophe, via -vf and via a filter file",
  async () => {
    const font = resolveFont();
    if (!font) return;
    const dir = join(root, "it's 한글 dir");
    await mkdir(dir, { recursive: true });
    const fontsDir = await fontOnlyDir(font, dir);
    expect(fontsDir).toContain("it's 한글 dir");
    const assPath = join(dir, "t.ass");
    await Bun.write(assPath, minimalAss(font));
    const filter = `ass=${ffPath(assPath)}:fontsdir=${ffPath(fontsDir)}`;
    const source = ["-f", "lavfi", "-t", "0.5", "-i", "color=c=blue:s=108x192:r=10"];
    await runFfmpeg([...source, "-vf", filter, join(dir, "vf.mp4")], {
      signal: signal(),
      timeoutMs: 60_000,
    });
    const graph = await writeFilterGraph(dir, `[0:v]${filter}[out]`);
    await runFfmpeg(
      [...source, "-/filter_complex", graph, "-map", "[out]", join(dir, "graph.mp4")],
      {
        signal: signal(),
        timeoutMs: 60_000,
      },
    );
    expect(await Bun.file(join(dir, "vf.mp4")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "graph.mp4")).exists()).toBe(true);
  },
  120_000,
);

// 번들 폰트 폴더에는 라이선스 텍스트가 같이 있어 fontsdir 로 그대로 쓰면 libass 가 폰트가 아닌 파일을 열다 경고한다.
test.skipIf(!hasFfmpeg)(
  "fontOnlyDir holds just the font files and libass no longer warns about non-font files",
  async () => {
    const font = resolveFont();
    if (!font) return;
    const dir = await fontOnlyDir(font, join(root, "font-only"));
    expect((await readdir(dir)).sort()).toEqual([...new Set([font.bold, font.medium])].sort());
    // 다시 불러도(이미 있고 크기가 같음) 임시 파일을 남기지 않는다
    expect(await fontOnlyDir(font, join(root, "font-only"))).toBe(dir);
    expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
    const assPath = join(root, "font-only.ass");
    await Bun.write(assPath, minimalAss(font));
    const warnings = async (fontsdir: string) =>
      (
        await runFfmpeg(
          [
            "-loglevel",
            "warning",
            "-f",
            "lavfi",
            "-t",
            "0.3",
            "-i",
            "color=c=blue:s=108x192:r=10",
            "-vf",
            `ass=${ffPath(assPath)}:fontsdir=${ffPath(fontsdir)}`,
            "-f",
            "null",
            "-",
          ],
          { signal: signal(), timeoutMs: 60_000 },
        )
      ).stderrTail;
    expect(await warnings(dir)).not.toContain("Error opening memory font");
    // 대조군: 번들 폴더에 폰트가 아닌 파일(라이선스)이 있으면 같은 경고가 난다
    const raw = await readdir(font.dir);
    if (raw.some((name) => !name.endsWith(".ttf") && !name.endsWith(".otf")))
      expect(await warnings(font.dir)).toContain("Error opening memory font");
  },
  120_000,
);

test("theme tokens scale with the profile", () => {
  expect(THEME_VERSION).toBe(4);
  expect(DEFAULT_PROFILE).toEqual({ width: 1080, height: 1920, fps: 30 });
  expect(themePx(DEFAULT_PROFILE, 0.0375)).toBe(72);
  expect(themePx(renderProfile, 0.0375)).toBe(7);
  expect(themePx(renderProfile, 0.067, "width")).toBe(7);
});

test("resolveFont finds the bundled Pretendard pair and honours FONT_DIR strictly", () => {
  const previous = process.env["FONT_DIR"];
  try {
    delete process.env["FONT_DIR"];
    const font = resolveFont();
    expect(font?.family).toBe("Pretendard");
    expect(font?.dir.replace(/\\/g, "/")).toBe(BUNDLED_FONT_DIR.replace(/\\/g, "/"));
    expect(font?.bold).toBe("Pretendard-Bold.ttf");
    expect(font?.medium).toBe("Pretendard-Medium.ttf");
    expect(font?.dir.includes("\\")).toBe(false);
    const digest = fontDigest(font);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(fontDigest(font)).toBe(digest);
    expect(fontDigest(null)).toBe("none");
    // 가짜 FONT_DIR 는 번들 폰트로 떨어지지 않고 null 이어야 preflight 가 멈춘다
    process.env["FONT_DIR"] = join(root, "no-fonts-here");
    expect(resolveFont()).toBeNull();
    process.env["FONT_DIR"] = BUNDLED_FONT_DIR;
    expect(resolveFont()?.family).toBe("Pretendard");
  } finally {
    if (previous === undefined) delete process.env["FONT_DIR"];
    else process.env["FONT_DIR"] = previous;
  }
});

test("writeFilterGraph stores the graph as UTF-8/LF under a content-addressed name", async () => {
  const path = await writeFilterGraph(
    join(root, "graphs"),
    "[0:v]scale=108:192[v];\r\n[v]format=yuv420p[out]",
  );
  expect(path).toMatch(/graph-[0-9a-f]{12}\.txt$/);
  expect(await Bun.file(path).text()).toBe("[0:v]scale=108:192[v];\n[v]format=yuv420p[out]");
  expect(
    await writeFilterGraph(join(root, "graphs"), "[0:v]scale=108:192[v];\n[v]format=yuv420p[out]"),
  ).toBe(path);
});

test.skipIf(!hasFfmpeg)(
  "ffmpeg capabilities on this machine include libass and libx264",
  async () => {
    const capabilities = await ffmpegCapabilities();
    expect(capabilities.version.length).toBeGreaterThan(0);
    // 제품 preflight 의 필수 필터 목록과 같은 기준으로 확인한다
    for (const filter of REQUIRED_FILTERS) expect(capabilities.filters.has(filter)).toBe(true);
    expect(capabilities.encoders.has("libx264")).toBe(true);
    expect(capabilities.encoders.has("aac")).toBe(true);
    expect(ffmpegReady()).toBe(true);
    expect(await ffmpegCapabilities()).toBe(capabilities);
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "fixture media render through runFfmpeg, probe and frame extraction",
  async () => {
    // Given
    const clip = tinyClip(join(root, "clip.mp4"));
    const still = tinyStill(join(root, "still.png"));
    const tone = toneWav(join(root, "tone.wav"), 2);
    const bgm = noiseBgm(join(root, "bgm.wav"), 3);
    const project = projectClip(join(root, "project.mp4"));
    const Probe = z.object({
      format: z.object({ duration: z.string() }),
      streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional() })),
    });
    const probe = async (path: string) =>
      Probe.parse(
        await runFfprobeJson(
          ["-show_entries", "format=duration:stream=codec_type,width,height", path],
          signal(),
        ),
      );
    // Then
    const clipInfo = await probe(clip);
    expect(Number(clipInfo.format.duration)).toBeCloseTo(8, 0);
    expect(clipInfo.streams[0]?.width).toBe(renderProfile.width);
    expect(Number((await probe(tone)).format.duration)).toBeCloseTo(2, 1);
    expect(Number((await probe(bgm)).format.duration)).toBeCloseTo(3, 1);
    expect((await probe(project)).streams.map((stream) => stream.codec_type).sort()).toEqual([
      "audio",
      "video",
    ]);
    expect(new Uint8Array(await Bun.file(still).arrayBuffer()).slice(1, 4)).toEqual(
      new Uint8Array([80, 78, 71]),
    );
    const frames = await extractFrames(clip, [0.5, 4, 7.5], join(root, "frames"), signal());
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.slice(1, 4)).toEqual(new Uint8Array([80, 78, 71]));
    const out = join(root, "trimmed.mp4");
    const result = await runFfmpeg(
      ["-ss", "1", "-t", "2", "-i", clip, "-c:v", "libx264", "-preset", "ultrafast", out],
      {
        signal: signal(),
        timeoutMs: 60_000,
      },
    );
    expect(result.stderrTail).toBe("");
    expect(Number((await probe(out)).format.duration)).toBeCloseTo(2, 0);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "ffmpeg failures surface as StudioError with the stderr tail",
  async () => {
    const failure = runFfmpeg(["-i", join(root, "missing.mp4"), join(root, "never.mp4")], {
      signal: signal(),
      timeoutMs: 20_000,
    });
    await expect(failure).rejects.toBeInstanceOf(StudioError);
    await expect(failure).rejects.toMatchObject({ code: "ffmpeg_failed" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runFfmpeg(
        ["-f", "lavfi", "-i", "color=c=red:s=16x16", "-t", "1", join(root, "aborted.mp4")],
        {
          signal: aborted.signal,
          timeoutMs: 20_000,
        },
      ),
    ).rejects.toThrow("Cancelled");
  },
  60_000,
);

test("a missing ffmpeg binary reports render_unavailable (503) without caching the failure", async () => {
  const previous = process.env["FFMPEG_PATH"];
  try {
    process.env["FFMPEG_PATH"] = join(root, "no-such-ffmpeg.exe");
    expect(ffmpegReady()).toBe(false);
    const failure = ffmpegCapabilities();
    await expect(failure).rejects.toMatchObject({ code: "render_unavailable", status: 503 });
    await expect(
      runFfmpeg(["-version"], { signal: signal(), timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "render_unavailable" });
    expect(ffmpegReady()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env["FFMPEG_PATH"];
    else process.env["FFMPEG_PATH"] = previous;
  }
});
