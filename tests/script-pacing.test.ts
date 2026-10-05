import { expect, test } from "bun:test";
import { HypothesisSchema } from "../shared/creative-plan";
import {
  flattenSentences,
  repairFlat,
  splitSlowCuts,
  videoScriptFromResponse,
} from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import {
  type VideoScriptResponse,
  VideoScriptResponseSchema,
  VideoScriptSchema,
  videoScriptFromFlat,
} from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import { flatOf, longVideoScript, nestedScriptResponse } from "./video-script-fixture";

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const context = { number: 1, hypothesisId: hypothesis.id, targetSec: 30, hasCardSlides: false };
const expected = { number: 1, durationSec: 30, hypothesis };

function actionResponse(): VideoScriptResponse {
  const base = nestedScriptResponse(flatOf(longVideoScript(1, hypothesis.id, 30)));
  const cut = base.sentences[0]?.cuts[0];
  if (!cut) throw new Error("fixture cut missing");
  const beats = [
    [
      7,
      "hook",
      "뚜껑을 열고 내용물을 꺼내는 손을 따라가 보세요. 손끝에서 제품이 어떻게 달라지는지 바로 확인할 수 있어요.",
    ],
    [5, "mechanism", "간편하게 바뀐 모습을 먼저 보여드릴게요. 작은 차이를 눈으로 확인해 보세요."],
    [5, "pain", "바쁜 아침에는 준비할 일이 많아서 번거로웠죠. 이제 달라진 과정을 살펴보세요."],
    [5, "proof", "눈앞에서 이어지는 동작을 그대로 담았어요. 처음부터 끝까지 천천히 살펴보세요."],
    [5, "proof", "매일 쓰는 물건이 놓이는 자리를 보여드릴게요. 익숙한 공간에서 직접 비교해요."],
    [3, "cta", "우리 집에서 편하게 쓸 수 있을지 자세한 내용을 확인해 보세요."],
  ] as const;
  return {
    ...base,
    payoffSec: 5,
    sentences: beats.map(([len, purpose, text], index) => ({
      purpose,
      text,
      cuts: [
        {
          ...cut,
          len,
          source: index === 0 ? "veo_clip" : "approved_image",
          veoClip: index === 0 ? "A" : "",
          onScreenText: "",
          effect: "hard_cut",
        },
      ],
    })),
  };
}

test("accepts completed action shots when response cuts last five to seven seconds", () => {
  // Given
  const response = actionResponse();
  // When
  const parsed = VideoScriptResponseSchema.safeParse(response);
  // Then
  expect(parsed.success).toBe(true);
});

test("preserves shots, speech timing and an early answer when converting an action-led response", () => {
  // Given
  const response = actionResponse();
  // When
  const { script, repairs } = videoScriptFromResponse(response, context);
  // Then
  expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual([7, 5, 5, 5, 5, 3]);
  expect(script.cuts.map((cut) => cut.purpose)).toEqual(response.sentences.map((s) => s.purpose));
  expect(script.voiceover.map((voice) => [voice.startSec, voice.endSec])).toEqual([
    [0, 7],
    [7, 12],
    [12, 17],
    [17, 22],
    [22, 27],
    [27, 30],
  ]);
  expect(script.payoffSec).toBe(5);
  expect(repairs).toEqual([]);
});

test("does not demand faster cuts, middle rehooks or fixed story order when action shots are valid", () => {
  // Given
  const { script } = videoScriptFromResponse(actionResponse(), context);
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems).toEqual({ hard: [], soft: [] });
});

test("accepts a deliberate seven-second still and proof-led structure with only repetition advice", () => {
  const response = actionResponse();
  const planned: VideoScriptResponse = {
    ...response,
    veoClips: [],
    stills: [{ id: "S1", prompt: "A product detail in natural light." }],
    sentences: response.sentences.map((sentence, index) => ({
      ...sentence,
      purpose: "proof",
      cuts: sentence.cuts.map((cut) => ({
        ...cut,
        source: index === 0 ? "still_image" : cut.source,
        veoClip: "",
        stillId: index === 0 ? "S1" : "",
      })),
    })),
  };
  const { script, repairs } = videoScriptFromResponse(
    VideoScriptResponseSchema.parse(planned),
    context,
  );
  const problems = classifyScriptProblems(script, expected);
  expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual([7, 5, 5, 5, 5, 3]);
  expect(script.cuts.every((cut) => cut.purpose === "proof")).toBe(true);
  expect(repairs).toEqual([]);
  expect(problems.hard).toEqual([]);
  expect(problems.soft).toEqual([expect.stringContaining("정지 이미지 S1")]);
});

test("retains existing cuts and voice ranges when the legacy split entrypoint receives a long shot", () => {
  // Given
  const script = videoScriptFromFlat(flattenSentences(actionResponse(), context));
  // When
  const result = splitSlowCuts(script);
  // Then
  expect(result).toEqual(script);
});

test("preserves planned effects and early payoff when repairing only mechanical fields", () => {
  // Given
  const flat = flatOf(longVideoScript(1, hypothesis.id, 30));
  const planned = {
    ...flat,
    payoffSec: 5,
    cuts: flat.cuts.map((cut) => ({ ...cut, effect: "zoom_punch" as const })),
  };
  // When
  const repaired = repairFlat(planned);
  // Then
  expect(repaired.value).toEqual(planned);
  expect(repaired.repairs).toEqual([]);
});

test("keeps source exhaustion hard when a single action exceeds its eight-second Veo source", () => {
  // Given
  const response = actionResponse();
  const first = response.sentences[0]?.cuts[0];
  if (!first) throw new Error("fixture action missing");
  first.len = 9;
  const { script } = videoScriptFromResponse(response, context);
  // When
  const problems = classifyScriptProblems(script, { ...expected, durationSec: 32 });
  // Then
  expect(problems.hard).toContainEqual(expect.stringContaining("한 클립은 8초뿐"));
});

test("reads legacy stored scripts when their optional narration and source fields are absent", () => {
  // Given
  const {
    voiceover: _voiceover,
    stills: _stills,
    ...legacy
  } = longVideoScript(1, hypothesis.id, 30);
  // When
  const parsed = VideoScriptSchema.parse(legacy);
  // Then
  expect(parsed.voiceover).toEqual([]);
  expect(parsed.stills).toEqual([]);
  expect(parsed.cuts).toEqual(legacy.cuts);
});

test("allows an answer at the final visible second when fractional duration needs a technical clamp", () => {
  // Given
  const flat = {
    ...flatOf(longVideoScript(1, hypothesis.id, 30)),
    durationSec: 29.5,
    payoffSec: 60,
  };
  const finalCut = flat.cuts.at(-1);
  if (!finalCut) throw new Error("fixture final cut missing");
  finalCut.endSec = 29.5;
  // When
  const repaired = repairFlat(flat);
  // Then
  expect(repaired.value.payoffSec).toBe(29);
  expect(VideoScriptSchema.safeParse(videoScriptFromFlat(repaired.value)).success).toBe(true);
});
