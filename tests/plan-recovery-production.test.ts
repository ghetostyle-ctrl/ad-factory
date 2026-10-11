import { expect, test } from "bun:test";
import { Artifacts } from "../server/artifacts";
import { acceptsComposition } from "../server/plan-drafts";
import { PlanRecoveryService } from "../server/plan-recovery";
import { SourceProduction } from "../server/source-production";
import { PlanRecoverySchema } from "../shared/plan-recovery";
import { recoveryFixture } from "./plan-recovery-fixture";
import { creative, passReview, png } from "./provider-fixtures";
import { sourceStrategy } from "./source-planning-fixture";

test("an explicitly accepted composition gap reaches image production without calling the planner again", async () => {
  // Given
  const f = await recoveryFixture();
  let planned = 0;
  let images = 0;
  const model = {
    provider: "openai",
    requestedModel: "fixture-text-model",
    effectiveModel: "fixture-observed-model",
    quality: null,
  } as const;
  const production = new SourceProduction(f.store, {
    plan: async () => {
      planned++;
      throw new TypeError("Must use the accepted plan");
    },
    strategy: async () => ({ value: sourceStrategy, model }),
    creative: async () => ({ value: creative, model }),
    image: async () => {
      images++;
      return { value: png, model };
    },
    review: async () => ({ value: { ...passReview, status: "pass" }, model }),
  });
  try {
    const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
    expect(
      (
        await f.post({
          confirmation: true,
          action: "use",
          draftName: view.draftName,
          draftDigest: view.draftDigest,
        })
      ).status,
    ).toBe(200);
    // When
    await production.run(f.id, sourceStrategy, new AbortController().signal);
    // Then
    const job = f.store.get(f.id);
    expect(planned).toBe(0);
    expect(images).toBe(7);
    expect(job.creativeVariants.every((variant) => variant.reviewStatus === "pass")).toBe(true);
    expect(job.artifacts.filter((asset) => asset.kind === "image")).toHaveLength(7);
    expect(f.requests).toHaveLength(0);
    if (!job.creativePlan) throw new TypeError("Accepted plan required");
    expect(acceptsComposition(job, job.creativePlan)).toBe(true);
    const altered = structuredClone(job.creativePlan);
    altered.limitations.push("Changed");
    expect(acceptsComposition(job, altered)).toBe(false);
  } finally {
    f.close();
  }
});
test("legacy raw drafts are restored from frozen data without any provider calls", async () => {
  // Given: an older failed run has no normalized candidate artifact.
  const f = await recoveryFixture();
  try {
    f.store.change(f.id, (job) => {
      job.artifacts = job.artifacts.filter((asset) => !asset.name.startsWith("plan-candidate-"));
    });
    // When
    const preview = await new PlanRecoveryService(f.store).inspect(f.id);
    // Then
    expect(preview?.canUse).toBe(true);
    expect(preview?.warnings.join(" ")).toContain("BOFU");
    expect(f.requests).toHaveLength(0);
  } finally {
    f.close();
  }
});
test("a selected replan preserves the old bytes and supplies the draft and problems to the new prompt", async () => {
  // Given
  const f = await recoveryFixture();
  try {
    const view = PlanRecoverySchema.parse(await (await f.app.request(f.path)).json());
    const oldText = await (await new Artifacts(f.store).read(f.id, view.draftName)).text();
    await f.post({
      confirmation: true,
      action: "replan",
      draftName: view.draftName,
      draftDigest: view.draftDigest,
    });
    // When: the local provider repeats its missing-stage draft and reaches its existing bound.
    await expect(
      f.planner.plan(f.store.get(f.id), sourceStrategy, new AbortController().signal),
    ).rejects.toMatchObject({ code: "plan_composition" });
    // Then
    expect(f.requests[0]?.input).toContain("previousPlan");
    expect(f.requests[0]?.input).toContain("BOFU");
    expect(await (await new Artifacts(f.store).read(f.id, view.draftName)).text()).toBe(oldText);
    expect(f.store.get(f.id).artifacts.some((asset) => asset.name === "plan-draft-5.json")).toBe(
      true,
    );
  } finally {
    f.close();
  }
});
