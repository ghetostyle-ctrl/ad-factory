import { afterEach, expect, test } from "bun:test";
import { StudioError } from "../server/errors";
import { publishJob } from "../server/meta-publish";
import { batchFixture } from "./meta-batch-fixture";

const fixtures: Awaited<ReturnType<typeof batchFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await batchFixture();
  fixtures.push(fixture);
  return fixture;
}

test("stages three reviewed ads under one shared budget when the batch is approved", async () => {
  // Given three independently reviewed creative variants and an enrolled spending policy.
  const fixture = await setup();
  // When the batch is staged.
  const job = await fixture.stage();
  // Then only one campaign/ad set carries the spending limits and every ad remains paused.
  const posts = fixture.requests.filter((item) => item.method === "POST");
  expect(posts.filter((item) => item.path.endsWith("/campaigns"))).toHaveLength(1);
  expect(posts.filter((item) => item.path.endsWith("/adsets"))).toHaveLength(1);
  expect(posts.filter((item) => item.body["daily_budget"] !== undefined)).toHaveLength(1);
  expect(posts.find((item) => item.path.endsWith("/campaigns"))?.body).toMatchObject({
    status: "PAUSED",
    spend_cap: 10000,
  });
  expect(posts.find((item) => item.path.endsWith("/adsets"))?.body).toMatchObject({
    campaign_id: "1001",
    daily_budget: 1000,
    end_time: fixture.policy.endAt,
    status: "PAUSED",
  });
  expect(posts.filter((item) => item.path.endsWith("/ads")).map((item) => item.body)).toEqual([
    expect.objectContaining({
      adset_id: "1002",
      creative: { creative_id: "2001" },
      status: "PAUSED",
    }),
    expect.objectContaining({
      adset_id: "1002",
      creative: { creative_id: "2002" },
      status: "PAUSED",
    }),
    expect.objectContaining({
      adset_id: "1002",
      creative: { creative_id: "2003" },
      status: "PAUSED",
    }),
  ]);
  expect(
    job.staged?.variants.map((item) => [item.id, item.creativeId, item.adId, item.imageHash]),
  ).toEqual([
    ["hypothesis-1", "2001", "3001", "image-hash-1"],
    ["hypothesis-2", "2002", "3002", "image-hash-2"],
    ["hypothesis-3", "2003", "3003", "image-hash-3"],
  ]);
  expect(job.staged).toMatchObject({
    creativeId: "2001",
    adId: "3001",
    imageHash: "image-hash-1",
    pendingOperation: null,
  });
  expect(posts.filter((item) => item.body["status"] === "ACTIVE")).toHaveLength(0);
});

test("activates every ad before the shared ad set and campaign when the batch passes remote checks", async () => {
  // Given a complete paused batch.
  const fixture = await setup();
  const job = await fixture.stage();
  // When the matching review digest is published.
  const published = await publishJob(fixture.store, {
    id: job.id,
    digest: job.staged?.digest ?? "",
    client: fixture.clientFactory(),
  });
  // Then all three ads precede both shared parents and receive their delivery result.
  expect(
    fixture.requests.filter((item) => item.body["status"] === "ACTIVE").map((item) => item.path),
  ).toEqual(["/meta/3001", "/meta/3002", "/meta/3003", "/meta/1002", "/meta/1001"]);
  expect(published.staged?.variants.map((item) => item.deliveryStatus)).toEqual([
    "ACTIVE",
    "ACTIVE",
    "ACTIVE",
  ]);
  expect(published.staged?.pendingOperation).toBeNull();
  expect(published.staged?.publishedAt).toBeString();
});

test("blocks every POST when the third variant review digest is invalid", async () => {
  // Given two intact approvals and a third approval that no longer matches its bytes.
  const fixture = await setup();
  fixture.store.change(fixture.job.id, (draft) => {
    const third = draft.creativeVariants[2];
    if (!third) throw new StudioError("fixture", "Third variant missing");
    third.approvedImageDigest = "invalid-digest";
  });
  // When staging validates the complete batch.
  await expect(fixture.stage()).rejects.toMatchObject({ code: "review_binding" });
  // Then the invalid last member prevents writes for every member.
  expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(0);
  expect(fixture.store.get(fixture.job.id).staged).toBeNull();
});

test("preserves the first ad and forbids duplicate POSTs when the second creative response fails", async () => {
  // Given a batch whose second creative creation returns an ambiguous HTTP failure.
  const fixture = await setup();
  fixture.control.failCreative = 2;
  await expect(fixture.stage()).rejects.toThrow();
  const partial = fixture.store.get(fixture.job.id).staged;
  expect(partial?.pendingOperation).toBe("creativeId:hypothesis-2");
  expect(partial?.variants[0]).toMatchObject({
    creativeId: "2001",
    adId: "3001",
    imageHash: "image-hash-1",
  });
  expect(partial?.variants[1]).toMatchObject({
    creativeId: null,
    adId: null,
    imageHash: "image-hash-2",
  });
  const postsBeforeRetry = fixture.requests.filter((item) => item.method === "POST").length;
  // When the same batch is retried after the failure is removed.
  fixture.control.failCreative = 0;
  await expect(fixture.stage()).rejects.toThrow();
  // Then unresolved creation remains explicit and no new request can duplicate remote objects.
  expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(postsBeforeRetry);
  expect(fixture.store.get(fixture.job.id).staged).toEqual(partial);
});

test.each(["copy", "image"] as const)(
  "blocks every ACTIVE request when the third remote creative has %s drift",
  async (drift) => {
    // Given a complete batch whose third remote creative differs from the reviewed snapshot.
    const fixture = await setup();
    const job = await fixture.stage();
    fixture.control.drift = drift;
    // When publish verifies all members before activating any member.
    await expect(
      publishJob(fixture.store, {
        id: job.id,
        digest: job.staged?.digest ?? "",
        client: fixture.clientFactory(),
      }),
    ).rejects.toThrow();
    // Then the first two valid members also remain paused.
    expect(fixture.requests.filter((item) => item.body["status"] === "ACTIVE")).toHaveLength(0);
    expect(fixture.store.get(job.id).staged?.publishedAt).toBeNull();
  },
);

test("maps observed metrics to each variant when one ad has no observations", async () => {
  // Given a staged batch with two observed ads and one missing observation.
  const fixture = await setup();
  const job = await fixture.stage();
  fixture.control.emptyAd = "3002";
  // When automation analyzes the actual local campaign and ad responses.
  await fixture.services.analyze(job, new AbortController().signal);
  // Then each stored row remains bound to its own ad, with missing data represented as null.
  expect(fixture.store.get(job.id).variantMetrics).toEqual([
    expect.objectContaining({
      variantId: "hypothesis-1",
      adId: "3001",
      metrics: expect.objectContaining({ spend: 4 }),
    }),
    { variantId: "hypothesis-2", adId: "3002", metrics: null },
    expect.objectContaining({
      variantId: "hypothesis-3",
      adId: "3003",
      metrics: expect.objectContaining({ spend: 10 }),
    }),
  ]);
  expect(
    fixture.requests
      .filter((item) => item.path.endsWith("/insights"))
      .map((item) => item.path)
      .sort(),
  ).toEqual([
    "/meta/1001/insights",
    "/meta/3001/insights",
    "/meta/3002/insights",
    "/meta/3003/insights",
  ]);
});

test("regenerates the report when ad distribution changes but aggregate campaign metrics stay equal", async () => {
  // Given a previous report for a stable campaign total.
  const fixture = await setup();
  const job = await fixture.stage();
  await fixture.services.analyze(job, new AbortController().signal);
  const firstDigest = fixture.store.get(job.id).automation?.lastAnalysisDigest;
  fixture.control.adSpend = { "3001": 10, "3002": 6, "3003": 4 };
  // When only the allocation across ads changes.
  await fixture.services.analyze(fixture.store.get(job.id), new AbortController().signal);
  // Then a new report is generated despite unchanged campaign-level totals.
  expect(fixture.requests.filter((item) => item.path === "/openai/responses")).toHaveLength(2);
  expect(fixture.store.get(job.id).automation?.lastAnalysisDigest).not.toBe(firstDigest);
  expect(fixture.store.get(job.id).metrics?.spend).toBe(20);
});
