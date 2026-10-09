import { expect, test } from "bun:test";
import { AutomationEngine } from "../server/automation";
import { automationServices } from "../server/automation-services";
import { pendingScriptApprovals } from "../shared/script-approval";
import { videoTargetSeconds } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

test("an unresolved structural draft reaches approval without generating images", async () => {
  const fixture = await renderRuntimeFixture({
    stubRender: true,
    script: (job, hypothesisId, number) => {
      const script = renderScript(number, hypothesisId, videoTargetSeconds(job.id, number));
      return {
        ...script,
        cuts: script.cuts.map((cut) => ({
          ...cut,
          source: cut.source === "approved_image" ? "project_clip" : cut.source,
        })),
      };
    },
  });
  const engine = new AutomationEngine(
    fixture.store,
    automationServices(fixture.store, {
      production: fixture.production,
      renderPipeline: fixture.renderPipeline,
    }),
  );
  try {
    const job = fixture.fresh();
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await settle(engine);
    const saved = fixture.store.get(job.id);
    expect(saved.automation?.status).toBe("waiting");
    expect(saved.renders[0]?.scriptReview?.accepted).toBe("needsFix");
    expect(pendingScriptApprovals(saved)).toEqual([1]);
    expect(fixture.counts.script).toBe(3);
    expect(fixture.counts.image).toBe(0);
    expect(fixture.counts.voice).toBe(0);
  } finally {
    engine.close();
    await fixture.close();
  }
}, 60_000);

test("a reviewed script waits before generating representative images or cards", async () => {
  const fixture = await renderRuntimeFixture({ stubRender: true });
  const engine = new AutomationEngine(
    fixture.store,
    automationServices(fixture.store, {
      production: fixture.production,
      renderPipeline: fixture.renderPipeline,
    }),
  );
  try {
    const job = fixture.fresh();
    engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1 });
    await settle(engine);
    const saved = fixture.store.get(job.id);
    expect(saved.automation?.status).toBe("waiting");
    expect(saved.renders[0]?.scriptReview?.accepted).toBe("pass");
    expect(fixture.counts.image).toBe(0);
    expect(fixture.counts.voice).toBe(0);
  } finally {
    engine.close();
    await fixture.close();
  }
}, 60_000);

test("missing 3D explanations stop automatic production before media requests", async () => {
  // Given
  const fixture = await renderRuntimeFixture({
    stubRender: true,
    script: (job, hypothesisId, number) => ({
      ...renderScript(number, hypothesisId, videoTargetSeconds(job.id, number)),
      planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    }),
  });
  const engine = new AutomationEngine(
    fixture.store,
    automationServices(fixture.store, {
      production: fixture.production,
      renderPipeline: fixture.renderPipeline,
    }),
  );
  try {
    const job = fixture.fresh();
    // When
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
      clipMode: "flow",
    });
    await settle(engine);
    const saved = fixture.store.get(job.id);
    // Then
    expect(saved.automation?.status).toBe("waiting");
    expect(saved.renders[0]?.scriptReview?.accepted).toBe("needsFix");
    expect(
      saved.renders[0]?.scriptReview?.hardProblems.some((item) => item.includes("설명 문장")),
    ).toBe(true);
    expect(fixture.counts.image).toBe(0);
    expect(fixture.counts.voice).toBe(0);
    expect(fixture.counts.veoCreate).toBe(0);
  } finally {
    engine.close();
    await fixture.close();
  }
}, 60_000);
