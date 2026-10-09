import { expect, test } from "bun:test";
import { buildTimeline, RenderTimelineSchema, timelineDigest } from "../shared/render-timeline";
import {
  explanationLeadingSilence,
  explanationMeasurements as measurements,
  explanationTimingScript as script,
} from "./explanation-timing-fixture";

test.each([
  [130, 0, 130],
  [282, 0, 282],
  [130, 0.01, 50],
])(
  "a first-word cue with %ims measured lead and action progress %f reports %ims residual",
  (leadMs, startProgress, residualMs) => {
    // Given
    const fixture = explanationLeadingSilence(leadMs);
    const beat = fixture.script.infoClips[0]?.explanation?.beats[0];
    if (!beat) throw new Error("fixture missing");
    beat.startProgress = startProgress;
    const originalScript = structuredClone(fixture.script);
    const originalMeasurements = structuredClone(fixture.measurements);
    // When
    const result = buildTimeline(fixture.script, fixture.measurements);
    // Then
    expect("timeline" in result).toBe(true);
    if ("timeline" in result) {
      expect(result.timeline.voice[1]).toMatchObject({
        startMs: 2000,
        durationMs: 3000,
        tempo: 1,
        words: fixture.measurements[1]?.words,
      });
      expect(result.timeline.warnings).toContainEqual(expect.stringContaining(`${residualMs}ms`));
      expect(result.timeline.cuts[1]?.sourceRef).toEqual({
        kind: "veo",
        clipId: "I1",
        offsetMs: 0,
        padMs: 0,
      });
      expect(timelineDigest(RenderTimelineSchema.parse(result.timeline))).toBe(
        timelineDigest(result.timeline),
      );
    }
    expect(fixture.script).toEqual(originalScript);
    expect(fixture.measurements).toEqual(originalMeasurements);
  },
);

test("measured narration cue coincides with its visible mid-clip action", () => {
  // Given
  const fixture = script();
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    expect(result.timeline.voice[1]?.startMs).toBe(5000);
    expect(result.timeline.cuts[1]?.sourceRef).toEqual({
      kind: "veo",
      clipId: "I1",
      offsetMs: 0,
      padMs: 0,
    });
    expect(timelineDigest(RenderTimelineSchema.parse(result.timeline))).toBe(
      timelineDigest(result.timeline),
    );
  }
});

test("silence trimming preserves the entire explanation action window", () => {
  // Given
  const fixture = script();
  // When
  const result = buildTimeline(fixture, measurements(), { trimSilence: true });
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    const cut = result.timeline.cuts[1];
    expect(cut && cut.endMs - cut.startMs).toBe(8000);
    expect(result.timeline.voice[1]?.startMs).toBe((cut?.startMs ?? 0) + 3000);
  }
});

test.each(["missing", "unmeasured", "misaligned"])(
  "a %s narration cue is an explicit sync error",
  (kind) => {
    // Given
    const fixture = script();
    const measured = measurements();
    const voice = fixture.voiceover[1];
    const item = measured[1];
    if (!voice || !item) throw new Error("fixture missing");
    if (kind === "missing") voice.text = "여기 다른 내용을 보세요.";
    else
      measured[1] = {
        ...item,
        words: kind === "unmeasured" ? [] : [{ text: "틀린 단어", start: 0, end: 2 }],
      };
    // When
    const result = buildTimeline(fixture, measured);
    // Then
    expect(result).toMatchObject({ error: "action_sync", index: 1 });
  },
);

test("a previous sentence cannot push a synchronized cue away from its action", () => {
  // Given
  const fixture = script();
  fixture.voiceover[0] = {
    ...fixture.voiceover[0],
    fromCut: 0,
    toCut: 1,
    startSec: 0,
    endSec: 10,
    text: "앞 문장입니다.",
    purpose: "hook",
    chainStep: "",
    callouts: [],
  };
  const measured = measurements().map((item) =>
    item.index === 0 ? { ...item, durationMs: 5200 } : item,
  );
  // When
  const result = buildTimeline(fixture, measured);
  // Then
  expect(result).toMatchObject({ error: "action_sync", index: 1, reason: "voice_overlap" });
});

test("an action cue cannot start speech before its owned cut range", () => {
  // Given
  const fixture = script();
  const beat = fixture.infoClips[0]?.explanation?.beats[0];
  if (!beat) throw new Error("fixture missing");
  beat.startProgress = 0.05;
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect(result).toMatchObject({ error: "action_sync", index: 1, reason: "voice_before_window" });
});

test("measured leading silence cannot excuse spoken words before a later cue", () => {
  // Given
  const fixture = explanationLeadingSilence(130);
  const beat = fixture.script.infoClips[0]?.explanation?.beats[0];
  if (!beat) throw new Error("fixture missing");
  beat.narrationCue = "내부";
  beat.startProgress = 0.1125;
  // When
  const result = buildTimeline(fixture.script, fixture.measurements);
  // Then
  expect(result).toMatchObject({ error: "action_sync", index: 1, reason: "voice_before_window" });
});

test.each([
  [0, 2000, "voice_overlap"],
  [1, 8100, "voice_after_window"],
] as const)(
  "leading silence retains sentence %i duration %i guard",
  (index, durationMs, reason) => {
    // Given
    const fixture = explanationLeadingSilence(130);
    fixture.measurements = fixture.measurements.map((item) =>
      item.index === index ? { ...item, durationMs } : item,
    );
    // When
    const result = buildTimeline(fixture.script, fixture.measurements);
    // Then
    expect(result).toMatchObject({ error: "action_sync", index: 1, reason });
  },
);

test("an action partly missing from the source read is not silently scheduled", () => {
  // Given
  const fixture = script();
  const cut = fixture.cuts[1];
  if (!cut) throw new Error("fixture missing");
  cut.endSec = 7;
  cut.phase = "early";
  const ending = fixture.cuts[2];
  if (ending) ending.startSec = 7;
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect(result).toMatchObject({ error: "action_sync", index: 1, reason: "action_not_visible" });
});

test("legacy narration without actionSync retains its exact timeline digest", () => {
  // Given
  const fixture = script();
  fixture.voiceover = fixture.voiceover.map(({ actionSync: _sync, ...line }) => line);
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    expect(result.timeline.voice[1]?.startMs).toBe(2000);
    expect(timelineDigest(result.timeline)).toBe(
      "5367817ae0473354d54aeeae08ad9765a839697b41b2d9f9e49150b84e2ba21d",
    );
  }
});

test("an explanation beat may span consecutive cuts of the same source", () => {
  // Given
  const fixture = script();
  const infoCut = fixture.cuts[1];
  const line = fixture.voiceover[1];
  const ending = fixture.voiceover[2];
  if (!infoCut || !line || !ending) throw new Error("fixture missing");
  fixture.cuts.splice(
    1,
    1,
    { ...infoCut, endSec: 7, phase: "early" },
    { ...infoCut, startSec: 7, phase: "mid" },
  );
  line.toCut = 2;
  ending.fromCut = 3;
  ending.toCut = 3;
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    expect(result.timeline.voice[1]?.startMs).toBe(5000);
    expect(result.timeline.cuts[2]?.sourceRef).toMatchObject({ kind: "veo", offsetMs: 5000 });
  }
});

test("synchronization accounts for the actual nonzero source offset", () => {
  // Given
  const fixture = script();
  const infoCut = fixture.cuts[1];
  const ending = fixture.cuts[2];
  if (!infoCut || !ending) throw new Error("fixture missing");
  infoCut.endSec = 7;
  ending.startSec = 7;
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    expect(result.timeline.voice[1]?.startMs).toBe(2000);
    expect(result.timeline.cuts[1]?.sourceRef).toMatchObject({ kind: "veo", offsetMs: 3000 });
  }
});

test("a synchronized sentence exceeding its cut requests editing without a tempo retry", () => {
  // Given
  const fixture = script();
  const measured = measurements().map((item) =>
    item.index === 1 ? { ...item, durationMs: 7000 } : item,
  );
  // When
  const result = buildTimeline(fixture, measured);
  // Then
  expect(result).toMatchObject({ error: "action_sync", index: 1, reason: "voice_after_window" });
  expect("overflow" in result).toBe(false);
});

test("INFO annotations embedded in the scene do not receive a duplicate app label", () => {
  // Given
  const fixture = script();
  const intro = fixture.voiceover[0];
  const explanation = fixture.infoClips[0]?.explanation;
  const line = fixture.voiceover[1];
  if (!intro || !line || !explanation) throw new Error("fixture missing");
  explanation.annotations = [
    {
      targetId: "oil",
      beatId: "reveal",
      label: "내부 오일",
      kind: "pointer",
      motionIntent: "내부를 가리킨다",
    },
  ];
  line.callouts = [
    { word: "내부", text: "내부 오일", kind: "label", anchor: "subject", targetId: "oil" },
  ];
  intro.callouts = [
    { word: "먼저", text: "먼저 확인", kind: "label", anchor: "top", targetId: "oil" },
  ];
  // When
  const result = buildTimeline(fixture, measurements());
  // Then
  expect("timeline" in result).toBe(true);
  if ("timeline" in result) {
    expect(
      result.timeline.callouts?.map((item) => ({ text: item.text, targetId: item.targetId })),
    ).toEqual([{ text: "먼저 확인", targetId: "oil" }]);
    expect(timelineDigest(RenderTimelineSchema.parse(result.timeline))).toBe(
      timelineDigest(result.timeline),
    );
  }
});
