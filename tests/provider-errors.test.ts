import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import ky from "ky";
import { z } from "zod";
import { MissingConnectionError, publicError } from "../server/errors";
import { generateImageResult } from "../server/image-provider";
import type { JobStore } from "../server/store";
import { generateTextResult } from "../server/text-provider";
import { providerStore, response } from "./provider-fixtures";

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

test("reports the runtime socket timeout instead of a generic processing failure", () => {
  // Given
  const error = new DOMException("The operation timed out.", "TimeoutError");
  // When
  const message = publicError(error);
  // Then
  expect(message).toBe("공급자 응답 시간이 초과되었습니다. 외부 결과를 확인한 후 다시 시도하세요.");
});

test.each(["deadline", "user"] as const)(
  "stops a pending response body on %s cancellation without retrying the paid request",
  async (source) => {
    // Given: headers arrive, but the JSON body is still incomplete.
    const headersReceived = Promise.withResolvers<void>();
    let requests = 0;
    const input = fixture(() => {
      requests++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":"completed",'));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const caller = new AbortController();
    const deadline = new AbortController();
    const deadlineFactory = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchCall = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (request: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
          const response = await nativeFetch(request, options);
          headersReceived.resolve();
          return response;
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const pending = generateTextResult(
      {
        prompt: "fixture",
        name: "fixture",
        models: input.models,
        directory: input.directory,
        schema: z.object({ ok: z.boolean() }),
        signal: caller.signal,
      },
      { ...input.connection, apiKey: "fixture-key" },
    ).catch((error: unknown) => error);
    try {
      await headersReceived.promise;
      expect(deadlineFactory).toHaveBeenCalledWith(600_000);
      // When
      const reason = new DOMException(
        "Fixture cancellation",
        source === "deadline" ? "TimeoutError" : "AbortError",
      );
      (source === "deadline" ? deadline : caller).abort(reason);
      // Then
      expect(await pending).toBe(reason);
      expect(requests).toBe(1);
      expect(caller.signal.aborted).toBe(source === "user");
    } finally {
      caller.abort();
      await pending;
      fetchCall.mockRestore();
      deadlineFactory.mockRestore();
    }
  },
);

test("structured text requests allow a bounded ten-minute response without automatic paid retries", async () => {
  // Given: inspect the real adapter request while the local fixture answers immediately.
  const input = fixture(() => response({ message: "valid" }));
  const signal = new AbortController().signal;
  const request = spyOn(ky, "post");
  const nativeRequest = spyOn(globalThis, "fetch");
  const deadline = spyOn(AbortSignal, "timeout");
  try {
    // When
    const result = await generateTextResult(
      {
        name: "fixture",
        prompt: "fixture",
        directory: input.directory,
        signal,
        models: input.models,
        schema: z.object({ message: z.string() }).strict(),
      },
      { ...input.connection, apiKey: "fixture-key" },
    );
    // Then
    expect(result.value).toEqual({ message: "valid" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ retry: 0 });
    expect(nativeRequest.mock.calls[0]?.[1]).toMatchObject({ timeout: false });
    expect(deadline).toHaveBeenCalledWith(600_000);
  } finally {
    request.mockRestore();
    nativeRequest.mockRestore();
    deadline.mockRestore();
  }
});
