import { spyOn } from "bun:test";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { env } from "../server/config";
import { savePlanDraft } from "../server/plan-drafts";
import { CreateSourceSchema } from "../shared/sources";
import { planningFixture } from "./source-planning-fixture";

export async function recoveryFixture(hardFailure = false) {
  const f = planningFixture();
  f.library.addSource(
    f.project.id,
    CreateSourceSchema.parse({
      kind: "review",
      title: "Own review",
      content: "The capacity suits my desk.",
      reviewOf: "own",
    }),
  );
  const base = f.job();
  const enrolled = new AutomationEnrollment(f.store).start(base.id, {
    mode: "creative",
    imageCount: 3,
    videoCount: 0,
  });
  if (hardFailure) {
    const first = f.replies.plan.hypotheses[0];
    if (!first) throw new TypeError("Hypothesis required");
    first.referenceSourceIds = ["unobserved-reference"];
  }
  const plan = f.planner.restoreDraft(enrolled, f.replies.plan);
  await savePlanDraft(
    f.store,
    enrolled,
    1,
    {
      value: f.replies.plan,
      model: {
        provider: "openai",
        requestedModel: "fixture-text-model",
        effectiveModel: "fixture-observed-model",
        quality: null,
      },
    },
    plan,
  );
  f.store.change(base.id, (job) => {
    job.status = "blocked";
    if (!job.automation) throw new TypeError("Automation required");
    job.automation.status = "attention";
    job.automation.phase = "creative";
    job.automation.operation = "creative";
    job.automation.nextRunAt = null;
    job.automation.lastError = "구성 검토 필요";
  });
  const engine = new AutomationEngine(f.store);
  const wake = spyOn(engine, "wake").mockImplementation(() => undefined);
  const app = createApp(f.store, undefined, engine);
  const origin = "http://127.0.0.1:" + env.PORT;
  const path = origin + "/api/jobs/" + base.id + "/plan-recovery";
  return {
    ...f,
    plan,
    app,
    engine,
    id: base.id,
    path,
    post(body: unknown) {
      return app.request(path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    close() {
      engine.close();
      wake.mockRestore();
      f.close();
    },
  };
}
