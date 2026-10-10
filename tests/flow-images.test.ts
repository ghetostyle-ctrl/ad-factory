import { afterEach, expect, test } from "bun:test";
import { generateImageResult } from "../server/image-provider";
import { flowImagesOf } from "../shared/flow-images";
import { flowImageFixture, flowPng } from "./flow-images-fixture";

const fixtures: Awaited<ReturnType<typeof flowImageFixture>>[] = [];
async function fixture(revise = false) {
  const f = await flowImageFixture({ revise });
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function requestId(f: Awaited<ReturnType<typeof fixture>>) {
  const id = flowImagesOf(f.store.get(f.id)).find((item) => !item.digest)?.id;
  if (!id) throw new TypeError("pending request missing");
  return id;
}
test("Flow image waits without consuming attempts, then confirmed upload completes normal review", async () => {
  const f = await fixture();
  expect(f.store.get(f.id).automation).toMatchObject({
    status: "waiting",
    imageAttempts: 0,
    phase: "image",
  });
  const id = requestId(f);
  const bytes = flowPng(f.root);
  expect((await f.upload(id, bytes, false)).status).toBe(400);
  expect((await f.upload(id, bytes)).status).toBe(200);
  await f.settle();
  expect(f.store.get(f.id).automation?.status).toBe("completed");
  expect(f.counts.review).toBe(1);
  expect(f.store.get(f.id).artifacts.find((asset) => asset.kind === "image")?.model?.provider).toBe(
    "flow",
  );
  expect((await f.upload(id, bytes)).status).toBe(409);
}, 30_000);
test("invalid files and wrong aspect preserve pending state", async () => {
  const f = await fixture();
  const id = requestId(f);
  expect(
    (await f.upload(id, new TextEncoder().encode("not an image"))).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await f.upload(id, flowPng(f.root, "288x512"))).status).toBe(400);
  expect(flowImagesOf(f.store.get(f.id))[0]?.digest).toBeNull();
  expect(f.counts.review).toBe(0);
}, 30_000);
test("cross-job requests and stopped jobs cannot upload or wake production", async () => {
  const f = await fixture();
  const other = await fixture();
  const id = requestId(f);
  expect((await other.upload(id, flowPng(other.root))).status).toBe(404);
  await f.engine.stop(f.id);
  expect((await f.upload(id, flowPng(f.root))).status).toBe(409);
  expect(f.store.get(f.id).automation?.status).toBe("stopped");
}, 30_000);
test("failed image reviews ask for a new upload and never force acceptance", async () => {
  const f = await fixture(true);
  const bytes = flowPng(f.root);
  expect((await f.upload(requestId(f), bytes)).status).toBe(200);
  await f.settle();
  expect(f.store.get(f.id).automation?.status).toBe("waiting");
  expect(flowImagesOf(f.store.get(f.id))).toHaveLength(2);
  expect((await f.upload(requestId(f), bytes)).status).toBe(200);
  await f.settle();
  expect(f.store.get(f.id).automation?.status).not.toBe("completed");
  expect(f.store.get(f.id).automation?.approvedImageId).toBeNull();
  expect(f.counts.review).toBe(2);
}, 30_000);
test("Flow selection blocks direct OpenAI image calls even with a key", async () => {
  const f = await fixture();
  const models = f.store.get(f.id).executionModels;
  if (!models) throw new TypeError("models missing");
  await expect(
    generateImageResult(
      { prompt: "fixture", models, signal: new AbortController().signal },
      { apiKey: "must-not-be-used", baseUrl: "http://127.0.0.1:1" },
    ),
  ).rejects.toThrow("Flow 이미지 제작");
});
