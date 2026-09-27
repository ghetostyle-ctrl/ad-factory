import { expect, test } from "bun:test";
import { generateVideoResult } from "../server/video-provider";

test("selected Lite model is sent without a paid-model substitution", async () => {
  let requestedPath = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requestedPath = new URL(request.url).pathname;
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
          image: new Uint8Array(),
          prompt: "fixture",
          model: "veo-3.1-lite-generate-preview",
          signal: new AbortController().signal,
        },
        { apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${server.port}/v1beta/` },
      ),
    ).rejects.toThrow("fixture stop");
    expect(requestedPath).toBe("/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning");
  } finally {
    await server.stop(true);
  }
});
