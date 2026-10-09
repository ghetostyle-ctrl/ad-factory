import { expect, test } from "bun:test";
import { buildTimeline, silenceTrim, type VoiceMeasurement } from "../shared/render-timeline";
import { explanationTimingScript } from "./explanation-timing-fixture";

function synchronizedExplanationWithTrailingGraphic() {
  const script = explanationTimingScript();
  const cut = script.cuts[0];
  const line = script.voiceover[0];
  const explanation = script.infoClips[0]?.explanation;
  const beat = explanation?.beats[0];
  if (!cut || !line || !explanation || !beat) throw new Error("fixture missing");
  script.durationSec = 40;
  script.cuts = [
    { ...cut, startSec: 0, endSec: 2 },
    { ...cut, startSec: 2, endSec: 6.4, source: "veo_clip", veoClip: "I1", phase: "early" },
    { ...cut, startSec: 6.4, endSec: 10, source: "veo_clip", veoClip: "I1", phase: "mid" },
    { ...cut, startSec: 10, endSec: 14, source: "motion_graphic" },
    { ...cut, startSec: 14, endSec: 40 },
  ];
  script.voiceover = [
    { ...line, text: "먼저 보세요.", fromCut: 0, toCut: 0 },
    {
      ...line,
      text: "지금 내부 오일을 보세요.",
      fromCut: 1,
      toCut: 1,
      actionSync: { clipId: "I1", beatId: "reveal" },
    },
    {
      ...line,
      text: "다음 원재료 표시를 확인해 보세요.",
      fromCut: 2,
      toCut: 3,
      actionSync: { clipId: "I1", beatId: "compare" },
    },
    { ...line, text: "제품을 비교하세요.", fromCut: 4, toCut: 4 },
  ];
  explanation.beats = [
    { ...beat, startProgress: 0, endProgress: 0.55, narrationCue: "지금" },
    {
      ...beat,
      id: "compare",
      startProgress: 0.55,
      endProgress: 1,
      narrationCue: "다음",
    },
  ];
  const measurements: VoiceMeasurement[] = script.voiceover.map((voice, index) => ({
    index,
    durationMs: [1200, 3950, 4400, 2000][index] ?? 0,
    tempo: 1,
    words: [{ text: voice.text, start: 0, end: 1 }],
  }));
  return { script, measurements };
}

test("an action-synced sentence trims trailing graphic silence while retaining both source beats", () => {
  // Given: the second explanation sentence spans a 3.6-second action and a 4-second graphic.
  const { script, measurements } = synchronizedExplanationWithTrailingGraphic();
  // When
  const result = buildTimeline(script, measurements, { trimSilence: true, naturalTiming: true });
  // Then: the original 3.2-second gap is reduced to the normal 300 ms tail.
  if (!("timeline" in result)) throw new Error(JSON.stringify(result));
  const voice = result.timeline.voice[2];
  const next = result.timeline.voice[3];
  if (!voice || !next) throw new Error("timeline voice missing");
  expect(next.startMs - voice.startMs - voice.durationMs).toBe(300);
  const clips = result.timeline.cuts.filter((item) => item.source === "veo_clip");
  expect(clips.map((item) => item.endMs - item.startMs)).toEqual([4400, 3600]);
  expect(clips.map((item) => item.sourceRef)).toEqual([
    { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
    { kind: "veo", clipId: "I1", offsetMs: 4400, padMs: 0 },
  ]);
  expect(result.timeline.voice[1]?.startMs).toBe(clips[0]?.startMs);
  const secondClip = clips[1];
  if (!secondClip) throw new Error("second clip missing");
  expect(voice.startMs).toBe(secondClip.startMs);
});

test("cuts preceding a synchronized action and all of its source reads remain protected", () => {
  // Given: narration owns a leading non-video cut, the two source beats, and a trailing graphic.
  const { script } = synchronizedExplanationWithTrailingGraphic();
  const sync = script.voiceover[2];
  if (!sync) throw new Error("fixture missing");
  script.voiceover = [{ ...sync, fromCut: 0, toCut: 3 }];
  // When
  const trim = silenceTrim(
    script,
    new Map([[0, { durationMs: 1000, words: [{ text: sync.text, start: 0, end: 1 }] }]]),
    150,
    300,
    true,
  );
  // Then: only trailing non-action slack may be removed.
  expect(trim).toEqual([0, 0, 0, 3000, 0]);
});

test("trailing graphic trimming includes a narration start delayed by its action cue", () => {
  // Given: the second narration starts 1.6 seconds after its owned cut starts.
  const { script, measurements } = synchronizedExplanationWithTrailingGraphic();
  const beat = script.infoClips[0]?.explanation?.beats[1];
  if (!beat) throw new Error("fixture missing");
  beat.startProgress = 0.75;
  // When
  const result = buildTimeline(script, measurements, { trimSilence: true, naturalTiming: true });
  // Then: trimming retains the delayed speech, and the next line keeps its 300 ms tail.
  if (!("timeline" in result)) throw new Error(JSON.stringify(result));
  const voice = result.timeline.voice[2];
  const next = result.timeline.voice[3];
  const actionCut = result.timeline.cuts[2];
  if (!voice || !next || !actionCut) throw new Error("timeline item missing");
  expect(voice.startMs - actionCut.startMs).toBe(1600);
  expect(next.startMs - voice.startMs - voice.durationMs).toBe(300);
  expect(actionCut.sourceRef).toEqual({ kind: "veo", clipId: "I1", offsetMs: 4400, padMs: 0 });
});
