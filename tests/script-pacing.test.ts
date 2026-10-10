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
  // 장면 계획(2026-10-06)부터 컷은 5초까지이고 Veo 컷은 클립 구간(early 3초·mid 2.5초) 안에서 읽는다.
  // 이 픽스처는 짧은 동작을 2~3초로 계획한다. 긴 동작을 위한 4~5초 컷도 허용한다:
  // 후킹은 클립 A 를 early 3초 + mid 2초 두 컷(문장 둘)으로, 나머지는 대표 이미지 3초·2초 컷 하나씩.
  const beats = [
    [[3], "hook", "뚜껑을 열고 꺼내는 손을 그대로 따라가 보세요."],
    [[2], "hook", "손끝에서 뭐가 달라지는지 바로 보이죠?"],
    [[3], "mechanism", "간편하게 바뀐 모습부터 눈으로 비교해 보세요."],
    [[3], "pain", "바쁜 아침마다 준비할 게 많아서 번거로웠죠."],
    [[3], "proof", "이어지는 동작을 끊지 않고 그대로 담았어요."],
    [[3], "proof", "매일 쓰는 물건이 놓이는 자리도 함께 보여요."],
    [[3], "proof", "익숙한 공간에서 직접 견주어 보면 차이가 커요."],
    [[3], "proof", "처음부터 끝까지 천천히 눈으로 따라와 보세요."],
    [[3], "proof", "달라진 과정이 한눈에 다 들어오죠?"],
    [[2], "proof", "작은 차이가 하루 전체를 바꿔요."],
    [[2], "cta", "우리 집에 맞을지 지금 바로 살펴보세요."],
  ] as const;
  return {
    ...base,
    payoffSec: 5,
    sentences: beats.map(([lengths, purpose, text], index) => ({
      purpose,
      chainStep: "bridge" as const,
      text,
      captionDirection: { tone: "plain", keyword: "", icon: "none" },
      callouts: [],
      actionSync: null,
      cuts: lengths.map((len) => ({
        ...cut,
        len,
        source: index <= 1 ? "veo_clip" : "approved_image",
        veoClip: index <= 1 ? "A" : "",
        phase: index === 0 ? "early" : index === 1 ? "mid" : "",
        onScreenText: "",
        effect: "hard_cut",
      })),
    })),
  };
}

test("accepts completed action shots when response cuts last two to three seconds", () => {
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
  expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual([
    3, 2, 3, 3, 3, 3, 3, 3, 3, 2, 2,
  ]);
  expect(script.cuts.map((cut) => cut.purpose)).toEqual(
    response.sentences.flatMap((s) => s.cuts.map(() => s.purpose)),
  );
  expect(script.voiceover.map((voice) => [voice.startSec, voice.endSec])).toEqual([
    [0, 3],
    [3, 5],
    [5, 8],
    [8, 11],
    [11, 14],
    [14, 17],
    [17, 20],
    [20, 23],
    [23, 26],
    [26, 28],
    [28, 30],
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

test("accepts a deliberate five-second still and proof-led structure with only repetition advice", () => {
  const response = actionResponse();
  const planned: VideoScriptResponse = {
    ...response,
    veoClips: [],
    // 대상(subjects)을 선언한 대본이라 정지 이미지 프롬프트도 대상의 외형 낱말(bottle·kitchen)을 담는다.
    // 정지 이미지 S1 은 후킹 두 컷(3초+2초=5초)을 채워 4초 넘는 정지 화면 경고만 남긴다.
    stills: [
      { id: "S1", prompt: "A product bottle detail on the kitchen table in natural light." },
    ],
    sentences: response.sentences.map((sentence, index) => ({
      ...sentence,
      purpose: "proof",
      cuts: sentence.cuts.map((cut) => ({
        ...cut,
        source: index <= 1 ? "still_image" : cut.source,
        veoClip: "",
        phase: "",
        stillId: index <= 1 ? "S1" : "",
      })),
    })),
  };
  const { script, repairs } = videoScriptFromResponse(
    VideoScriptResponseSchema.parse(planned),
    context,
  );
  const problems = classifyScriptProblems(script, expected);
  expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual([
    3, 2, 3, 3, 3, 3, 3, 3, 3, 2, 2,
  ]);
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
