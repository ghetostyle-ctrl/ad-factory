import { afterEach, beforeEach, expect, test } from "bun:test";
import { scopeDigest } from "../server/automation-guard";
import { VoiceProduction } from "../server/voice-production";
import { RenderTimelineSchema } from "../shared/render-timeline";
import { explanationMeasurements, explanationTimingScript } from "./explanation-timing-fixture";
import { sineWav } from "./render-fixture";
import { planningPipelineFixture } from "./video-planning-pipeline-fixture";

let fixture: ReturnType<typeof planningPipelineFixture>;
beforeEach(() => {
  fixture = planningPipelineFixture();
});
afterEach(async () => {
  await fixture.close();
});

function voiceFixture(measuredWords: boolean) {
  const job = fixture.job;
  const script = explanationTimingScript();
  const measurements = explanationMeasurements();
  fixture.store.change(job.id, (draft) => {
    draft.videoScripts = [script];
    if (!draft.executionModels) throw new Error("fixture models missing");
    draft.executionModels = { ...draft.executionModels, ttsTempo: 1 };
    const state = draft.automation;
    if (state?.policy.mode !== "creative") throw new Error("fixture automation missing");
    state.policy.scriptApproval = "auto";
    state.scopeDigest = scopeDigest(draft, state.policy);
  });
  const calls: number[] = [];
  const production = new VoiceProduction(fixture.store, async (task) => {
    calls.push(task.tempo);
    const index = script.voiceover.findIndex((line) => line.text === task.text);
    const item = measurements[index];
    if (!item) throw new Error("fixture measurement missing");
    return {
      model: {
        provider: "typecast",
        requestedModel: "fixture",
        effectiveModel: "fixture",
        quality: null,
      },
      value: {
        audio: sineWav(item.durationMs),
        durationMs: item.durationMs,
        words: measuredWords ? [...(item.words ?? [])] : [],
      },
    };
  });
  return { id: job.id, production, calls };
}

test("voice production persists action-aligned narration and reuses it without synthesis", async () => {
  // Given
  const { id, production, calls } = voiceFixture(true);
  // When
  await production.run(id, 1, new AbortController().signal);
  await production.run(id, 1, new AbortController().signal);
  const timeline = RenderTimelineSchema.parse(
    await (await production.assets.read(id, "timeline-1.json")).json(),
  );
  // Then
  expect(timeline.voice[1]?.startMs).toBe(4500);
  expect(timeline.cuts[1]?.endMs).toBe(9500);
  expect(calls).toEqual([1, 1, 1]);
  expect(fixture.store.get(id).renders[0]?.voice?.timelineDigest).toBeTruthy();
});

test("an unmeasured cue returns a repairable sync error without paid tempo retries", async () => {
  // Given
  const { id, production, calls } = voiceFixture(false);
  // When
  const run = production.run(id, 1, new AbortController().signal);
  // Then
  await expect(run).rejects.toMatchObject({ code: "action_sync" });
  expect(calls).toEqual([1, 1, 1]);
  expect(fixture.store.get(id).artifacts.some((item) => item.name === "voice-1.json")).toBe(true);
  expect(fixture.store.get(id).artifacts.some((item) => item.name === "timeline-1.json")).toBe(
    false,
  );
});
