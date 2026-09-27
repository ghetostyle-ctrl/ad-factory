import { afterEach, expect, test } from "bun:test";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { scopeDigest } from "../server/automation-guard";
import { MissingConnectionError } from "../server/errors";
import { JobStore } from "../server/store";
import { automationFixture, automationPolicy } from "./automation-fixture";

const fixtures: Awaited<ReturnType<typeof automationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  return fixture;
}

test("scope tampering prevents external calls", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, automationPolicy());
  fixture.store.change(job.id, (draft) => {
    draft.dailyBudget = 50;
  });
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("attention");
  expect(fixture.requests).toHaveLength(0);
});

test("stopped creative work can resume and reset clears generated state", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 0 });
  fixture.store.change(job.id, (draft) => {
    if (draft.automation) {
      draft.automation.status = "stopped";
      draft.automation.operation = "strategy";
      draft.automation.lastError =
        "공급자 요청 실패 (HTTP 401). 서버 설정과 공급자 권한을 확인하세요.";
    }
  });
  expect(() => fixture.engine.resume(job.id)).not.toThrow();
  expect(fixture.store.get(job.id).automation?.status).toBe("queued");
  const reset = new AutomationEnrollment(fixture.store).reset(job.id);
  expect(reset.automation).toBeNull();
  expect(reset.creativePlan).toBeNull();
  expect(reset.status).toBe("queued");
});

test("stopped creative work can resume after an incomplete AI response", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 0 });
  fixture.store.change(job.id, (draft) => {
    if (draft.automation) {
      draft.automation.status = "stopped";
      draft.automation.operation = "creative";
      draft.automation.lastError = "AI 응답이 완료되지 않았습니다. 응답을 검토하세요.";
    }
  });
  expect(() => fixture.engine.resume(job.id)).not.toThrow();
  expect(fixture.store.get(job.id).automation?.status).toBe("queued");
});
test("uncertain external create is never repeated by timer, resume, config wake or restart", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.failPath = "/meta/act_123/campaigns";
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(job.id).staged?.pendingOperation).toBe("campaignId");
  expect(fixture.store.get(job.id).automation?.status).toBe("attention");
  expect(() => fixture.engine.resume(job.id)).toThrow();
  fixture.engine.wakeBlocked();
  await fixture.settle();
  const recovered = new JobStore(fixture.root);
  try {
    const engine = new AutomationEngine(recovered, fixture.services);
    await engine.tick();
    expect(recovered.get(job.id).automation?.status).toBe("attention");
  } finally {
    recovered.close();
  }
  expect(fixture.requests.filter((item) => item.path === fixture.control.failPath)).toHaveLength(1);
});
test("safe persisted queued work recovers while billed pending work stays attention", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, automationPolicy());
  fixture.engine.close();
  await fixture.settle();
  fixture.store.change(job.id, (draft) => {
    if (draft.automation && draft.automation.policy.mode !== "creative") {
      draft.automation.operation = "image";
      draft.automation.status = "running";
    }
  });
  const recovered = new JobStore(fixture.root);
  try {
    expect(recovered.get(job.id).automation?.status).toBe("attention");
    expect(recovered.get(job.id).automation?.operation).toBe("image");
    const engine = new AutomationEngine(recovered, fixture.services);
    await engine.tick();
  } finally {
    recovered.close();
  }
  expect(fixture.requests).toHaveLength(0);
});
test("missing connections block safely then connection wake resumes same scope", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  let available = false;
  const engine = new AutomationEngine(fixture.store, {
    ...fixture.services,
    prepare: async (id, signal) => {
      if (!available) throw new MissingConnectionError("Fixture missing key");
      await fixture.services.prepare(id, signal);
    },
  });
  engine.start(job.id, automationPolicy());
  await Promise.all([...engine.active.values()].map((task) => task.promise));
  expect(fixture.store.get(job.id).automation?.status).toBe("blocked");
  const digest = fixture.store.get(job.id).automation?.scopeDigest;
  available = true;
  engine.wakeBlocked();
  await Promise.all([...engine.active.values()].map((task) => task.promise));
  expect(fixture.store.get(job.id).automation?.status).toBe("waiting");
  expect(fixture.store.get(job.id).automation?.scopeDigest).toBe(digest);
  expect(fixture.requests.filter((item) => item.path.endsWith("images/generations"))).toHaveLength(
    1,
  );
  engine.close();
});
test("expiry stops and confirms remote PAUSED", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  fixture.store.change(job.id, (draft) => {
    if (draft.automation) {
      if (draft.automation.policy.mode !== "creative")
        draft.automation.policy.endAt = new Date(Date.now() - 1000).toISOString();
      draft.automation.scopeDigest = scopeDigest(draft, draft.automation.policy);
    }
  });
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("stopped");
  expect(fixture.store.get(job.id).staged?.deliveryStatus).toBe("PAUSED");
});

test("cumulative spend limit stops and confirms remote PAUSED", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.control.spend = 100;
  fixture.engine.start(job.id, automationPolicy());
  await fixture.settle();
  expect(fixture.store.get(job.id).automation?.status).toBe("stopped");
  expect(fixture.store.get(job.id).staged?.deliveryStatus).toBe("PAUSED");
});
test("safe queued checkpoints resume after reopening SQLite without a second campaign", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  fixture.engine.start(job.id, automationPolicy());
  fixture.engine.close();
  await fixture.settle();
  const recovered = new JobStore(fixture.root);
  try {
    expect(recovered.get(job.id).automation?.status).toBe("queued");
    const engine = new AutomationEngine(recovered, fixture.services);
    await engine.tick();
    expect(recovered.get(job.id).automation?.status).toBe("waiting");
    expect(fixture.requests.filter((item) => item.path.endsWith("/campaigns"))).toHaveLength(1);
  } finally {
    recovered.close();
  }
});
test("overlapping worker ticks claim a queued job once", async () => {
  const fixture = await setup();
  const job = fixture.fresh();
  const second = new AutomationEngine(fixture.store, fixture.services);
  fixture.engine.start(job.id, automationPolicy());
  await Promise.all([fixture.settle(), second.tick()]);
  expect(fixture.requests.filter((item) => item.path.endsWith("images/generations"))).toHaveLength(
    1,
  );
  expect(fixture.requests.filter((item) => item.path.endsWith("/campaigns"))).toHaveLength(1);
  second.close();
});
