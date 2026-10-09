import { expect, test } from "bun:test";
import { HypothesisSchema } from "../shared/creative-plan";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import { SentenceResponseSchema, type VideoScriptResponse } from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import {
  fixtureSentence,
  flatOf,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const context = { number: 1, hypothesisId: hypothesis.id, targetSec: 30 };
const expected = { number: 1, durationSec: 30, hypothesis };

function scenicResponse(chars = 26): VideoScriptResponse {
  const base = nestedScriptResponse(flatOf(longVideoScript(1, hypothesis.id, 30)));
  const cut = base.sentences[0]?.cuts[0];
  if (!cut) throw new Error("fixture cut missing");
  return {
    ...base,
    subjects: [],
    veoClips: [],
    stills: [],
    infoClips: [],
    sentences: Array.from({ length: 6 }, (_, index) => ({
      purpose: "proof",
      chainStep: "bridge",
      text: fixtureSentence(index, chars),
      callouts: [],
      actionSync: null,
      cuts: [
        {
          ...cut,
          len: 5,
          source: "approved_image",
          veoClip: "",
          phase: "",
          onScreenText: "",
          effect: "hard_cut",
        },
      ],
    })),
  };
}

test.each([24, 26])(
  "allows a %i-character breath over a five-second scene without pacing warnings",
  (chars) => {
    // Given
    const { script, repairs } = videoScriptFromResponse(scenicResponse(chars), context);
    // When
    const problems = classifyScriptProblems(script, expected);
    // Then
    expect(problems).toEqual({ hard: [], soft: [] });
    expect(repairs).toEqual([]);
    expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual([5, 5, 5, 5, 5, 5]);
  },
);

test("warns when short speech leaves most of every scenic shot empty", () => {
  // Given
  const { script } = videoScriptFromResponse(scenicResponse(10), context);
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toEqual([]);

  expect(problems.soft).toContainEqual(expect.stringContaining("1번째 문장"));
});

test.each([
  // 2026-10-08: 한 호흡 목표 26자 → 34자(카피 먼저 흐름). 경계는 목표+1.
  [34, false, false],
  [35, false, true],
  [40, false, true],
  [41, true, false],
])("classifies %i-character copy at the rhythm boundary", (chars, hard, soft) => {
  // Given
  const { script } = videoScriptFromResponse(scenicResponse(chars), context);
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((problem) => problem.includes("한 호흡"))).toBe(hard);
  expect(problems.soft.some((problem) => problem.includes("호흡이 깁니다"))).toBe(soft);
});

test("warns about explanatory tails even when a sentence fits the short breath target", () => {
  // Given
  const response = scenicResponse();
  const first = response.sentences[0];
  if (!first) throw new Error("fixture sentence missing");
  first.text = "매일 간단하게 섭취할 수 있어요.";
  const { script } = videoScriptFromResponse(response, context);
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard).toEqual([]);
  expect(problems.soft).toContainEqual(expect.stringContaining("설명 꼬리"));
});

test.each([
  [60, true],
  [61, false],
])("uses a recoverable response boundary at %i characters", (chars, accepted) => {
  // Given
  const text = fixtureSentence(0, chars);
  // When
  const result = SentenceResponseSchema.shape.text.safeParse(text);
  // Then
  expect(result.success).toBe(accepted);
});

test("natural copy keeps a coherent thirty-three-character thought without a split warning", () => {
  // Given
  const original = videoScriptFromResponse(scenicResponse(35), context).script; // 목표 34자 + 1(2026-10-08)
  const script = {
    ...original,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" as const },
  };
  // When
  const legacy = classifyScriptProblems(original, expected);
  const natural = classifyScriptProblems(script, expected);
  // Then
  expect(legacy.soft.some((problem) => problem.includes("호흡이 깁니다"))).toBe(true);
  expect(natural.soft.some((problem) => problem.includes("호흡이 깁니다"))).toBe(false);
});
