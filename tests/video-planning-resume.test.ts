import { expect, test } from "bun:test";
import { contentDigest, scopeDigest } from "../server/automation-guard";
import type { ProductionProviders } from "../server/automation-production";
import { WaitingError } from "../server/errors";
import { evidencePack } from "../server/evidence-pack";
import { ProjectStore } from "../server/project-store";
import { SourceProduction } from "../server/source-production";
import { CreativePlanSchema } from "../shared/creative-plan";
import { videoTargetSeconds } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourceFact, sourcePlanResponse, sourceStrategy } from "./source-planning-fixture";
import { planningModel as model, planningPipelineFixture } from "./video-planning-pipeline-fixture";

test.each([
  { name: "a legacy job with B already saved", saved: ["b"], written: ["a", "c"] },
  { name: "a fresh job", saved: [], written: ["a", "b", "c"] },
])("uses each hypothesis in raw tie order for $name", async ({ saved, written }) => {
  // Given
  const f = planningPipelineFixture();
  const library = new ProjectStore(f.store.db);
  const project = library.createProject({ name: "Resume fixture", description: "" });
  const fact = library.addSource(project.id, sourceFact);
  const snapshot = library.snapshot(project.id);
  const response = sourcePlanResponse(fact.id);
  const [tofu, comparison, comparisonOther] = response.hypotheses;
  if (!tofu || !comparison || !comparisonOther) throw new TypeError("Resume hypotheses missing");
  const plan = CreativePlanSchema.parse({
    ...response,
    hypotheses: [
      { ...comparison, id: "a" },
      { ...tofu, id: "b" },
      { ...comparisonOther, id: "c" },
    ],
    sourceDigest: snapshot.digest,
    sourceCoverage: evidencePack(snapshot).coverage,
    referenceAnalyses: [],
  });
  const originals = saved.map((hypothesisId, index) => ({
    ...f.script,
    number: index + 1,
    hypothesisId,
    title: "이전에 저장된 대본",
    planning: f.planning,
  }));
  const policy = { mode: "creative", imageCount: 3, videoCount: 3 } as const;
  const job = f.store.change(f.job.id, (draft) => {
    draft.projectId = project.id;
    draft.sourceSnapshot = snapshot;
    draft.creativePlan = plan;
    draft.videoScripts = originals;
    draft.creativeVariants = plan.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      creative: hypothesis.creative,
      imageAttempts: 0,
      approvedImageId: null,
      approvedImageDigest: null,
      approvedCreativeDigest: null,
      reviewStatus: "pending",
      cardImageIds: [],
    }));
    if (!draft.automation) throw new TypeError("Resume automation missing");
    draft.automation.policy = policy;
    draft.automation.scopeDigest = scopeDigest(draft, policy);
    draft.automation.approvedPlanDigest = contentDigest(JSON.stringify(plan));
  });
  const writes: { readonly number: number; readonly hypothesisId: string }[] = [];
  f.store.change(job.id, (draft) => {
    if (!draft.automation) throw new TypeError("Resume automation missing");
    draft.automation.scopeDigest = scopeDigest(draft, draft.automation.policy);
  });
  let images = 0;
  const unexpected = async () => {
    throw new TypeError("Unexpected production provider");
  };
  const providers: ProductionProviders = {
    strategy: unexpected,
    creative: unexpected,
    review: unexpected,
    image: async () => {
      images++;
      return unexpected();
    },
    videoScript: async (current, hypothesis, number) => {
      writes.push({ number, hypothesisId: hypothesis.id });
      const script = renderScript(number, hypothesis.id, videoTargetSeconds(current.id, number));
      return {
        value: {
          ...script,
          cuts: script.cuts.map((cut) =>
            cut.source === "project_clip" || cut.source === "card_slide"
              ? { ...cut, source: "approved_image" as const }
              : cut,
          ),
        },
        model,
      };
    },
    reviewVideoScript: async () => ({
      value: { status: "pass", summary: "검토 통과", issues: [] },
      model,
    }),
  };
  try {
    // When
    const result = new SourceProduction(f.store, providers).run(
      job.id,
      sourceStrategy,
      f.input.signal,
    );
    // Then
    await expect(result).rejects.toBeInstanceOf(WaitingError);
    expect(writes).toEqual(
      written.map((hypothesisId, index) => ({
        number: saved.length + index + 1,
        hypothesisId,
      })),
    );
    const completed = f.store.get(job.id);
    expect(completed.videoScripts.map((script) => script.hypothesisId)).toEqual([
      ...saved,
      ...written,
    ]);
    expect(completed.videoScripts.slice(0, saved.length)).toEqual(originals);
    expect(completed.creativePlan).toEqual(plan);
    expect(images).toBe(0);
  } finally {
    await f.close();
  }
});
