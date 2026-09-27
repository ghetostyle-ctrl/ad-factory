import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Artifacts } from "../server/artifacts";
import { MetaClient } from "../server/meta-client";
import { approvedStage } from "../server/meta-publish";
import { MetaStager } from "../server/meta-stage";
import { Pipeline } from "../server/pipeline";
import { JobStore } from "../server/store";
import { CreativeSchema } from "../shared/planning";
import { CreateJobSchema } from "../shared/schema";

const stores: JobStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
});
const creative = CreativeSchema.parse({
  concept: "fixture",
  headline: "fixture",
  primaryText: "fixture",
  description: "fixture",
  callToAction: "SHOP_NOW",
  imagePrompt: "fixture",
  rationale: "fixture",
  checks: [],
});
async function fixture() {
  const store = new JobStore(await mkdtemp(join(tmpdir(), "studio-meta-http-")));
  stores.push(store);
  const job = store.create(
    CreateJobSchema.parse({
      name: "Fixture job",
      productUrl: "https://example.com",
      productDescription: "Factual fixture product description.",
      audience: "Adult Korean shoppers",
      objective: "sales",
      dailyBudget: 10000,
      currency: "KRW",
      country: "KR",
    }),
  );
  store.change(job.id, (draft) => {
    draft.accountId = "act_123";
    draft.selection = { accountId: "act_123", pageId: "456", pixelId: "789" };
  });
  const assets = new Artifacts(store);
  await assets.save(job.id, {
    name: "fixture.png",
    kind: "image",
    agentId: "production",
    content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  return { store, job: store.get(job.id), assets };
}
const accounts = { data: [{ id: "act_123", name: "Local HTTP fixture only", currency: "KRW" }] };
test("HTTP fixture confirms paused creation order, persisted real-response IDs and immutable approval", async () => {
  const context = await fixture();
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") return Response.json(accounts);
      const body = z.record(z.string(), z.unknown()).parse(await request.json());
      posts.push({ path, body });
      if (path.endsWith("adimages"))
        return Response.json({ images: { image: { hash: "fixture-hash" } } });
      return Response.json({ id: String(1000 + posts.length) });
    },
  });
  try {
    const client = () => new MetaClient("fixture-token", `http://127.0.0.1:${server.port}/`);
    await new MetaStager(context.store, context.assets, client).stage(
      context.job,
      creative,
      new AbortController().signal,
    );
    expect(posts.map((post) => post.path)).toEqual([
      "/act_123/adimages",
      "/act_123/campaigns",
      "/act_123/adsets",
      "/act_123/adcreatives",
      "/act_123/ads",
    ]);
    expect(posts.filter((post) => post.body["status"] === "PAUSED")).toHaveLength(3);
    expect(posts.some((post) => post.body["status"] === "ACTIVE")).toBe(false);
    const staged = context.store.change(context.job.id, (draft) => {
      draft.status = "review";
    });
    expect(staged.staged?.adId).toBe("1005");
    expect(staged.staged?.pendingOperation).toBeNull();
    expect(() => approvedStage(staged, "stale-digest")).toThrow();
    expect(approvedStage(staged, staged.staged?.digest ?? "").adId).toBe("1005");
    context.store.change(staged.id, (draft) => {
      if (draft.staged) draft.staged.pendingOperation = "publish";
    });
    expect(new Pipeline(context.store).run(staged.id).status).toBe("blocked");
    expect(() =>
      approvedStage(context.store.get(staged.id), staged.staged?.digest ?? ""),
    ).toThrow();
    staged.dailyBudget = 20000;
    expect(() => approvedStage(staged, staged.staged?.digest ?? "")).toThrow();
  } finally {
    await server.stop(true);
  }
});
test("HTTP failure leaves uncertainty marker and retry never duplicates a POST", async () => {
  const context = await fixture();
  let postCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "GET") return Response.json(accounts);
      postCount++;
      return Response.json({ error: "fixture-only outage" }, { status: 503 });
    },
  });
  try {
    const stager = new MetaStager(
      context.store,
      context.assets,
      () => new MetaClient("fixture-token", `http://127.0.0.1:${server.port}/`),
    );
    await expect(
      stager.stage(context.job, creative, new AbortController().signal),
    ).rejects.toThrow();
    expect(context.store.get(context.job.id).staged?.pendingOperation).toBe("image upload");
    await expect(
      stager.stage(context.store.get(context.job.id), creative, new AbortController().signal),
    ).rejects.toThrow();
    expect(postCount).toBe(1);
  } finally {
    await server.stop(true);
  }
});
