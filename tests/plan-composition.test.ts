import { expect, test } from "bun:test";
import { evidencePack } from "../server/evidence-pack";
import { validatePlanEvidence } from "../server/source-evidence";
import { learningSignal } from "../server/source-planning";
import { CreateSourceSchema } from "../shared/sources";
import { planningFixture } from "./source-planning-fixture";

test("explicit composition acknowledgement allows a missing stage without changing the copy", () => {
  // Given: review sources make BOFU feasible, while the draft remains TOFU + MOFU.
  const f = planningFixture();
  try {
    f.library.addSource(
      f.project.id,
      CreateSourceSchema.parse({
        kind: "review",
        title: "Own review",
        content: "The capacity suits my desk.",
        reviewOf: "own",
      }),
    );
    const job = f.job();
    if (!job.sourceSnapshot) throw new TypeError("Snapshot required");
    const snapshot = job.sourceSnapshot;
    const plan = {
      ...f.replies.plan,
      sourceDigest: job.sourceSnapshot.digest,
      sourceCoverage: evidencePack(job.sourceSnapshot).coverage,
      referenceAnalyses: [],
      learningSignal: learningSignal(job, 3),
    };
    const copy = JSON.stringify(plan.hypotheses);
    // When / Then
    expect(() => validatePlanEvidence(plan, snapshot, 3)).toThrow();
    expect(() => validatePlanEvidence(plan, snapshot, 3, true)).not.toThrow();
    expect(JSON.stringify(plan.hypotheses)).toBe(copy);
    const bad = structuredClone(plan);
    const hypothesis = bad.hypotheses[0];
    if (!hypothesis) throw new TypeError("Hypothesis required");
    hypothesis.referenceSourceIds = ["unobserved-reference"];
    expect(() => validatePlanEvidence(bad, snapshot, 3, true)).toThrow();
  } finally {
    f.close();
  }
});
