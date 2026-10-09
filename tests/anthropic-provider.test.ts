import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { z } from "zod";
import { credentials } from "../server/config";
import { MissingConnectionError } from "../server/errors";
import type { JobStore } from "../server/store";
import { generateTextResult } from "../server/text-provider";
import { providerStore } from "./provider-fixtures";

// 대본 단계(stage script)만 Claude(Anthropic)로 보낸다(사용자 결정 2026-10-06). 다른 호출은 텍스트 공급자(OpenAI 픽스처) 그대로.
const stores: JobStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const savedBaseUrl = process.env["ANTHROPIC_BASE_URL"];
const savedKey = credentials.anthropic;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
  if (savedBaseUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
  else process.env["ANTHROPIC_BASE_URL"] = savedBaseUrl;
  credentials.anthropic = savedKey;
});
const Answer = z.object({ title: z.string(), score: z.number().int() });

function setup() {
  const store = providerStore();
  stores.push(store);
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const anthropic = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      seen.push({
        url: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5-observed",
        content: [{ type: "text", text: JSON.stringify({ title: "클로드 대본", score: 7 }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  servers.push(anthropic);
  const openaiModels: string[] = [];
  const openai = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      openaiModels.push(z.object({ model: z.string() }).parse(await request.json()).model);
      return Response.json({
        model: "gpt-fixture",
        status: "completed",
        output: [
          {
            content: [
              { type: "output_text", text: JSON.stringify({ title: "지피티 대본", score: 3 }) },
            ],
          },
        ],
      });
    },
  });
  servers.push(openai);
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${anthropic.port}`;
  credentials.anthropic = "local-anthropic-fixture-key";
  const job = store.list()[0];
  if (!job?.executionModels) throw new TypeError("Fixture requires an execution snapshot");
  return {
    seen,
    openaiModels,
    models: { ...job.executionModels, scriptProvider: "anthropic" as const },
    connection: { apiKey: "local-fixture-key", baseUrl: `http://127.0.0.1:${openai.port}/v1/` },
    task: (stage?: "script") => ({
      name: "video_script",
      schema: Answer,
      prompt: "fixture prompt",
      directory: store.root,
      signal: new AbortController().signal,
      ...(stage ? { stage } : {}),
    }),
  };
}

test("script-stage calls go to Claude through the official SDK with structured output", async () => {
  const f = setup();
  const result = await generateTextResult(
    { ...f.task("script"), models: { ...f.models, scriptModel: "claude-opus-5-5" } },
    f.connection,
  );
  expect(result.value).toEqual({ title: "클로드 대본", score: 7 });
  expect(result.model).toEqual({
    provider: "anthropic",
    requestedModel: "claude-opus-5-5",
    effectiveModel: "claude-opus-5-5-observed",
    quality: null,
  });
  const request = f.seen[0];
  if (!request) throw new Error("no anthropic request");
  expect(request.url).toBe("/v1/messages");
  expect(request.headers.get("x-api-key")).toBe("local-anthropic-fixture-key");
  expect(request.headers.get("authorization")).toBeNull();
  expect(request.body["model"]).toBe("claude-opus-5-5");
  const config = request.body["output_config"] as { format: { type: string }; effort: string };
  expect(config.format.type).toBe("json_schema");
  expect(config.effort).toBe("medium");
  expect(request.body["messages"]).toEqual([
    { role: "user", content: [{ type: "text", text: "fixture prompt" }] },
  ]);
});

test("without the script stage, or with scriptProvider same, the text provider is used", async () => {
  const f = setup();
  const planning = await generateTextResult({ ...f.task(), models: f.models }, f.connection);
  expect(planning.value).toEqual({ title: "지피티 대본", score: 3 });
  const same = await generateTextResult(
    { ...f.task("script"), models: { ...f.models, scriptProvider: "same" as const } },
    f.connection,
  );
  expect(same.model.provider).toBe("openai");
  expect(f.seen).toHaveLength(0);
});

test("a missing Anthropic key blocks the script stage with a connection error", async () => {
  const f = setup();
  credentials.anthropic = "";
  await expect(
    generateTextResult({ ...f.task("script"), models: f.models }, f.connection),
  ).rejects.toBeInstanceOf(MissingConnectionError);
  expect(f.seen).toHaveLength(0);
});

test("routes a script override to OpenAI even when the common text provider is disabled", async () => {
  // Given
  const f = setup();
  const models = {
    ...f.models,
    textProvider: "none",
    scriptProvider: "openai",
    scriptModel: "gpt-script-fixture",
  } as const;
  // When
  const result = await generateTextResult({ ...f.task("script"), models }, f.connection);
  // Then
  expect(f.openaiModels).toEqual(["gpt-script-fixture"]);
  expect(f.seen).toEqual([]);
  expect(result.model).toMatchObject({ provider: "openai", requestedModel: "gpt-script-fixture" });
  expect(models.textProvider).toBe("none");
});

test("uses the configured script model on the wire while planning keeps the common OpenAI model", async () => {
  // Given
  const f = setup();
  const models = {
    ...f.models,
    scriptProvider: "openai",
    scriptModel: "gpt-script-fixture",
  } as const;
  // When
  const script = await generateTextResult({ ...f.task("script"), models }, f.connection);
  const planning = await generateTextResult({ ...f.task(), models }, f.connection);
  // Then
  expect(f.openaiModels).toEqual(["gpt-script-fixture", models.textModel]);
  expect(script.model.requestedModel).toBe("gpt-script-fixture");
  expect(planning.model.requestedModel).toBe(models.textModel);
  expect(f.seen).toEqual([]);
});

test("uses the common OpenAI model as a fallback when a script override has no model ID", async () => {
  // Given
  const f = setup();
  const models = { ...f.models, textProvider: "none", scriptProvider: "openai" } as const;
  // When
  const result = await generateTextResult({ ...f.task("script"), models }, f.connection);
  // Then
  expect(f.openaiModels).toEqual([models.textModel]);
  expect(result.model.requestedModel).toBe(models.textModel);
});

test("a missing OpenAI key blocks the script override before an HTTP request", async () => {
  // Given
  const f = setup();
  const models = {
    ...f.models,
    textProvider: "none",
    scriptProvider: "openai",
    scriptModel: "gpt-script-fixture",
  } as const;
  // When / Then
  await expect(
    generateTextResult({ ...f.task("script"), models }, { ...f.connection, apiKey: "" }),
  ).rejects.toThrow("OpenAI API 키");
  expect(f.openaiModels).toEqual([]);
  expect(f.seen).toEqual([]);
});
