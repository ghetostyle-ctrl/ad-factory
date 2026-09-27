import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { credentials, envFilePath } from "../server/config";
import { BlockedError } from "../server/errors";
import { budgetMinorUnits } from "../server/meta-client";
import { InsightsSchema, metricsFromResponse } from "../server/meta-insights";
import { approvedStage } from "../server/meta-publish";
import { Pipeline, type Providers } from "../server/pipeline";
import { JobStore } from "../server/store";
import { CreateJobSchema } from "../shared/schema";

const input = {
  name: "API test",
  productUrl: "https://example.com",
  productDescription: "A factual product description that is long enough.",
  audience: "Adult shoppers",
  objective: "sales",
  dailyBudget: null,
  currency: "KRW",
  country: "KR",
} as const;
const resources: JobStore[] = [];
afterEach(async () => {
  for (const store of resources.splice(0)) {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
});
async function setup(): Promise<JobStore> {
  const store = new JobStore(await mkdtemp(join(tmpdir(), "studio-runtime-")));
  resources.push(store);
  return store;
}
const blocked = async (): Promise<never> => {
  throw new BlockedError("Test provider intentionally unavailable");
};
const providers: Providers = {
  strategy: blocked,
  creative: blocked,
  image: blocked,
  stage: blocked,
};
const request = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:4317/api${path}`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("rejects foreign Origin, forged Host, missing Origin, and invalid briefs", async () => {
  const store = await setup();
  const app = createApp(store, new Pipeline(store, providers));
  expect((await app.request("http://attacker.test:4317/api/state")).status).toBe(403);
  expect(
    (
      await app.request(
        new Request("http://127.0.0.1:4317/api/jobs", {
          method: "POST",
          headers: { Origin: "https://attacker.test" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await app.request(new Request("http://127.0.0.1:4317/api/jobs", { method: "POST" }))).status,
  ).toBe(403);
  expect((await app.request(request("/jobs", { ...input, dailyBudget: -3 }))).status).toBe(400);
  expect(store.list()).toHaveLength(0);
  expect((await app.request(request("/jobs", input))).status).toBe(201);
  expect(store.list()).toHaveLength(1);
});

test("missing provider blocks honestly and leaves no fabricated artifacts", async () => {
  const store = await setup();
  const pipeline = new Pipeline(store, providers);
  const job = store.create(CreateJobSchema.parse(input));
  await pipeline.execute(job.id, new AbortController().signal);
  const finished = store.get(job.id);
  expect(finished.status).toBe("blocked");
  expect(finished.artifacts).toHaveLength(0);
  expect(finished.agents.find((agent) => agent.id === "strategy")?.status).toBe("blocked");
  expect(finished.agents.find((agent) => agent.id === "creative")?.status).toBe("idle");
});

test("cancel aborts an actual waiting provider and prevents later stages", async () => {
  const store = await setup();
  const controller = new AbortController();
  const waiting: Providers = {
    ...providers,
    strategy: (_job, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), {
          once: true,
        });
      }),
  };
  const pipeline = new Pipeline(store, waiting);
  const job = store.create(CreateJobSchema.parse(input));
  const running = pipeline.execute(job.id, controller.signal);
  controller.abort();
  await running;
  expect(store.get(job.id).status).toBe("cancelled");
  expect(store.get(job.id).artifacts).toHaveLength(0);
});

test("publish never proceeds from a review label without real staged IDs", async () => {
  const store = await setup();
  const job = store.create(CreateJobSchema.parse(input));
  job.status = "review";
  expect(() => approvedStage(job, "invented")).toThrow();
  const app = createApp(store, new Pipeline(store, providers));
  expect(
    (
      await app.request(
        request(`/jobs/${job.id}/publish`, { confirmation: true, digest: "invented" }),
      )
    ).status,
  ).toBe(409);
});

test("saved credentials are omitted from state while the local env file remains private", async () => {
  const store = await setup();
  const app = createApp(store, new Pipeline(store, providers));
  const previous = credentials.openai;
  const previousEnv = await Bun.file(envFilePath)
    .text()
    .catch(() => "");
  try {
    expect(
      (await app.request(request("/connections", { openaiApiKey: "test-secret-do-not-persist" })))
        .status,
    ).toBe(200);
    const state = await app.request("http://127.0.0.1:4317/api/state");
    expect(await state.text()).not.toContain("test-secret");
    expect(await Bun.file(join(store.root, "studio.sqlite")).text()).not.toContain("test-secret");
  } finally {
    credentials.openai = previous;
    await Bun.write(envFilePath, previousEnv);
  }
});

test("currency units and analysis are calculated only from real response-shaped data", () => {
  expect(budgetMinorUnits(10000, "KRW")).toBe(10000);
  expect(budgetMinorUnits(12.34, "USD")).toBe(1234);
  expect(() => budgetMinorUnits(1.5, "KRW")).toThrow();
  expect(metricsFromResponse({ data: [] }, "KRW")).toBeNull();
  const response = InsightsSchema.parse({
    data: [
      {
        spend: "20",
        impressions: "1000",
        clicks: "30",
        date_start: "2026-09-01",
        date_stop: "2026-09-07",
        actions: [
          { action_type: "omni_purchase", value: "2" },
          { action_type: "purchase", value: "2" },
        ],
        action_values: [{ action_type: "omni_purchase", value: "60" }],
      },
    ],
  });
  expect(metricsFromResponse(response, "USD")).toMatchObject({
    roas: 3,
    ctr: 3,
    purchases: 2,
    revenue: 60,
  });
});
