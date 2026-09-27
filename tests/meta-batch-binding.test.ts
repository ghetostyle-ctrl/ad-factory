import { afterEach, expect, test } from "bun:test";
import { contentDigest, scopeDigest } from "../server/automation-guard";
import { StudioError } from "../server/errors";
import { evidencePack } from "../server/evidence-pack";
import { ProjectStore } from "../server/project-store";
import { CreativePlanSchema } from "../shared/creative-plan";
import { ProjectSourceSnapshotSchema } from "../shared/sources";
import { batchFixture } from "./meta-batch-fixture";
import { sourceFact, sourcePlanResponse } from "./source-planning-fixture";

const fixtures: Awaited<ReturnType<typeof batchFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function sourceBatch() {
  const fixture = await batchFixture();
  fixtures.push(fixture);
  const library = new ProjectStore(fixture.store.db);
  const project = library.createProject({ name: "Source binding fixture", description: "" });
  const fact = library.addSource(project.id, sourceFact);
  const snapshot = ProjectSourceSnapshotSchema.parse(library.snapshot(project.id));
  const response = sourcePlanResponse(fact.id);
  const plan = CreativePlanSchema.parse({
    ...response,
    sourceDigest: snapshot.digest,
    sourceCoverage: evidencePack(snapshot).coverage,
    referenceAnalyses: [],
    hypotheses: response.hypotheses.map((hypothesis, index) => {
      const variant = fixture.job.creativeVariants[index];
      if (!variant) throw new StudioError("fixture", "Approved variant missing");
      return { ...hypothesis, id: variant.id, creative: variant.creative };
    }),
  });
  fixture.store.change(fixture.job.id, (draft) => {
    draft.projectId = project.id;
    draft.sourceSnapshot = snapshot;
    draft.creativePlan = plan;
    if (!draft.automation) throw new StudioError("fixture", "Automation approval missing");
    draft.automation.approvedPlanDigest = contentDigest(JSON.stringify(plan));
    draft.automation.scopeDigest = scopeDigest(draft, draft.automation.policy);
  });
  return fixture;
}

test("blocks all writes when a source-backed job has no reviewed variants", async () => {
  // Given a source plan with the old single-image fields but no approved batch.
  const fixture = await sourceBatch();
  fixture.store.change(fixture.job.id, (draft) => {
    const first = draft.creativeVariants[0];
    if (!first || !draft.automation) throw new StudioError("fixture", "Legacy approval missing");
    draft.automation.approvedImageId = first.approvedImageId;
    draft.automation.approvedImageDigest = first.approvedImageDigest;
    draft.automation.approvedCreativeDigest = first.approvedCreativeDigest;
    draft.creativeVariants = [];
  });
  // When staging chooses the source-backed path.
  await expect(fixture.stage()).rejects.toMatchObject({ code: "plan_changed" });
  // Then it cannot fall back to creating a single unplanned ad.
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("blocks all writes when a reviewed variant differs from the approved source plan", async () => {
  // Given a third creative with an internally valid review but different planned content.
  const fixture = await sourceBatch();
  fixture.store.change(fixture.job.id, (draft) => {
    const third = draft.creativeVariants[2];
    if (!third) throw new StudioError("fixture", "Third variant missing");
    third.creative = { ...third.creative, headline: "A different reviewed headline" };
    third.approvedCreativeDigest = contentDigest(JSON.stringify(third.creative));
  });
  // When staging checks the relationship between the review and approved plan.
  await expect(fixture.stage()).rejects.toMatchObject({ code: "plan_changed" });
  // Then no member of the changed batch is sent to Meta.
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("blocks all writes when two source variants reuse one approved image artifact", async () => {
  // Given three valid copy approvals whose first and third image bindings point to one artifact.
  const fixture = await sourceBatch();
  fixture.store.change(fixture.job.id, (draft) => {
    const first = draft.creativeVariants[0];
    const third = draft.creativeVariants[2];
    if (!first || !third) throw new StudioError("fixture", "Batch variant missing");
    third.approvedImageId = first.approvedImageId;
    third.approvedImageDigest = first.approvedImageDigest;
  });
  // When staging checks the entire approved image set.
  await expect(fixture.stage()).rejects.toMatchObject({ code: "review_binding" });
  // Then shared artifact reuse cannot disguise a missing independently reviewed image.
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("preserves the approval digest without new writes when a complete source batch is staged again", async () => {
  // Given an intact approved source plan and a completed paused batch.
  const fixture = await sourceBatch();
  const original = await fixture.stage();
  const originalPostCount = fixture.requests.filter((request) => request.method === "POST").length;
  // When the same completed batch is staged again.
  const repeated = await fixture.stage();
  // Then replay retains the digest and all remote object identities.
  expect(repeated.staged?.digest).toBe(original.staged?.digest);
  expect(repeated.staged?.variants).toEqual(original.staged?.variants);
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(
    originalPostCount,
  );
});
