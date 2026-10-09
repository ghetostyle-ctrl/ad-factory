import type { VoiceMeasurement } from "../shared/render-timeline";
import { type VideoScript, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";

export function explanationTimingScript(): VideoScript {
  const base = renderScript(1, "timing", 36);
  const cut = base.cuts[0];
  const line = base.voiceover[0];
  if (!cut || !line) throw new Error("fixture missing");
  return VideoScriptSchema.parse({
    ...base,
    cuts: [
      [0, 2],
      [2, 10],
      [10, 36],
    ].map(([startSec, endSec], index) => ({
      ...cut,
      startSec,
      endSec,
      source: index === 1 ? "veo_clip" : "approved_image",
      veoClip: index === 1 ? "I1" : "",
      phase: "",
      onScreenText: "",
      effect: "hard_cut",
    })),
    voiceover: ["먼저 보세요.", "지금 내부 오일을 보세요.", "제품을 비교하세요."].map(
      (text, index) => ({
        ...line,
        text,
        fromCut: index,
        toCut: index,
        startSec: [0, 2, 10][index],
        endSec: [2, 10, 36][index],
        callouts: [],
        ...(index === 1 ? { actionSync: { clipId: "I1", beatId: "reveal" } } : {}),
      }),
    ),
    infoClips: [
      {
        id: "I1",
        stage: "mechanism",
        cleanPrompt: "A capsule",
        infoPrompt: "Reveal the oil",
        explanation: {
          id: "capsule",
          productForm: "타원형 캡슐",
          entities: [
            {
              id: "oil",
              name: "내부 오일",
              representation: "component",
              appearance: "캡슐 안의 오일",
            },
          ],
          beats: [
            {
              id: "reveal",
              targetIds: ["oil"],
              startProgress: 0.5,
              endProgress: 0.875,
              before: "완전한 캡슐",
              action: "외피를 투명하게 한다",
              after: "내부가 보인다",
              narrationCue: "내부 오일을",
              viewerTakeaway: "외피와 오일의 구분",
            },
          ],
          annotations: [],
        },
      },
    ],
  });
}

export const explanationMeasurements = (): VoiceMeasurement[] => [
  { index: 0, durationMs: 1200, tempo: 1 },
  {
    index: 1,
    durationMs: 3000,
    tempo: 1,
    words: [
      { text: "지금", start: 0, end: 0.5 },
      { text: "내부", start: 1, end: 1.4 },
      { text: "오일을", start: 1.5, end: 2 },
      { text: "보세요.", start: 2.2, end: 3 },
    ],
  },
  { index: 2, durationMs: 2000, tempo: 1 },
];

export function explanationLeadingSilence(leadMs: number) {
  const script = explanationTimingScript();
  const measurements = explanationMeasurements();
  const beat = script.infoClips[0]?.explanation?.beats[0];
  const measured = measurements[1];
  if (!beat || !measured?.words) throw new Error("fixture missing");
  beat.startProgress = 0;
  beat.narrationCue = "지금";
  measurements[1] = {
    ...measured,
    words: measured.words.map((word, index) =>
      index === 0 ? { ...word, start: leadMs / 1000 } : word,
    ),
  };
  return { script, measurements };
}
