import { expect, test } from "bun:test";
import { verifyLongVideoScript, verifyVideoScript } from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import { type VideoScript, VideoScriptSchema, videoTargetSeconds } from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import { longVideoScript } from "./video-script-fixture";

const script = VideoScriptSchema.parse({
  number: 1,
  hypothesisId: "concept-1",
  title: "상품 사용 장면",
  durationSec: 8,
  cuts: [
    {
      startSec: 0,
      endSec: 3,
      purpose: "hook",
      screenComposition: "첫 화면",
      onScreenText: "후킹",
      narration: "",
      source: "approved_image",
    },
    {
      startSec: 3,
      endSec: 8,
      purpose: "cta",
      screenComposition: "마지막 화면",
      onScreenText: "자세히 보기",
      narration: "자세히 확인해 보세요",
      source: "veo_clip",
    },
  ],
  flowPrompt: "Animate the approved product image in portrait format.",
  editInstructions: "컷별 자막을 시간에 맞게 배치한다.",
});

test("video script accepts only the linked concept and continuous eight-second cuts", () => {
  expect(() => verifyVideoScript(script, 1, "concept-1")).not.toThrow();
  expect(() => verifyVideoScript(script, 2, "concept-1")).toThrow("번호");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) =>
          index === 0 ? { ...cut, source: "veo_clip" as const } : cut,
        ),
      },
      1,
      "concept-1",
    ),
  ).toThrow("대표 이미지");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) => (index === 1 ? { ...cut, startSec: 4 } : cut)),
      },
      1,
      "concept-1",
    ),
  ).toThrow("컷 시간");
});

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);

test("picks a stable 30 to 60 second length per job and video number", () => {
  const lengths = Array.from({ length: 40 }, (_, index) => videoTargetSeconds(`job-${index}`, 1));
  expect(lengths.every((value) => value >= 30 && value <= 60)).toBe(true);
  expect(new Set(lengths).size).toBeGreaterThan(5);
  expect(videoTargetSeconds("job-a", 2)).toBe(videoTargetSeconds("job-a", 2));
});

test("accepts a long script that follows the cut, caption and narration rules", () => {
  for (const seconds of [30, 47, 60]) {
    const long = longVideoScript(1, hypothesis.id, seconds);
    expect(() =>
      verifyLongVideoScript(long, { number: 1, durationSec: seconds, hypothesis }),
    ).not.toThrow();
  }
});

test.each([
  ["a wrong length", (s: VideoScript): VideoScript => ({ ...s }), 31, "길이"],
  [
    "a cut longer than four seconds",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, index) =>
        index === 0 ? { ...cut, endSec: 5 } : index === 1 ? { ...cut, startSec: 5 } : cut,
      ),
    }),
    30,
    "4초",
  ],
  [
    "a caption line over sixteen characters",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i) =>
        i === 0 ? { ...cut, onScreenText: "열일곱글자가넘는아주긴자막한줄입니다" } : cut,
      ),
    }),
    30,
    "자막",
  ],
  [
    "too little narration",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) => ({ ...cut, narration: "가" })),
    }),
    30,
    "내레이션 총량",
  ],
  [
    "an offer on a non-BOFU concept",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i) => (i === 4 ? { ...cut, purpose: "offer" as const } : cut)),
    }),
    30,
    "오퍼",
  ],
  [
    "a missing CTA ending",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i, all) =>
        i === all.length - 1 ? { ...cut, purpose: "proof" as const } : cut,
      ),
    }),
    30,
    "행동 유도",
  ],
])("rejects %s", (_name, mutate, expected, message) => {
  const broken = mutate(longVideoScript(1, hypothesis.id, 30));
  expect(() =>
    verifyLongVideoScript(broken, { number: 1, durationSec: expected, hypothesis }),
  ).toThrow(message);
});
