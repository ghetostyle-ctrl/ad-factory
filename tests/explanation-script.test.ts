import { expect, test } from "bun:test";
import type { ExplanationPlan } from "../shared/explanation-plan";
import { explanationScriptProblems } from "../shared/explanation-script-rules";
import { flattenSentences } from "../shared/script-repair";
import type { VideoScript } from "../shared/video-script";
import { scriptDigestJson, VideoScriptSchema } from "../shared/video-script";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import {
  fixtureClipPlan,
  flatOf,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

const explanation: ExplanationPlan = {
  id: "contents",
  productForm: "자료의 캡슐 제형",
  entities: [
    { id: "oil", name: "내부 오일", representation: "component", appearance: "캡슐 내부의 액체" },
  ],
  beats: [
    {
      id: "reveal",
      targetIds: ["oil"],
      startProgress: 0.25,
      endProgress: 1,
      before: "닫힌 캡슐",
      action: "껍질 일부가 투명해진다",
      after: "안쪽 오일이 보인다",
      narrationCue: "오일을",
      viewerTakeaway: "껍질과 내부 오일을 구분한다",
    },
  ],
  annotations: [
    {
      targetId: "oil",
      beatId: "reveal",
      label: "내부 오일",
      kind: "pointer",
      motionIntent: "안쪽 액체를 짚는다",
    },
  ],
};

function scriptFixture(): VideoScript {
  const script = longVideoScript(1, "hypothesis", 30);
  const first = script.cuts[0];
  const line = script.voiceover[0];
  if (!first || !line) throw new Error("fixture requires first cut and voice");
  const planning = fixtureVideoPlanning();
  return {
    ...script,
    planning: {
      ...planning,
      concept: {
        ...planning.concept,
        scenePlan: [
          { scene: "내부 설명", source: "info_clip", reason: "구조를 보여준다", explanation },
        ],
      },
    },
    cuts: [
      { ...first, startSec: 0, endSec: 8, source: "veo_clip", veoClip: "I1", phase: "early" },
      ...script.cuts.slice(1),
    ],
    infoClips: [
      {
        id: "I1",
        stage: "mechanism",
        cleanPrompt: "Capsule",
        infoPrompt: "Cutaway",
        infoLines: [],
        motionPrompt: "",
        sceneType: "",
        objects: [],
        actions: [],
        emphasis: [],
        graphicOrder: ["Reveal", "Hold"],
        plan: fixtureClipPlan("I1"),
        explanation,
      },
    ],
    voiceover: [
      {
        ...line,
        fromCut: 0,
        toCut: 0,
        text: "내부 오일을 확인해요.",
        actionSync: { clipId: "I1", beatId: "reveal" },
        callouts: [
          { word: "오일을", text: "내부 오일", kind: "label", anchor: "right", targetId: "oil" },
        ],
      },
    ],
  };
}

test("concept, clip, spoken cue and label resolve to the same explanation", () => {
  const script = scriptFixture();
  expect(explanationScriptProblems(script)).toEqual([]);
});

test("a declared plan cannot disappear from production", () => {
  const script = scriptFixture();
  expect(explanationScriptProblems({ ...script, infoClips: [] }).length).toBeGreaterThan(0);
});

test("changing an entity into a schematic is detected across stages", () => {
  const script = scriptFixture();
  const changed = {
    ...explanation,
    entities: explanation.entities.map((entity) => ({
      ...entity,
      representation: "schematic" as const,
    })),
  };
  const result = explanationScriptProblems({
    ...script,
    infoClips: script.infoClips.map((clip) => ({ ...clip, explanation: changed })),
  });
  expect(result.length).toBeGreaterThan(0);
});

test("spoken cue removal and detached labels cannot pass structural review", () => {
  const script = scriptFixture();
  const result = explanationScriptProblems({
    ...script,
    voiceover: script.voiceover.map((voice) => ({
      ...voice,
      text: "다른 장면이에요.",
      callouts: voice.callouts.map((callout) => ({ ...callout, targetId: "missing" })),
    })),
  });
  expect(result).toHaveLength(2);
});

test("explanation actions require a narration binding", () => {
  const script = scriptFixture();
  const result = explanationScriptProblems({
    ...script,
    voiceover: script.voiceover.map(({ actionSync: _sync, ...voice }) => voice),
  });
  expect(result).toHaveLength(1);
});

test("new response fields survive conversion while absent legacy fields retain their digest", () => {
  const legacy = VideoScriptSchema.parse(longVideoScript(1, "hypothesis", 30));
  const response = nestedScriptResponse(flatOf(legacy));
  const first = response.sentences[0];
  if (!first) throw new Error("fixture requires a sentence");
  response.sentences[0] = { ...first, actionSync: { clipId: "I1", beatId: "reveal" } };
  const flat = flattenSentences(response, { number: 1, hypothesisId: "hypothesis", targetSec: 30 });
  expect(flat.voiceover[0]?.actionSync).toEqual({ clipId: "I1", beatId: "reveal" });
  expect(scriptDigestJson(VideoScriptSchema.parse(legacy))).toBe(scriptDigestJson(legacy));
  expect(explanationScriptProblems(legacy)).toEqual([]);
});
