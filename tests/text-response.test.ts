import { expect, test } from "bun:test";
import { z } from "zod";
import { generateTextResult } from "../server/text-provider";

test("passes the exact completed model text to the script parser before schema rejection", async () => {
  const text = ' { "title": 42, "copy": "원문은 그대로" } ';
  let calls = 0,
    captured = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return Response.json({
        status: "completed",
        model: "observed",
        output: [{ content: [{ type: "output_text", text }] }],
      });
    },
  });
  try {
    await expect(
      generateTextResult(
        {
          name: "fixture",
          prompt: "fixture",
          directory: ".",
          signal: new AbortController().signal,
          schema: z.object({ title: z.string() }),
          models: {
            textProvider: "openai",
            textModel: "fixture",
            imageModel: "fixture",
            imageQuality: "auto",
            codexModel: null,
            ttsProvider: "typecast",
            ttsSelection: "auto",
            ttsVoiceId: null,
            ttsTempo: 1,
            capturedAt: "2026-10-11T00:00:00Z",
          },
          parseResponse: async (response: { readonly text: string }) => {
            captured = response.text;
            return { title: "parsed locally" };
          },
        },
        { baseUrl: "http://127.0.0.1:" + server.port + "/", apiKey: "fixture" },
      ),
    ).resolves.toMatchObject({
      value: { title: "parsed locally" },
      model: { effectiveModel: "observed" },
    });
    expect(captured).toBe(text);
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
  }
});
