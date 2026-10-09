import { expect, test } from "bun:test";
import { clipNeedMsFromScript, clipNeedMsFromTimeline } from "../server/render/clip-need";
import { buildTimeline, type RenderTimeline } from "../shared/render-timeline";
import { classifyScriptProblems } from "../shared/script-rules";
import { InfoClipSchema, type VideoScript } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { fixtureClipPlan } from "./video-script-fixture";

function example(): VideoScript {
  const base = renderScript(1, "concept-1", 32);
  const ends = [3, 6, 9, 12, 15, 18, 22, 25, 28, 30.5, 32];
  return {
    ...base,
    cuts: ends.map((endSec, index) => {
      const cut = base.cuts[index];
      if (!cut) throw new Error("fixture cut missing");
      return {
        ...cut,
        startSec: ends[index - 1] ?? 0,
        endSec,
        source: "motion_graphic",
        veoClip: "",
        phase: "",
      };
    }),
    voiceover: ends.slice(0, 10).map((_, index) => {
      const line = base.voiceover[index];
      if (!line) throw new Error("fixture voice missing");
      return { ...line, fromCut: index, toCut: index === 9 ? 10 : index };
    }),
  };
}
function timeline(result: ReturnType<typeof buildTimeline>): RenderTimeline {
  if (!("timeline" in result)) throw new Error(JSON.stringify(result));
  return result.timeline;
}

test("natural timing holds each explanation scene until its measured narration finishes", () => {
  // Given: durations from the Astra test that changed graphics before the sentence ended.
  const script = example();
  const measured = [2840, 2577, 2840, 3538, 2910, 2500, 2950, 2750, 3375, 3450].map(
    (durationMs, index) => ({ index, durationMs, tempo: 1, attempt: 2 }),
  );
  // When
  const actual = timeline(
    buildTimeline(script, measured, { trimSilence: true, naturalTiming: true }),
  );
  // Then
  for (const voice of actual.voice) {
    const line = script.voiceover[voice.index];
    if (!line) throw new Error("fixture line missing");
    expect(actual.cuts[line.toCut]?.endMs ?? 0).toBeGreaterThanOrEqual(
      voice.startMs + voice.durationMs,
    );
    expect(voice.tempo).toBe(1);
  }
  expect(actual.durationMs).toBeLessThanOrEqual(60_000);
});

test("natural timing grows beyond the short target instead of requesting faster speech", () => {
  // Given
  const script = example();
  const measured = script.voiceover.map((_, index) => ({ index, durationMs: 4200, tempo: 1 }));
  // When
  const actual = timeline(
    buildTimeline(script, measured, { trimSilence: true, naturalTiming: true }),
  );
  // Then
  expect(actual.durationMs).toBeGreaterThan(35_000);
  expect(actual.extendedMs).toBeGreaterThan(3000);
  expect(actual.durationMs).toBeLessThanOrEqual(60_000);
  expect(actual.voice.every((line) => line.tempo === 1)).toBe(true);
});

test("natural timing requests a script change rather than squeezing a narration past sixty seconds", () => {
  // Given
  const script = example();
  const measured = script.voiceover.map((_, index) => ({ index, durationMs: 6200, tempo: 1 }));
  // When
  const result = buildTimeline(script, measured, { naturalTiming: true });
  // Then
  expect(result).toMatchObject({ error: "too_long" });
});

test("natural timing refuses to freeze a Veo clip when a sentence needs more than eight seconds", () => {
  // Given
  const base = example();
  const script: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === 0 ? { ...cut, source: "veo_clip", veoClip: "A" } : cut,
    ),
  };
  const measured = script.voiceover.map((_, index) => ({
    index,
    durationMs: index === 0 ? 8500 : 1000,
    tempo: 1,
  }));
  // When
  const result = buildTimeline(script, measured, { naturalTiming: true });
  // Then
  expect(result).toEqual({ error: "clip_too_short", index: 0, clipId: "A" });
});

test("natural timing refuses repeated source frames when an extended phased clip would rewind", () => {
  // Given
  const base = example();
  const script: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index < 2
        ? {
            ...cut,
            source: "veo_clip",
            veoClip: "A",
            phase: index === 0 ? "early" : "late",
          }
        : cut,
    ),
  };
  const measured = script.voiceover.map((_, index) => ({
    index,
    durationMs: index < 2 ? 4500 : 1000,
    tempo: 1,
  }));
  // When
  const result = buildTimeline(script, measured, { naturalTiming: true });
  // Then
  expect(result).toEqual({ error: "clip_too_short", index: 1, clipId: "A" });
});

test("natural timing preserves the full planned INFO action from the first frame despite short speech", () => {
  // Given: one six-second reveal, then normal scenes, with short narration.
  const base = example();
  const script: VideoScript = {
    ...base,
    durationSec: base.durationSec + 3,
    cuts: base.cuts.map((cut, index) =>
      index === 0
        ? {
            ...cut,
            endSec: 6,
            source: "veo_clip",
            veoClip: "I1",
          }
        : { ...cut, startSec: cut.startSec + 3, endSec: cut.endSec + 3 },
    ),
  };
  const measured = script.voiceover.map((_, index) => ({ index, durationMs: 1000, tempo: 1 }));
  // When
  const actual = timeline(
    buildTimeline(script, measured, { trimSilence: true, naturalTiming: true }),
  );
  // Then: the reveal is neither shortened to the speech nor read only from its end.
  expect(actual.cuts[0]?.endMs).toBe(6000);
  expect(actual.cuts[0]?.sourceRef).toEqual({ kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 });
});

test("silence trimming ends a six-second live Veo cut 300ms after its 3.6-second narration even under the immersive policy", () => {
  // Given: 실사 컷(A)이 6초인데 말은 3.6초. 예전 immersive 면제(584c972, 모든 veo 컷 보존)는 사용자 결정(2026-10-07 H6)으로 풀었다.
  const base = example();
  const script: VideoScript = {
    ...base,
    durationSec: base.durationSec + 3,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    cuts: base.cuts.map((cut, index) =>
      index === 0
        ? { ...cut, endSec: 6, source: "veo_clip", veoClip: "A" }
        : { ...cut, startSec: cut.startSec + 3, endSec: cut.endSec + 3 },
    ),
  };
  const measured = script.voiceover.map((_, index) => ({
    index,
    durationMs: index === 0 ? 3600 : 1000,
    tempo: 1,
  }));
  // When
  const actual = timeline(
    buildTimeline(script, measured, { trimSilence: true, naturalTiming: true }),
  );
  // Then: 실사 컷은 다른 컷과 같이 말 끝 + 0.3초에서 넘기고, 뒤의 말 없는 그래픽 시간도 줄어든다.
  expect(actual.cuts[0]?.endMs).toBe(3900);
  expect(actual.cuts[0]?.sourceRef).toEqual({ kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 });
  expect(actual.voice[1]?.startMs).toBe(3900);
  expect(actual.durationMs).toBeLessThan(script.durationSec * 1000);
});

test("natural timing keeps early middle and late INFO actions when one explanation uses three cuts", () => {
  // Given
  const base = example();
  const cuts = base.cuts.map((cut, index) => {
    if (index >= 3) return { ...cut, startSec: cut.startSec - 1, endSec: cut.endSec - 1 };
    const phases = ["early", "mid", "late"] as const;
    const starts = [0, 3, 6];
    const ends = [3, 6, 8];
    return {
      ...cut,
      startSec: starts[index] ?? 0,
      endSec: ends[index] ?? 0,
      source: "veo_clip" as const,
      veoClip: "I1" as const,
      phase: phases[index] ?? "early",
    };
  });
  const script: VideoScript = { ...base, durationSec: 31, cuts };
  const measured = script.voiceover.map((_, index) => ({ index, durationMs: 1000, tempo: 1 }));
  // When
  const actual = timeline(
    buildTimeline(script, measured, { trimSilence: true, naturalTiming: true }),
  );
  // Then
  expect(actual.cuts.slice(0, 3).map((cut) => cut.endMs - cut.startMs)).toEqual([3000, 3000, 2000]);
  expect(actual.cuts.slice(0, 3).map((cut) => cut.sourceRef)).toEqual([
    { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
    { kind: "veo", clipId: "I1", offsetMs: 3000, padMs: 0 },
    { kind: "veo", clipId: "I1", offsetMs: 6000, padMs: 0 },
  ]);
});

test("new INFO upload validation and rendered timeline require the same source frames", () => {
  // Given
  const base = example();
  const script: VideoScript = {
    ...base,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    cuts: base.cuts.map((cut, index) =>
      index === 0 ? { ...cut, source: "veo_clip", veoClip: "I1", effect: "hard_cut" } : cut,
    ),
  };
  const measured = script.voiceover.map((_, index) => ({ index, durationMs: 1000, tempo: 1 }));
  // When
  const actual = timeline(
    buildTimeline(script, measured, { naturalTiming: true, trimSilence: true }),
  );
  // Then
  expect(clipNeedMsFromScript(script, "I1")).toBe(3000);
  expect(clipNeedMsFromTimeline(actual.cuts, "I1")).toBe(3000);
});

test("approval rules reject a seven-second INFO schedule whose phase offsets reuse paid clip frames", () => {
  // Given: the individual reads look valid, but mid consumes 3–7s and late rewinds to 6–8s.
  const base = example();
  const phases = ["early", "mid", "late"] as const;
  const starts = [0, 1, 5];
  const ends = [1, 5, 7];
  const script: VideoScript = {
    ...base,
    durationSec: 30,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    veoClips: [],
    voiceover: base.voiceover.map((voice) => ({ ...voice, purpose: "story", chainStep: "bridge" })),
    infoClips: [
      InfoClipSchema.parse({
        id: "I1",
        stage: "mechanism",
        cleanPrompt: "Capsule cutaway",
        infoPrompt: "Oil volume",
        graphicOrder: ["Separate shell", "Show oil"],
        plan: fixtureClipPlan("I1"),
      }),
    ],
    cuts: base.cuts.map((cut, index) =>
      index < 3
        ? {
            ...cut,
            source: "veo_clip",
            veoClip: "I1",
            phase: phases[index] ?? "early",
            startSec: starts[index] ?? 0,
            endSec: ends[index] ?? 0,
          }
        : { ...cut, startSec: cut.startSec - 2, endSec: cut.endSec - 2 },
    ),
  };
  // When: the same structural gate used before script approval and paid production.
  const hypothesis = sourcePlanResponse("fact-1").hypotheses[0];
  if (!hypothesis) throw new Error("fixture hypothesis missing");
  const expected = { number: 1, durationSec: 30, hypothesis, infoClipsAllowed: true };
  const current = classifyScriptProblems(script, expected);
  const legacy = classifyScriptProblems({ ...script, planning: fixtureVideoPlanning() }, expected);
  // Then: the new policy must reject the conflicting clip before synthesizing narration.
  const added = current.hard.filter((problem) => !legacy.hard.includes(problem));
  expect(added).toHaveLength(1);
});
