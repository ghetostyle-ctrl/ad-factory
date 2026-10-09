import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import ky from "ky";
import { z } from "zod";
import { generateImageResult } from "../server/image-provider";
import { Intelligence } from "../server/intelligence";
import { getModelSettings, saveModelSettings, snapshotModels } from "../server/model-settings";
import type { JobStore } from "../server/store";
import { generateTextResult } from "../server/text-provider";
import {
  creative,
  metrics,
  passReview,
  png,
  providerStore,
  report,
  response,
} from "./provider-fixtures";

const stores: JobStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
function setup(handler: (request: Request) => Response | Promise<Response>) {
  const store = providerStore();
  stores.push(store);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  const job = store.list()[0];
  if (!job?.executionModels) throw new TypeError("Fixture requires an execution snapshot");
  return {
    store,
    job,
    models: job.executionModels,
    connection: { apiKey: "local-fixture-key", baseUrl: `http://127.0.0.1:${server.port}/v1/` },
  };
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("sends selected image model and quality on the wire when production image adapter runs", async () => {
  // Given
  const requests: unknown[] = [];
  const fixture = setup(async (request) => {
    requests.push(await request.json());
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  // When
  const output = await generateImageResult(
    { prompt: "fixture", signal: new AbortController().signal, models: fixture.models },
    fixture.connection,
  );
  // Then
  expect(requests).toEqual([
    expect.objectContaining({ model: "gpt-image-2.5-flare", quality: "max", n: 1 }),
  ]);
  expect(output.value).toEqual(new Uint8Array(png));
  expect(output.model).toEqual({
    provider: "openai",
    requestedModel: "gpt-image-2.5-flare",
    effectiveModel: null,
    quality: "max",
  });
});

test("keeps running job model requests unchanged when settings change mid-request", async () => {
  // Given
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: unknown[] = [];
  const fixture = setup(async (request) => {
    requests.push(await request.json());
    received.resolve();
    await release.promise;
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const running = generateImageResult(
    { prompt: "fixture", signal: new AbortController().signal, models: fixture.models },
    fixture.connection,
  );
  await received.promise;
  // When
  saveModelSettings(fixture.store.root, {
    ...getModelSettings(fixture.store.root),
    imageModel: "gpt-image-2",
    imageQuality: "low",
  });
  release.resolve();
  await running;
  await generateImageResult(
    { prompt: "revision", signal: new AbortController().signal, models: fixture.models },
    fixture.connection,
  );
  // Then
  expect(requests).toEqual([
    expect.objectContaining({ model: "gpt-image-2.5-flare", quality: "max" }),
    expect.objectContaining({ model: "gpt-image-2.5-flare", quality: "max" }),
  ]);
  expect(fixture.store.get(fixture.job.id).executionModels?.imageModel).toBe("gpt-image-2.5-flare");
  expect(snapshotModels(fixture.store.root).imageModel).toBe("gpt-image-2");
});

test("records requested and observed text model separately when response reports an effective model", async () => {
  // Given
  const requests: unknown[] = [];
  const fixture = setup(async (request) => {
    requests.push(await request.json());
    return response({ message: "valid" });
  });
  // When
  const output = await generateTextResult(
    {
      name: "fixture",
      prompt: "fixture",
      directory: fixture.store.root,
      signal: new AbortController().signal,
      models: fixture.models,
      schema: z.object({ message: z.string() }).strict(),
    },
    fixture.connection,
  );
  // Then
  expect(requests).toEqual([expect.objectContaining({ model: "fixture-text-model" })]);
  expect(output.model).toEqual({
    provider: "openai",
    requestedModel: "fixture-text-model",
    effectiveModel: "fixture-observed-model",
    quality: null,
  });
});

test("attaches actual image bytes when vision reviews a generated asset", async () => {
  // Given
  const requests: unknown[] = [];
  const fixture = setup(async (request) => {
    requests.push(await request.json());
    return response(passReview);
  });
  // When
  const output = await new Intelligence(fixture.store.root, fixture.connection).review({
    job: fixture.job,
    creative,
    image: png,
    signal: new AbortController().signal,
  });
  // Then
  const request = z
    .object({
      input: z.array(
        z.object({
          content: z.array(z.object({ type: z.string(), image_url: z.string().optional() })),
        }),
      ),
    })
    .parse(requests[0]);
  const dataUrl = request.input
    .flatMap((item) => item.content)
    .find((item) => item.type === "input_image")?.image_url;
  expect(dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  const decoded = Buffer.from(dataUrl?.split(",")[1] ?? "", "base64");
  expect(createHash("sha256").update(decoded).digest("hex")).toBe(
    createHash("sha256").update(png).digest("hex"),
  );
  expect(output.value.status).toBe("pass");
});

test("rejects inconsistent vision decisions when a provider returns pass with unresolved issues", async () => {
  // Given
  const fixture = setup(() => response({ ...passReview, issues: ["Unsupported claim"] }));
  // When
  const reviewed = new Intelligence(fixture.store.root, fixture.connection).review({
    job: fixture.job,
    creative,
    image: png,
    signal: new AbortController().signal,
  });
  // Then
  await expect(reviewed).rejects.toThrow();
});

test("uses observed metrics when AI analysis reports recommendations separately", async () => {
  // Given
  const requests: unknown[] = [];
  const fixture = setup(async (request) => {
    requests.push(await request.json());
    return response(report);
  });
  // When
  const output = await new Intelligence(fixture.store.root, fixture.connection).report(
    fixture.job,
    metrics,
    new AbortController().signal,
  );
  // Then
  const request = z.object({ input: z.string() }).parse(requests[0]);
  const data = z
    .object({ metrics: z.unknown() })
    .parse(JSON.parse(request.input.slice(request.input.lastIndexOf("\n") + 1)));
  expect(data.metrics).toEqual(metrics);
  expect(output.value).toEqual(report);
});

test("makes no paid request when all observed metrics are zero", async () => {
  // Given
  let requests = 0;
  const fixture = setup(() => {
    requests += 1;
    return response(report);
  });
  // When
  const analysis = new Intelligence(fixture.store.root, fixture.connection).report(
    fixture.job,
    {
      ...metrics,
      spend: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
      revenue: 0,
      roas: null,
      ctr: null,
    },
    new AbortController().signal,
  );
  // Then
  await expect(analysis).rejects.toThrow();
  expect(requests).toBe(0);
});

test("structured text requests allow a bounded ten-minute response without automatic paid retries", async () => {
  // Given: inspect the real adapter request while the local fixture answers immediately.
  const fixture = setup(() => response({ message: "valid" }));
  const signal = new AbortController().signal;
  const request = spyOn(ky, "post");
  try {
    // When
    const result = await generateTextResult(
      {
        name: "fixture",
        prompt: "fixture",
        directory: fixture.store.root,
        signal,
        models: fixture.models,
        schema: z.object({ message: z.string() }).strict(),
      },
      fixture.connection,
    );
    // Then
    expect(result.value).toEqual({ message: "valid" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ timeout: 600_000, retry: 0, signal });
  } finally {
    request.mockRestore();
  }
});

test("a caller can cancel a pending structured response without waiting for its generous deadline", async () => {
  // Given
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const fixture = setup(async () => {
    requests++;
    received.resolve();
    await release.promise;
    return response({ message: "late" });
  });
  const controller = new AbortController();
  const pending = generateTextResult(
    {
      name: "fixture",
      prompt: "fixture",
      directory: fixture.store.root,
      signal: controller.signal,
      models: fixture.models,
      schema: z.object({ message: z.string() }).strict(),
    },
    fixture.connection,
  );
  try {
    await received.promise;
    // When
    controller.abort(new DOMException("Fixture user stop", "AbortError"));
    // Then
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
  } finally {
    release.resolve();
  }
});
