import { afterEach, expect, test } from "bun:test";
import { JobSchema, StateSchema } from "../shared/schema";
import {
  automationBrief,
  automationFixture,
  automationPolicy,
  automationRequest,
} from "./automation-fixture";

const fixtures: Awaited<ReturnType<typeof automationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  return fixture;
}
const imageCalls = (fixture: Awaited<ReturnType<typeof setup>>) =>
  fixture.requests.filter((item) => item.path.endsWith("images/generations"));
const reportCalls = (fixture: Awaited<ReturnType<typeof setup>>) =>
  fixture.requests.filter(
    (item) =>
      item.path.endsWith("responses") && JSON.stringify(item.body).includes("performance_analysis"),
  );

test("creative automation completes assets without Meta account or ad spend settings", async () => {
  const fixture = await setup();
  const job = fixture.store.create({ ...automationBrief, dailyBudget: null });
  const response = await fixture.app.request(
    automationRequest(`${job.id}/automation/start`, {
      confirmation: true,
      policy: { mode: "creative" },
    }),
  );
  expect(response.status).toBe(200);
  await fixture.settle();
  const result = fixture.store.get(job.id);
  expect(result.automation?.status).toBe("completed");
  expect(result.artifacts.some((asset) => asset.kind === "image")).toBe(true);
  expect(result.staged).toBeNull();
  expect(fixture.requests.filter((request) => request.path.startsWith("/meta/"))).toHaveLength(0);
});

test("legacy advertising engine still reads existing policy through activation and report", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  const response = await fixture.app.request(
    automationRequest(`${job.id}/automation/start`, {
      confirmation: true,
      policy: automationPolicy(),
    }),
  );
  expect(response.status).toBe(400);
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  const result = fixture.store.get(job.id);
  expect(result.automation?.status).toBe("waiting");
  expect(result.staged?.publishedAt).toBeString();
  expect(result.automation?.operation).toBeNull();
  expect(result.automation?.approvedImageId).toBe(result.staged?.artifactId);
  expect(result.metrics?.spend).toBe(20);
  expect(result.artifacts.some((item) => item.agentId === "analysis")).toBe(true);
  expect(imageCalls(fixture)).toHaveLength(1);
  expect(imageCalls(fixture)[0]?.body["model"]).toBe("gpt-image-2.5-sunburst");
  expect(fixture.requests.filter((item) => item.body["status"] === "ACTIVE")).toHaveLength(3);
  expect(fixture.requests.find((item) => item.path.endsWith("/campaigns"))?.body["spend_cap"]).toBe(
    10000,
  );
  expect(fixture.requests.find((item) => item.path.endsWith("/adsets"))?.body["end_time"]).toBe(
    result.automation?.policy.mode === "activate" ? result.automation.policy.endAt : null,
  );
  expect(reportCalls(fixture)).toHaveLength(1);
  const state = StateSchema.parse(
    await (await fixture.app.request("http://127.0.0.1:4317/api/state")).json(),
  );
  expect(state.jobs[0]?.automation?.nextAnalysisAt).toBeString();
});

test("empty, all-zero, and unchanged actual Insights wait without repeated billed reports", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.empty = true;
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("waiting");
  expect(reportCalls(fixture)).toHaveLength(0);
  const due = () =>
    fixture.store.change(job.id, (draft) => {
      if (draft.automation) draft.automation.nextRunAt = new Date().toISOString();
    });
  fixture.control.empty = false;
  fixture.control.zero = true;
  due();
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("waiting");
  expect(reportCalls(fixture)).toHaveLength(0);
  fixture.control.zero = false;
  due();
  await fixture.settle();
  expect(reportCalls(fixture)).toHaveLength(1);
  due();
  await fixture.settle();
  expect(reportCalls(fixture)).toHaveLength(1);
  expect(imageCalls(fixture)).toHaveLength(1);
});

test("clean enrollment validates explicit scope and confirmation; old jobs remain unenrolled", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  expect(
    (
      await fixture.app.request(
        automationRequest(`${job.id}/automation/start`, {
          confirmation: false,
          policy: automationPolicy(),
        }),
      )
    ).status,
  ).toBe(400);
  const legacy = fixture.store.get(job.id);
  const { automation, executionModels, ...old } = legacy;
  expect(automation).toBeNull();
  expect(executionModels).toBeNull();
  expect(JobSchema.parse(old).automation).toBeNull();
  const blank = fixture.store.create({ ...job, dailyBudget: null });
  expect(() => fixture.engine.start(blank.id, automationPolicy())).toThrow();
  await fixture.engine.tick();
  expect(fixture.requests).toHaveLength(0);
  fixture.store.change(job.id, (draft) => {
    draft.artifacts.push({
      id: "old",
      name: "old.json",
      kind: "json",
      agentId: "strategy",
      url: "old",
      model: null,
    });
  });
  expect(() => fixture.engine.start(job.id, automationPolicy())).toThrow();
});
