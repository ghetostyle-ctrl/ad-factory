import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVideoResult } from "../server/video-provider";
import { AutomationPolicySchema } from "../shared/automation";

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
    image: new Uint8Array([137, 80, 78, 71]),
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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBody = await request.json();
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
          image: new Uint8Array([137, 80, 78, 71]),
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
  } finally {
    await server.stop(true);
  }
});
