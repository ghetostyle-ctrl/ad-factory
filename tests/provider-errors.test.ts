import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { z } from "zod";
import { MissingConnectionError } from "../server/errors";
import { generateImageResult } from "../server/image-provider";
import type { JobStore } from "../server/store";
import { generateTextResult } from "../server/text-provider";
import { providerStore } from "./provider-fixtures";

const stores: JobStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});
function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const store = providerStore();
  stores.push(store);
  const job = store.list()[0];
  if (!job?.executionModels) throw new TypeError("Fixture requires models");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return {
    models: job.executionModels,
    connection: { apiKey: "", baseUrl: `http://127.0.0.1:${server.port}/v1/` },
    directory: store.root,
  };
}

test("identifies missing image credentials before any provider request", async () => {
  // Given
  let requests = 0;
  const input = fixture(() => {
    requests += 1;
    return Response.json({});
  });
  // When
  const result = generateImageResult(
    { prompt: "fixture", models: input.models, signal: new AbortController().signal },
    input.connection,
  );
  // Then
  await expect(result).rejects.toBeInstanceOf(MissingConnectionError);
  expect(requests).toBe(0);
});

test("identifies disabled text provider before any provider request", async () => {
  // Given
  let requests = 0;
  const input = fixture(() => {
    requests += 1;
    return Response.json({});
  });
  // When
  const result = generateTextResult(
    {
      prompt: "fixture",
      name: "fixture",
      models: { ...input.models, textProvider: "none" },
      directory: input.directory,
      schema: z.object({ ok: z.boolean() }),
      signal: new AbortController().signal,
    },
    input.connection,
  );
  // Then
  await expect(result).rejects.toBeInstanceOf(MissingConnectionError);
  expect(requests).toBe(0);
});

test("does not mark an invalid paid response as a missing connection or repeat its POST", async () => {
  // Given
  let requests = 0;
  const input = fixture(() => {
    requests += 1;
    return Response.json({ data: [] });
  });
  // When
  const result = generateImageResult(
    { prompt: "fixture", models: input.models, signal: new AbortController().signal },
    { ...input.connection, apiKey: "fixture-key" },
  );
  // Then
  await expect(result).rejects.not.toBeInstanceOf(MissingConnectionError);
  expect(requests).toBe(1);
});

test("rejects incomplete text output when the API stops before completion", async () => {
  // Given
  const input = fixture(() =>
    Response.json({
      status: "incomplete",
      output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
    }),
  );
  // When
  const result = generateTextResult(
    {
      prompt: "fixture",
      name: "fixture",
      models: input.models,
      directory: input.directory,
      schema: z.object({ ok: z.boolean() }),
      signal: new AbortController().signal,
    },
    { ...input.connection, apiKey: "fixture-key" },
  );
  // Then
  await expect(result).rejects.toThrow();
});
