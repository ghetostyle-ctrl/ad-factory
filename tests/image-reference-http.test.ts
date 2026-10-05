import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { generateImageResult } from "../server/image-provider";
import { imageInput } from "../server/provider-image-input";
import type { JobStore } from "../server/store";
import { png, providerStore } from "./provider-fixtures";

const stores: JobStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

function fixture() {
  const requests: { path: string; body: unknown }[] = [];
  const store = providerStore();
  stores.push(store);
  const models = store.list()[0]?.executionModels;
  if (!models) throw new Error("fixture model snapshot missing");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  servers.push(server);
  return {
    requests,
    models,
    connection: { apiKey: "local-fixture-key", baseUrl: `http://127.0.0.1:${server.port}/v1/` },
  };
}

test("sends actual reference pixels to image edits while preserving pinned model and output settings", async () => {
  // Given
  const f = fixture();
  const referenceImages = [new Uint8Array(png), new Uint8Array([255, 216, 255, 224])];
  // When
  const output = await generateImageResult(
    {
      prompt: "fixture",
      signal: new AbortController().signal,
      models: f.models,
      size: "1024x1536",
      referenceImages,
    },
    f.connection,
  );
  // Then
  expect(f.requests).toEqual([
    {
      path: "/v1/images/edits",
      body: {
        prompt: "fixture",
        model: f.models.imageModel,
        quality: f.models.imageQuality,
        n: 1,
        size: "1024x1536",
        output_format: "png",
        images: referenceImages.map((bytes) => ({ image_url: imageInput(bytes).dataUrl })),
      },
    },
  ]);
  expect(output.value).toEqual(new Uint8Array(png));
});

test.each([{ referenceImages: undefined }, { referenceImages: [] }])(
  "keeps text-only generation when references are %p",
  async ({ referenceImages }) => {
    // Given
    const f = fixture();
    // When
    await generateImageResult(
      {
        prompt: "fixture",
        signal: new AbortController().signal,
        models: f.models,
        ...(referenceImages ? { referenceImages } : {}),
      },
      f.connection,
    );
    // Then
    expect(f.requests).toEqual([
      {
        path: "/v1/images/generations",
        body: {
          prompt: "fixture",
          model: f.models.imageModel,
          quality: f.models.imageQuality,
          n: 1,
          size: "1024x1024",
          output_format: "png",
        },
      },
    ]);
  },
);
