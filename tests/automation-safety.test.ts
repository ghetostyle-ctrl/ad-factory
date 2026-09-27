import { afterEach, expect, test } from "bun:test";
import { Artifacts } from "../server/artifacts";
import { contentDigest } from "../server/automation-guard";
import { MetaClient } from "../server/meta-client";
import { MetaStager } from "../server/meta-stage";
import { automationFixture, automationPolicy } from "./automation-fixture";
import { fixtureCreative } from "./automation-http-fixture";

const fixtures: Awaited<ReturnType<typeof automationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  return fixture;
}
async function reached(fixture: Awaited<ReturnType<typeof setup>>, path: string): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (fixture.requests.some((item) => item.path === path && item.method === "POST")) return;
    await Bun.sleep(5);
  }
  throw new Error("Local fixture did not reach expected path");
}

test("AI revision is bounded to two images and rejection cannot activate", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.revisions = 3;
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("attention");
  expect(fixture.store.get(job.id).automation?.imageAttempts).toBe(2);
  expect(fixture.requests.filter((item) => item.path.endsWith("images/generations"))).toHaveLength(
    2,
  );
  expect(fixture.requests.filter((item) => item.path.startsWith("/meta/"))).toHaveLength(0);
  fixture.engine.wakeBlocked();
  await fixture.settle();
  expect(fixture.requests.filter((item) => item.path.endsWith("images/generations"))).toHaveLength(
    2,
  );
});
test("remote spend cap or copy drift blocks all ACTIVE requests", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.limitOffset = 1;
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("attention");
  expect(fixture.requests.filter((item) => item.body["status"] === "ACTIVE")).toHaveLength(0);
  const second = fixture.fresh();
  fixture.control.limitOffset = 0;
  fixture.control.copyChanged = true;
  fixture.engine.start(second.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(second.id).automation?.status).toBe("attention");
  expect(fixture.requests.filter((item) => item.body["status"] === "ACTIVE")).toHaveLength(0);
});
test("stop during image request prevents all later Meta writes", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  const gate = Promise.withResolvers<void>();
  fixture.control.holdPath = "/openai/images/generations";
  fixture.control.hold = gate.promise;
  fixture.engine.start(job.id, automationPolicy());
  await reached(fixture, fixture.control.holdPath);
  const stopping = fixture.engine.stop(job.id);
  gate.resolve();
  await stopping;
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("stopped");
  expect(fixture.store.get(job.id).agents.some((agent) => agent.status === "running")).toBe(false);
  expect(fixture.requests.filter((item) => item.path.startsWith("/meta/"))).toHaveLength(0);
});
test("stop racing final activation waits and compensates with confirmed campaign PAUSED", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  const gate = Promise.withResolvers<void>();
  fixture.control.holdPath = "/meta/1001";
  fixture.control.hold = gate.promise;
  fixture.engine.start(job.id, automationPolicy());
  await reached(fixture, fixture.control.holdPath);
  const stopping = fixture.engine.stop(job.id);
  gate.resolve();
  const stopped = await stopping;
  expect(stopped.automation?.status).toBe("stopped");
  expect(stopped.staged?.deliveryStatus).toBe("PAUSED");
  const count = fixture.requests.length;
  await fixture.settle();
  expect(fixture.requests.length).toBe(count);
});
test("stager refuses an image whose bytes no longer match the passed review", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, { ...automationPolicy(), mode: "prepare" });
  await fixture.settle();
  const prepared = fixture.store.get(job.id);
  const asset = prepared.artifacts.find((item) => item.id === prepared.automation?.approvedImageId);
  expect(asset).toBeDefined();
  if (!asset) return;
  const artifacts = new Artifacts(fixture.store);
  const original = new Uint8Array(await (await artifacts.read(job.id, asset.name)).arrayBuffer());
  expect(prepared.automation?.approvedImageDigest).toBe(contentDigest(original));
  await Bun.write(artifacts.path(job.id, asset.name), new Uint8Array([1, 2, 3]));
  const clientFactory = () =>
    new MetaClient("local-fixture-only", `http://127.0.0.1:${fixture.server.port}/meta/`);
  const stager = new MetaStager(fixture.store, artifacts, clientFactory);
  await expect(
    stager.stage(prepared, fixtureCreative, new AbortController().signal),
  ).rejects.toThrow("AI가 검토한 이미지");
});
test("campaign activation applied remotely before timeout is paused and never retried", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.lostActivationResponse = true;
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  const result = fixture.store.get(job.id);
  expect(result.automation?.status).toBe("attention");
  expect(result.automation?.operation).toBe("activate");
  expect(result.staged?.deliveryStatus).toBe("PAUSED");
  expect(
    fixture.requests.filter(
      (item) => item.path === "/meta/1001" && item.body["status"] === "ACTIVE",
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter(
      (item) => item.path === "/meta/1001" && item.body["status"] === "PAUSED",
    ),
  ).toHaveLength(1);
  expect(() => fixture.engine.resume(job.id)).toThrow();
  fixture.engine.wakeBlocked();
  await fixture.settle();
  expect(
    fixture.requests.filter(
      (item) => item.path === "/meta/1001" && item.body["status"] === "ACTIVE",
    ),
  ).toHaveLength(1);
});
