import { rm } from "node:fs/promises";
import { evidenceLimits } from "../server/evidence-pack";
import { AutomationStateSchema } from "../shared/automation";
import { CreativePlanSchema } from "../shared/creative-plan";
import { videoTargetSeconds } from "../shared/video-script";
import { providerStore } from "./provider-fixtures";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

export const planningModel = {
  provider: "openai",
  requestedModel: "local-fixture",
  effectiveModel: "local-fixture",
  quality: null,
} as const;

export function planningPipelineFixture() {
  const store = providerStore();
  const initialJob = store.list()[0];
  if (!initialJob) throw new TypeError("Planning fixture job missing");
  const creativePlan = CreativePlanSchema.parse({
    ...sourcePlanResponse("fact-1"),
    sourceDigest: "fixture",
    referenceAnalyses: [],
    sourceCoverage: {
      factsUsed: [],
      referencesUsed: [],
      voicesUsed: [],
      excluded: [],
      limits: evidenceLimits,
    },
  });
  const hypothesis = creativePlan.hypotheses[1];
  if (!hypothesis) throw new TypeError("Planning fixture hypothesis missing");
  const original = renderScript(1, hypothesis.id, videoTargetSeconds(initialJob.id, 1));
  const script = {
    ...original,
    cuts: original.cuts.map((cut) =>
      cut.source === "project_clip" ? { ...cut, source: "approved_image" as const } : cut,
    ),
  };
  const planning = fixtureVideoPlanning();
  const job = store.change(initialJob.id, (draft) => {
    draft.creativePlan = creativePlan;
    draft.videoScripts = [{ ...script, planning }];
    draft.status = "review";
    draft.automation = AutomationStateSchema.parse({
      policy: { mode: "creative", imageCount: 1, videoCount: 1 },
      status: "waiting",
      phase: "script",
      nextRunAt: null,
      nextAnalysisAt: null,
      lastError: null,
      authorizedAt: "2026-10-05T00:00:00Z",
      scopeDigest: "fixture",
      imageAttempts: 0,
      operation: null,
      stoppedAt: null,
    });
  });
  return {
    store,
    job,
    hypothesis,
    script,
    planning,
    input: {
      store,
      id: job.id,
      number: 1,
      hypothesis,
      durationSec: script.durationSec,
      signal: new AbortController().signal,
    },
    async close() {
      store.close();
      await rm(store.root, { recursive: true, force: true });
    },
  };
}
