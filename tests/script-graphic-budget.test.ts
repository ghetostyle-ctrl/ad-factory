import { expect, test } from "bun:test";
import { HypothesisSchema } from "../shared/creative-plan";
import type { ExplanationPlan } from "../shared/explanation-plan";
import { classifyScriptProblems } from "../shared/script-rules";
import { type VideoScript, VideoScriptSchema } from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { fixtureClipPlan, longVideoScript } from "./video-script-fixture";

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const expected = { number: 1, durationSec: 44, hypothesis, infoClipsAllowed: true };

function illustratedScript(): VideoScript {
  const base = longVideoScript(1, hypothesis.id, 44);
  const planning = fixtureVideoPlanning();
  const infoClips = (["I1", "I2"] as const).map((id) => {
    const explanation: ExplanationPlan = {
      id: `contents-${id.toLowerCase()}`,
      productForm: "자료의 캡슐 제형",
      entities: [
        { id: "oil", name: "내부 오일", representation: "component", appearance: "안쪽 액체" },
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
      annotations: [],
    };
    return {
      id,
      stage: "mechanism",
      cleanPrompt: "Capsule",
      infoPrompt: "Cutaway",
      infoLines: [],
      motionPrompt: "",
      graphicOrder: ["Reveal", "Hold"],
      plan: fixtureClipPlan(id),
      explanation,
    };
  });
  let next = 0;
  const cuts = [4, 4, 8, 8, 4, 4, 4, 4, 4].map((seconds, index) => {
    const clip = infoClips[index - 2];
    const startSec = next;
    next += seconds;
    return {
      startSec,
      endSec: next,
      purpose: clip ? "mechanism" : index === 0 ? "hook" : index === 8 ? "cta" : "proof",
      screenComposition: clip ? "캡슐 내부 구조" : "제품과 안내 문구",
      onScreenText: "",
      narration:
        [
          "매번 고르는 기준이 다르셨나요?",
          "오늘은 캡슐의 안쪽을 살펴봐요.",
          "투명한 껍질 속 오일을 구분해요.",
          "가운데 담긴 오일을 가까이서 봐요.",
          "내 생활에 맞는 선택이 필요하죠.",
          "제품을 고를 때 성분도 읽어보세요.",
          "하루 루틴에 간편하게 더해봐요.",
          "필요한 내용을 한눈에 모았어요.",
          "지금 나에게 맞는 구성을 골라보세요.",
        ][index] ?? "",
      source: clip ? "veo_clip" : "motion_graphic",
      veoClip: clip?.id ?? "",
      phase: clip ? "early" : "",
      graphicKind: clip ? "" : "callout",
      graphicLines: clip ? [] : ["내 생활에 맞는 선택"],
      effect: "hard_cut",
    };
  });
  return VideoScriptSchema.parse({
    ...base,
    planning: {
      ...planning,
      durationSec: 44,
      visualPolicy: "immersive_explanations_v1",
      concept: {
        ...planning.concept,
        scenePlan: infoClips.map((clip) => ({
          scene: "내부 설명",
          source: "info_clip",
          reason: "구조를 보여준다",
          explanation: clip.explanation,
        })),
      },
    },
    subjects: [],
    veoClips: [],
    infoClips,
    cuts,
    voiceover: cuts.map((cut, index) => ({
      startSec: cut.startSec,
      endSec: cut.endSec,
      fromCut: index,
      toCut: index,
      purpose: cut.purpose,
      text: cut.narration,
      ...(cut.veoClip ? { actionSync: { clipId: cut.veoClip, beatId: "reveal" } } : {}),
    })),
  });
}

test("accepts 28 seconds of graphic bookends with 16 seconds of structured immersive explanation", () => {
  // Given
  const script = illustratedScript();
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toEqual([]);
});

test("keeps the motion graphic quota for the same illustrated script without the immersive policy", () => {
  // Given
  const { planning: _planning, ...script } = illustratedScript();
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toContainEqual(expect.stringContaining("모션그래픽이 28초"));
});

test("keeps the quota when immersive INFO clips have no structured explanation", () => {
  // Given
  const script = illustratedScript();
  script.infoClips = script.infoClips.map(({ explanation: _explanation, ...clip }) => clip);
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toContainEqual(expect.stringContaining("모션그래픽이 28초"));
});

test("keeps the quota when structured INFO clips are declared but unused", () => {
  // Given
  const script = illustratedScript();
  script.cuts = script.cuts.map((cut) =>
    cut.source === "veo_clip" ? { ...cut, source: "approved_image", veoClip: "", phase: "" } : cut,
  );
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toContainEqual(expect.stringContaining("모션그래픽이 28초"));
});
