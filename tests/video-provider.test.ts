import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingConnectionError } from "../server/errors";
import {
  awaitVideoOperation,
  createVideoOperation,
  generateVideoResult,
} from "../server/video-provider";
import { AutomationPolicySchema } from "../shared/automation";
import { tinyClip } from "./render-fixture";

const png = new Uint8Array([137, 80, 78, 71]);

test("creative quantity boundaries reject more than ten assets of either kind", () => {
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", imageCount: 11, videoCount: 0 }).success,
  ).toBe(false);
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", imageCount: 1, videoCount: 11 }).success,
  ).toBe(false);
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", imageCount: 10, videoCount: 10 }).success,
  ).toBe(true);
});

test("Veo accepts only a decodable roughly eight-second portrait MP4", async () => {
  const root = await mkdtemp(join(tmpdir(), "veo-provider-test-"));
  let video = new Uint8Array(0);
  let downloadUrl = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/download")
        return new Response(video, { headers: { "Content-Type": "video/mp4" } });
      return Response.json({
        name: "operations/fixture",
        done: true,
        response: {
          generateVideoResponse: { generatedSamples: [{ video: { uri: downloadUrl } }] },
        },
      });
    },
  });
  downloadUrl = `http://127.0.0.1:${server.port}/download`;
  const task = {
    image: png,
    prompt: "Approved fixture concept",
    model: "veo-3.1-lite-generate-preview" as const,
    signal: new AbortController().signal,
  };
  const connection = { apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${server.port}/v1beta/` };
  try {
    for (const [size, duration, valid] of [
      ["96x160", "8", true],
      ["96x64", "2", false],
    ] as const) {
      const path = join(root, `${size}.mp4`);
      const output = Bun.spawnSync([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${size}:r=10`,
        "-t",
        duration,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      expect(output.exitCode).toBe(0);
      video = new Uint8Array(await Bun.file(path).arrayBuffer());
      if (valid) {
        const result = await generateVideoResult(task, connection);
        expect(result.value).toEqual(video);
        expect(result.model).toEqual({
          provider: "gemini",
          requestedModel: "veo-3.1-lite-generate-preview",
          effectiveModel: "veo-3.1-lite-generate-preview",
          quality: null,
        });
      } else {
        await expect(generateVideoResult(task, connection)).rejects.toThrow("세로 MP4");
      }
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("Veo request sends selected model, portrait duration and approved image", async () => {
  let requestBody: unknown = null;
  let requestPath = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      // 생성 POST 만 기록한다. 핸들 폴링(GET) 에도 같은 종료 응답을 돌려준다.
      if (request.method === "POST") {
        requestPath = new URL(request.url).pathname;
        requestBody = await request.json();
      }
      return Response.json({
        name: "operations/fixture",
        done: true,
        error: { message: "fixture stop" },
      });
    },
  });
  try {
    await expect(
      generateVideoResult(
        {
          image: png,
          prompt: "Approved fixture concept",
          model: "veo-3.1-lite-generate-preview",
          signal: new AbortController().signal,
        },
        { apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${server.port}/v1beta/` },
      ),
    ).rejects.toThrow("fixture stop");
    expect(requestBody).toMatchObject({
      instances: [
        { prompt: "Approved fixture concept", image: { inlineData: { mimeType: "image/png" } } },
      ],
      parameters: { aspectRatio: "9:16", durationSeconds: "8", resolution: "720p" },
    });
    // Lite 를 고르면 Lite 모델 ID 그대로(Standard 로 바꿔 청구되지 않는다), 인물 허용·base64 이미지
    expect(requestPath).toBe("/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning");
    expect(requestBody).toMatchObject({
      instances: [{ image: { inlineData: { data: Buffer.from(png).toString("base64") } } }],
      parameters: { personGeneration: "allow_adult" },
    });
  } finally {
    await server.stop(true);
  }
});

test("createVideoOperation sends one POST and returns the handle; awaitVideoOperation only polls", async () => {
  const root = await mkdtemp(join(tmpdir(), "veo-split-test-"));
  const clip = tinyClip(join(root, "clip.mp4"));
  const video = new Uint8Array(await Bun.file(clip).arrayBuffer());
  const calls: string[] = [];
  let polls = 0;
  let downloadUrl = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/download")
        return new Response(video, { headers: { "Content-Type": "video/mp4" } });
      if (request.method === "POST") return Response.json({ name: "operations/split-fixture" });
      polls++;
      return Response.json(
        polls < 2
          ? { name: "operations/split-fixture", done: false }
          : {
              name: "operations/split-fixture",
              done: true,
              response: {
                generateVideoResponse: { generatedSamples: [{ video: { uri: downloadUrl } }] },
              },
            },
      );
    },
  });
  downloadUrl = `http://127.0.0.1:${server.port}/download`;
  const connection = { apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${server.port}/v1beta/` };
  const signal = new AbortController().signal;
  try {
    // When: 생성 요청만
    const handle = await createVideoOperation(
      {
        image: png,
        prompt: "Clip A",
        model: "veo-3.1-generate-preview",
        signal,
        resolution: "1080p",
      },
      connection,
    );
    // Then
    expect(handle.name).toBe("operations/split-fixture");
    expect(Date.parse(handle.startedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(calls).toEqual(["POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning"]);
    // When: 30분 전에 시작된 핸들을 await — 데드라인은 await 시작 기준이라 정상 폴링한다(첫 폴링 즉시, 2회째 완료)
    const result = await awaitVideoOperation(
      {
        operationName: handle.name,
        startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
        signal,
        pollIntervalMs: 10,
        model: "veo-3.1-generate-preview",
      },
      connection,
    );
    // Then
    expect(result.value).toEqual(video);
    expect(result.model.requestedModel).toBe("veo-3.1-generate-preview");
    expect(calls.slice(1)).toEqual([
      "GET /v1beta/operations/split-fixture",
      "GET /v1beta/operations/split-fixture",
      "GET /download",
    ]);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    // 데드라인을 넘기면 폴링을 멈추고 BlockedError
    polls = -10;
    await expect(
      awaitVideoOperation(
        {
          operationName: handle.name,
          startedAt: handle.startedAt,
          signal,
          pollIntervalMs: 10,
          pollDeadlineMs: 0,
        },
        connection,
      ),
    ).rejects.toThrow("20분");
    // 키가 없으면 요청 0회
    const before = calls.length;
    await expect(
      createVideoOperation(
        { image: png, prompt: "Clip A", model: "veo-3.1-generate-preview", signal },
        { apiKey: "", baseUrl: connection.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MissingConnectionError);
    expect(calls).toHaveLength(before);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
