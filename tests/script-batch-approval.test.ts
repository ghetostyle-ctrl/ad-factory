import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { automationServices } from "../server/automation-services";
import { env } from "../server/config";
import { Pipeline } from "../server/pipeline";
import { scriptApproved, scriptDigestOf } from "../shared/script-approval";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";

let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
let app: ReturnType<typeof createApp>;
let id: string;
const origin = `http://127.0.0.1:${env.PORT}`;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, {
      production: f.production,
      renderPipeline: f.renderPipeline,
    }),
  );
  app = createApp(f.store, new Pipeline(f.store), engine);
  id = f.fresh().id;
  engine.start(id, { mode: "creative", imageCount: 1, videoCount: 1 });
  await settle(engine);
});
afterEach(async () => {
  engine.close();
  await f.close();
});
function body() {
  return {
    confirmation: true,
    scripts: f.store.get(id).videoScripts.map((script) => ({
      number: script.number,
      digest: scriptDigestOf(script),
    })),
  };
}
function post(value: unknown, requestOrigin = origin) {
  return app.request(
    new Request(`${origin}/api/jobs/${id}/scripts/approve`, {
      method: "POST",
      headers: { Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }),
  );
}
test("batch approval approves eligible scripts and preserves blocked drafts and existing approvals", async () => {
  // Given
  f.store.change(id, (job) => {
    const base = job.videoScripts[0];
    const render = job.renders[0];
    if (!base || !render || job.automation?.policy.mode !== "creative")
      throw new TypeError("Fixture required");
    job.automation.policy.videoCount = 3;
    job.videoScripts.push(
      { ...structuredClone(base), number: 2 },
      { ...structuredClone(base), number: 3 },
    );
    job.renders.push(
      { ...structuredClone(render), number: 2 },
      { ...structuredClone(render), number: 3 },
    );
    const blocked = job.videoScripts[1];
    const blockedRender = job.renders[1];
    if (!blocked?.voiceover[0] || !blockedRender?.scriptReview)
      throw new TypeError("Fixture required");
    blocked.voiceover[0].text = "ABC invalid narration";
    blockedRender.scriptReview.accepted = "needsFix";
  });
  engine.services.scripts.approve(id, 3);
  const prior = structuredClone(f.store.get(id));
  // When
  const response = await post(body());
  // Then
  expect(response.status).toBe(200);
  expect(scriptApproved(f.store.get(id), 1)).toBe(true);
  expect(scriptApproved(f.store.get(id), 2)).toBe(false);
  expect(f.store.get(id).renders[2]?.scriptApproval).toEqual(prior.renders[2]?.scriptApproval);
  expect(f.store.get(id).videoScripts).toEqual(prior.videoScripts);
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(f.counts.voice).toBe(0);
});
test("stale batch approval refuses every mutation", async () => {
  // Given
  const request = body();
  const item = request.scripts[0];
  if (!item) throw new TypeError("Fixture required");
  item.digest = "0".repeat(64);
  // When
  const response = await post(request);
  // Then
  expect(response.status).toBe(409);
  expect(scriptApproved(f.store.get(id), 1)).toBe(false);
  expect(f.counts.voice).toBe(0);
});
test("missing confirmation and foreign origin cannot approve scripts", async () => {
  // Given / When / Then
  expect((await post({ scripts: body().scripts })).status).toBe(400);
  expect((await post(body(), "https://example.com")).status).toBe(403);
  expect(scriptApproved(f.store.get(id), 1)).toBe(false);
});
test("final batch approval wakes production through the real route", async () => {
  // Given / When
  const response = await post(body());
  await settle(engine);
  // Then
  expect(response.status).toBe(200);
  expect(f.counts.voice).toBeGreaterThan(0);
  expect(f.store.get(id).automation?.status).toBe("completed");
}, 60_000);
test("missing numbered script cannot approve a different stored script", async () => {
  f.store.change(id, (job) => {
    const script = job.videoScripts[0];
    if (!script || job.automation?.policy.mode !== "creative")
      throw new TypeError("Fixture required");
    job.videoScripts.push({ ...structuredClone(script), number: 3 });
    job.automation.policy.videoCount = 3;
  });
  const script = f.store.get(id).videoScripts[1];
  if (!script) throw new TypeError("Fixture required");
  const response = await post({
    confirmation: true,
    scripts: [{ number: 2, digest: scriptDigestOf(script) }],
  });
  expect(response.status).toBe(409);
  expect(
    f.store.get(id).renders.find((render) => render.number === 2)?.scriptApproval,
  ).toBeUndefined();
});
