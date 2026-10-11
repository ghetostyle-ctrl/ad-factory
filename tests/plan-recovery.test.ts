import { afterEach, expect, test } from "bun:test";
import { contentDigest } from "../server/automation-guard";
import { validatePlanEvidence } from "../server/source-evidence";
import { PlanRecoverySchema } from "../shared/plan-recovery";
import { recoveryFixture } from "./plan-recovery-fixture";

const fixtures: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function setup(hardFailure = false) {
  const f = await recoveryFixture(hardFailure);
  fixtures.push(f);
  return f;
}
test("offers the saved plan with composition warnings and no provider request", async () => {
  // Given
  const f = await setup();
  // When
  const response = await f.app.request(f.path);
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const view = PlanRecoverySchema.parse(await response.json());
  expect(view.canUse).toBe(true);
  expect(view.warnings.join(" ")).toContain("BOFU");
  expect(view.hypotheses.map((h) => h.creative)).toEqual(f.plan.hypotheses.map((h) => h.creative));
  expect(f.requests).toHaveLength(0);
  expect(f.store.get(f.id).status).toBe("blocked");
});
test("using the saved plan queues production once and binds acknowledgement to its unchanged content", async () => {
  // Given
  const f = await setup();
  const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
  const body = {
    confirmation: true,
    action: "use",
    draftName: view.draftName,
    draftDigest: view.draftDigest,
  };
  // When
  const response = await f.post(body);
  // Then
  expect(response.status).toBe(200);
  const job = f.store.get(f.id);
  expect(job.status).toBe("queued");
  expect(job.creativePlan).toEqual(f.plan);
  expect(job.automation?.planChoice?.planDigest).toBe(
    contentDigest(JSON.stringify(job.creativePlan)),
  );
  expect(job.automation?.approvedPlanDigest).toBe(job.automation?.planChoice?.planDigest);
  expect(job.creativeVariants).toHaveLength(3);
  expect(f.requests).toHaveLength(0);
  if (!job.sourceSnapshot || !job.creativePlan) throw new TypeError("Plan required");
  const { creativePlan, sourceSnapshot } = job;
  expect(() => validatePlanEvidence(creativePlan, sourceSnapshot, 3)).toThrow();
  expect((await f.post(body)).status).toBe(409);
});
test("replanning keeps the old draft and records its problems for the next generation", async () => {
  // Given
  const f = await setup();
  const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
  // When
  const response = await f.post({
    confirmation: true,
    action: "replan",
    draftName: view.draftName,
    draftDigest: view.draftDigest,
  });
  // Then
  expect(response.status).toBe(200);
  const job = f.store.get(f.id);
  expect(job.creativePlan).toBeNull();
  expect(job.status).toBe("queued");
  expect(job.automation?.planChoice?.action).toBe("replan");
  expect(job.automation?.planChoice?.issues.join(" ")).toContain("BOFU");
  expect(job.artifacts.some((a) => a.name === view.draftName)).toBe(true);
  expect(f.requests).toHaveLength(0);
});
test("invalid references cannot be bypassed by using a draft", async () => {
  // Given
  const f = await setup(true);
  const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
  // When
  const response = await f.post({
    confirmation: true,
    action: "use",
    draftName: view.draftName,
    draftDigest: view.draftDigest,
  });
  // Then
  expect(view.canUse).toBe(false);
  expect(view.blockingIssues.length).toBeGreaterThan(0);
  expect(response.status).toBe(409);
  expect(f.store.get(f.id).creativePlan).toBeNull();
  expect(f.requests).toHaveLength(0);
});
test("stale draft digests and changed approved scope never queue production", async () => {
  // Given
  const f = await setup();
  const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
  // When / Then
  expect(
    (
      await f.post({
        confirmation: true,
        action: "use",
        draftName: view.draftName,
        draftDigest: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  f.store.change(f.id, (job) => {
    job.audience = "Changed scope";
  });
  expect(
    (
      await f.post({
        confirmation: true,
        action: "use",
        draftName: view.draftName,
        draftDigest: view.draftDigest,
      })
    ).status,
  ).toBe(409);
  expect(f.store.get(f.id).status).toBe("blocked");
  expect(f.requests).toHaveLength(0);
});
