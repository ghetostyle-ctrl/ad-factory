import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrollCliContext,
  fitFilter,
  PHONE_GRADE,
  parseNoteUrl,
  runBrollCli,
} from "../scripts/broll-cli";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const run = (cmd: string, args: readonly string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(cmd, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

describe("parseNoteUrl", () => {
  test("rednote 검색 결과 링크를 yt-dlp 가 받는 explore 주소로 바꾼다", () => {
    const ref = parseNoteUrl(
      "https://www.rednote.com/search_result/6a202450000000000702a46d?xsec_token=ABYl1fB0Fw=&xsec_source=",
    );
    expect(ref).toEqual({
      noteId: "6a202450000000000702a46d",
      downloadUrl:
        "https://www.xiaohongshu.com/explore/6a202450000000000702a46d?xsec_token=ABYl1fB0Fw%3D&xsec_source=pc_search",
    });
  });
  test("xiaohongshu explore 링크도 받고, 다른 사이트·ID 없는 주소·파일 경로는 null", () => {
    expect(
      parseNoteUrl("https://www.xiaohongshu.com/explore/6a86d6cc000000002403e3f1")?.noteId,
    ).toBe("6a86d6cc000000002403e3f1");
    expect(parseNoteUrl("https://www.youtube.com/watch?v=6a86d6cc000000002403e3f1")).toBeNull();
    expect(parseNoteUrl("https://www.rednote.com/explore")).toBeNull();
    expect(parseNoteUrl("C:/clips/a.mp4")).toBeNull();
  });
});

describe("fitFilter", () => {
  test("세로 720x1280 은 그대로 9:16, 확대하면 기준점 y% 로 자른다", () => {
    expect(fitFilter(720, 1280)).toBe(
      `crop=720:1280:0:0,scale=720:1280:flags=lanczos,setsar=1,${PHONE_GRADE}`,
    );
    expect(fitFilter(720, 1280, 2, 0)).toStartWith("crop=360:640:180:0,");
    expect(fitFilter(720, 1280, 2, 100)).toStartWith("crop=360:640:180:640,");
  });
  test("가로 1920x1080 은 가운데 9:16 창(608x1080)", () => {
    expect(fitFilter(1920, 1080)).toStartWith("crop=608:1080:656:0,");
  });
  test("배율은 1~2.5 로 묶는다", () => {
    expect(fitFilter(720, 1280, 9)).toStartWith("crop=288:512:");
    expect(fitFilter(720, 1280, 0.2)).toStartWith("crop=720:1280:");
  });
});

describe("runBrollCli", () => {
  const ctx = (
    over: Partial<BrollCliContext>,
  ): BrollCliContext & { lines: string[]; errors: string[] } => {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      fetch: (() => {
        throw new Error("fetch 호출 안 됨");
      }) as unknown as typeof fetch,
      baseUrl: "http://127.0.0.1:4317",
      dataDir: tmpdir(),
      run,
      out: (l) => lines.push(l),
      err: (l) => errors.push(l),
      lines,
      errors,
      ...over,
    };
  };
  test("인자가 모자라면 사용법(종료 2)", async () => {
    const c = ctx({});
    expect(await runBrollCli(["add", "p1"], c)).toBe(2);
    expect(c.errors.join("\n")).toContain("bun run broll add");
  });
  test("제목·구간 검사", async () => {
    const c = ctx({});
    expect(
      await runBrollCli(["add", "p1", "x.mp4", "--start", "3", "--end", "2", "--title", "a"], c),
    ).toBe(1);
    expect(c.errors.join("")).toContain("--start 와 --end");
    expect(await runBrollCli(["add", "p1", "x.mp4", "--start", "1", "--end", "3"], c)).toBe(1);
    expect(c.errors.join("")).toContain("--title");
  });
  test.skipIf(!hasFfmpeg)(
    "add: 가로 영상을 잘라 9:16 무음 클립으로 만들어 올리고 제목·설정을 저장한다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "broll-"));
      try {
        const src = join(dir, "landscape.mp4");
        const made = await run("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=10:duration=4",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=4",
          "-shortest",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          src,
        ]);
        expect(made.code).toBe(0);
        const calls: { method: string; url: string; body: unknown }[] = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
          calls.push({ method: String(init.method), url, body: init.body });
          expect((init.headers as Record<string, string>)["Origin"]).toBe("http://127.0.0.1:4317");
          if (init.method === "POST")
            return Response.json(
              { id: "asset-1", title: "x.mp4", durationSec: 2 },
              { status: 201 },
            );
          return Response.json({ ok: true });
        }) as unknown as typeof fetch;
        const c = ctx({ fetch: fakeFetch, dataDir: dir });
        const code = await runBrollCli(
          [
            "add",
            "proj-1",
            src,
            "--start",
            "1",
            "--end",
            "3",
            "--title",
            "요거트 볼",
            "--placement",
            "middle",
            "--videos",
            "2,2,5",
          ],
          c,
        );
        expect(c.errors).toEqual([]);
        expect(code).toBe(0);
        expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
          "POST http://127.0.0.1:4317/api/projects/proj-1/production-assets",
          "PUT http://127.0.0.1:4317/api/projects/proj-1/production-assets/asset-1",
        ]);
        const put = JSON.parse(String(calls[1]?.body));
        expect(put.title).toBe("요거트 볼");
        expect(put.settings).toMatchObject({
          usage: "optional",
          placement: "middle",
          audio: "mute",
          targets: { mode: "selected", videoNumbers: [2, 5] },
        });
        const out = join(dir, "broll", "clips", "landscape-1-3.mp4");
        const probe = await run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,width,height:format=duration",
          "-of",
          "json",
          out,
        ]);
        const info = JSON.parse(probe.stdout);
        expect(info.streams).toHaveLength(1); // 무음(오디오 스트림 없음)
        expect(info.streams[0]).toMatchObject({ codec_type: "video", width: 720, height: 1280 });
        expect(Number(info.format.duration)).toBeCloseTo(2, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
