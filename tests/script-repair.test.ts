import { expect, test } from "bun:test";
import { classifyScriptProblems, verifyLongVideoScript } from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import {
  flattenSentences,
  repairFlat,
  repairSentences,
  videoScriptFromResponse,
  wrapCaption,
} from "../shared/script-repair";
import {
  type VideoScript,
  type VideoScriptResponse,
  VideoScriptSchema,
  videoScriptFromFlat,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import {
  fixtureClipPlan,
  fixtureSentence,
  fixtureVoiceover,
  flatOf,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

// 자동 수리(R1~R10): 기계적인 문제는 거부하지 않고 고치고, 모든 수리는 한국어 한 줄로 repairs 에 남는다. 수리 뒤 verify 가 통과한다.
const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const cardHypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[1]);
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 30, hasCardSlides: false };
const expected = { number: 1, durationSec: 30, hypothesis };
// 30초 픽스처를 중첩 응답으로(수리할 것이 없어 그대로 통과한다)
const base = () => nestedScriptResponse(flatOf(longVideoScript(1, hypothesis.id, 30)));
type Sentence = VideoScriptResponse["sentences"][number];
function withSentence(
  response: VideoScriptResponse,
  index: number,
  change: (sentence: Sentence) => Sentence,
): VideoScriptResponse {
  return {
    ...response,
    sentences: response.sentences.map((item, k) => (k === index ? change(item) : item)),
  };
}
const koreanLines = (items: readonly string[]) => {
  for (const item of items) {
    expect(item).toMatch(/[가-힣]/);
    expect(item).not.toContain("\n");
  }
};

test("a clean nested response converts without repairs and passes the verifier", () => {
  const { script, repairs, warnings } = videoScriptFromResponse(base(), ctx);
  expect(repairs).toEqual([]);
  expect(warnings).toEqual([]);
  expect(() => verifyLongVideoScript(script, expected)).not.toThrow();
});

test("flattening derives indexes, seconds and purposes by construction and keeps narration and Veo prompts", () => {
  const response = base();
  const flat = flattenSentences(response, ctx);
  expect(flat.number).toBe(1);
  expect(flat.hypothesisId).toBe(hypothesis.id);
  expect(flat.durationSec).toBe(
    response.sentences.reduce(
      (sum, sentence) => sum + sentence.cuts.reduce((inner, cut) => inner + cut.len, 0),
      0,
    ),
  );
  let next = 0;
  let start = 0;
  response.sentences.forEach((sentence, index) => {
    const voice = flat.voiceover[index];
    if (!voice) throw new Error("문장이 사라졌습니다");
    expect(voice).toMatchObject({
      fromCut: next,
      toCut: next + sentence.cuts.length - 1,
      purpose: sentence.purpose,
      chainStep: sentence.chainStep,
      text: sentence.text,
    });
    for (const cut of sentence.cuts) {
      expect(flat.cuts[next]).toMatchObject({
        startSec: start,
        endSec: start + cut.len,
        purpose: sentence.purpose,
        source: cut.source,
      });
      start += cut.len;
      next++;
    }
  });
  expect(next).toBe(flat.cuts.length);
  expect(start).toBe(flat.durationSec);
  const script = videoScriptFromFlat(flat);
  for (const voice of script.voiceover) {
    expect(voice.startSec).toBe(script.cuts[voice.fromCut]?.startSec ?? -1);
    expect(voice.endSec).toBe(script.cuts[voice.toCut]?.endSec ?? -1);
    expect(script.cuts[voice.fromCut]?.narration).toContain(voice.text);
  }
  expect(script.cuts[0]?.veoPrompt).toBe(response.veoClips[0]?.prompt ?? "?");
  expect(script.cuts[3]?.veoPrompt).toBe("");
  // 평면 경로와 중첩 경로는 같은 저장본을 만든다(컷 목적은 문장 목적을 상속하므로 그 점만 맞춘다)
  const flatPath = videoScriptFromFlat(flatOf(renderScript(1, cardHypothesis.id, 36)));
  const nestedPath = videoScriptFromResponse(nestedScriptResponse(flatOf(flatPath)), {
    number: 1,
    hypothesisId: cardHypothesis.id,
    targetSec: 36,
    hasCardSlides: true,
  });
  expect(nestedPath.repairs).toHaveLength(1);
  const owner = (index: number) =>
    flatPath.voiceover.find((voice) => voice.fromCut <= index && index <= voice.toCut)?.purpose;
  expect(nestedPath.script).toEqual({
    ...flatPath,
    // 중첩 응답은 사슬 칸을 반드시 적는다(사슬이 없으면 bridge).
    voiceover: flatPath.voiceover.map((voice) => ({ ...voice, chainStep: "bridge" as const })),
    cuts: flatPath.cuts.map((cut, index) => ({
      ...cut,
      onScreenText: wrapCaption(cut.onScreenText).text,
      purpose: (owner(index) || cut.purpose) as typeof cut.purpose,
    })),
  });
});

test("R4 clears graphic fields on non-graphic cuts, fills a graphic cut from its caption and fixes stray ids", () => {
  let response = base();
  // 정지 이미지가 아닌 컷 6개에 글줄·종류를 붙인다(오늘 실패: 14·24·29·31·35·37초 컷)
  let stamped = 0;
  response = {
    ...response,
    sentences: response.sentences.map((sentence) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut) => {
        if (cut.source === "motion_graphic" || stamped >= 6) return cut;
        stamped++;
        return { ...cut, graphicLines: ["잘못 붙은 글줄"], graphicKind: "callout" as const };
      }),
    })),
  };
  const repaired = repairSentences(response, ctx);
  expect(repaired.repairs.filter((item) => item.includes("graphicLines 1줄 삭제"))).toHaveLength(6);
  expect(
    repaired.repairs.filter((item) => item.includes('graphicKind "callout" 삭제')),
  ).toHaveLength(6);
  koreanLines(repaired.repairs);
  const { script } = videoScriptFromResponse(response, ctx);
  expect(() => verifyLongVideoScript(script, expected)).not.toThrow();
  // 모션그래픽인데 종류·글줄이 없으면 자막으로 채운다; 대표 이미지 컷의 veoClip/stillId 도 비운다
  const sloppy = withSentence(base(), 1, (sentence) => ({
    ...sentence,
    cuts: sentence.cuts.map((cut, k) =>
      k === 0
        ? cut.source === "motion_graphic"
          ? {
              ...cut,
              graphicKind: "" as const,
              graphicLines: [],
              onScreenText: "600mg\n하루 한 번",
            }
          : { ...cut, veoClip: "A" as const, stillId: "S1" as const }
        : cut,
    ),
  }));
  const second = repairSentences(sloppy, ctx);
  const target = second.value.sentences[1]?.cuts[0];
  if (!target) throw new Error("컷이 없습니다");
  if (target.source === "motion_graphic") {
    expect(target.graphicKind).toBe("callout");
    expect(target.graphicLines).toEqual(["600mg", "하루 한 번"]);
    expect(second.repairs.some((item) => item.includes("자막 2줄을 글줄로 채움"))).toBe(true);
  } else {
    expect(target.veoClip).toBe("");
    expect(target.stillId).toBe("");
    expect(second.repairs.some((item) => item.includes("veoClip A 삭제"))).toBe(true);
    expect(second.repairs.some((item) => item.includes("stillId S1 삭제"))).toBe(true);
  }
  // 카드뉴스가 없는 광고안의 card_slide 는 대표 이미지로
  const carded = withSentence(base(), 7, (sentence) => ({
    ...sentence,
    cuts: sentence.cuts.map((cut) =>
      cut.source === "approved_image" ? { ...cut, source: "card_slide" as const } : cut,
    ),
  }));
  const third = repairSentences(carded, { hasCardSlides: false });
  expect(third.repairs.some((item) => item.includes("card_slide → 대표 이미지"))).toBe(true);
  expect(
    repairSentences(carded, { hasCardSlides: true }).repairs.some((item) =>
      item.includes("card_slide"),
    ),
  ).toBe(false);
});

test.each([
  ["fast", 40, 3],
  ["slow", 26, 7],
])("preserves cut timing when %s delivery warrants pacing advice", (_pace, chars, seconds) => {
  // Given
  const response = withSentence(base(), 0, (sentence) => ({
    ...sentence,
    text: fixtureSentence(0, chars),
    cuts: sentence.cuts.map((cut, index) => ({
      ...cut,
      len: index === 0 ? Math.ceil(seconds / 2) : Math.floor(seconds / 2),
    })),
  }));
  const before = response.sentences.map((sentence) => sentence.cuts.map((cut) => cut.len));
  // When
  const { script, repairs } = videoScriptFromResponse(response, ctx);
  const problems = classifyScriptProblems(script, { ...expected, durationSec: 27 + seconds });
  // Then
  expect(script.cuts.map((cut) => cut.endSec - cut.startSec)).toEqual(before.flat());
  expect(repairs).toEqual([]);
  expect(script.durationSec).toBe(27 + seconds);
  expect(script.voiceover[0]?.endSec).toBe(seconds);
  expect(problems.hard).toEqual([]);
  expect(problems.soft).toContainEqual(expect.stringContaining("1번째 문장"));
});
test("preserves three-second shots and half-second bursts in any sentence", () => {
  const response = withSentence(base(), 1, (sentence) => {
    const cut = sentence.cuts[0];
    if (!cut) throw new Error("fixture cut missing");
    return {
      ...sentence,
      cuts: [
        { ...cut, len: 3 },
        { ...cut, len: 0.5 },
      ],
    };
  });
  const repaired = repairSentences(response, ctx);
  expect(repaired.value.sentences[1]?.cuts.map((cut) => cut.len)).toEqual([3, 0.5]);
});

test("R5 forces an approved-image cut and R6 drops unused declarations and re-points flowPrompt", () => {
  const response = base();
  // 대표 이미지 컷을 전부 정지 이미지로 바꾸고, 쓰지 않는 클립 B·정지 이미지 S9 를 선언하고 flowPrompt 를 B 의 프롬프트로 둔다
  const stripped: VideoScriptResponse = {
    ...response,
    veoClips: [
      ...response.veoClips,
      {
        id: "B",
        startImagePrompt: "Unused start.",
        prompt: "Unused clip B motion.",
        plan: fixtureClipPlan("B"),
      },
    ],
    stills: [
      { id: "S1", prompt: "Kitchen still." },
      { id: "S9", prompt: "Unused still." },
    ],
    flowPrompt: "Unused clip B motion.",
    sentences: response.sentences.map((sentence) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut) =>
        cut.source === "approved_image"
          ? { ...cut, source: "still_image" as const, stillId: "S1" as const }
          : cut,
      ),
    })),
  };
  const repaired = repairSentences(stripped, ctx);
  const last = repaired.value.sentences.at(-1)?.cuts.at(-1);
  expect(last?.source).toBe("approved_image");
  expect(last?.stillId).toBe("");
  expect(repaired.value.veoClips.map((clip) => clip.id)).toEqual(["A"]);
  expect(repaired.value.stills.map((still) => still.id)).toEqual(["S1"]);
  expect(repaired.value.flowPrompt).toBe(response.veoClips[0]?.prompt ?? "?");
  expect(repaired.repairs).toContainEqual(
    expect.stringContaining("마지막 컷을 대표 이미지로 바꿈"),
  );
  expect(repaired.repairs).toContainEqual(
    expect.stringContaining("쓰지 않는 Veo 클립 선언 삭제: B"),
  );
  expect(repaired.repairs).toContainEqual(
    expect.stringContaining("쓰지 않는 정지 이미지 선언 삭제: S9"),
  );
  expect(repaired.repairs).toContainEqual(expect.stringContaining("flowPrompt"));
  expect(repaired.warnings.some((item) => item.includes("대표 이미지"))).toBe(true);
  expect(repaired.warnings.some((item) => item.includes("Veo 클립 B"))).toBe(true);
  koreanLines([...repaired.repairs, ...repaired.warnings]);
});

test("caption normalization preserves all content including trailing quantities", () => {
  const input = `제품의 내용을 충분히 설명하는 긴 자막
마지막에 중요한 600mg`;
  const normalized = wrapCaption(input);
  expect(normalized.truncated).toBe(false);
  expect(normalized.text).toBe("제품의 내용을 충분히 설명하는 긴 자막 마지막에 중요한 600mg");
  expect(wrapCaption("이런 분 주목")).toEqual({
    text: "이런 분 주목",
    changed: false,
    truncated: false,
  });
  const flat = flatOf(longVideoScript(1, hypothesis.id, 30));
  const first = flat.cuts[0];
  if (!first) throw new Error("fixture cut missing");
  flat.cuts[0] = { ...first, onScreenText: input };
  const repaired = repairFlat(flat);
  expect(repaired.value.cuts[0]?.onScreenText).toBe(normalized.text);
  expect(
    classifyScriptProblems(videoScriptFromFlat(repaired.value), expected).soft.join(" "),
  ).toContain("자막");
});

test("regular hard cuts already count as visual change without forced zoom effects", () => {
  const flat = flatOf(longVideoScript(1, hypothesis.id, 30));
  const simple = {
    ...flat,
    cuts: flat.cuts.map((cut) => ({ ...cut, effect: "hard_cut" as const })),
  };
  const repaired = repairFlat(simple);
  expect(repaired.value.cuts.every((cut) => cut.effect === "hard_cut")).toBe(true);
  expect(
    classifyScriptProblems(videoScriptFromFlat(repaired.value), expected).soft.filter((item) =>
      item.includes("시각 변화"),
    ),
  ).toEqual([]);
});

test("preserves an early payoff and planned effects while reporting repeated effects as advice", () => {
  const flat = flatOf(longVideoScript(1, hypothesis.id, 30));
  const tripled = {
    ...flat,
    payoffSec: 5,
    cuts: flat.cuts.map((cut, index) =>
      index >= 4 && index <= 6 ? { ...cut, effect: "shake" as const } : cut,
    ),
  };
  const repaired = repairFlat(tripled);
  expect(repaired.value.cuts.slice(4, 7).map((cut) => cut.effect)).toEqual([
    "shake",
    "shake",
    "shake",
  ]);
  expect(repaired.value.payoffSec).toBe(5);
  expect(repaired.repairs).toEqual([]);
  expect(repaired.warnings).toEqual([]);
  const script: VideoScript = videoScriptFromFlat(repaired.value);
  const rules = classifyScriptProblems(script, expected);
  expect(rules.hard).toEqual([]);
  expect(rules.soft.filter((item) => item.includes("같은 효과"))).toHaveLength(1);
  expect(rules.soft.filter((item) => item.includes("payoffSec"))).toEqual([]);
  koreanLines([...repaired.repairs, ...repaired.warnings]);
});

test("fractional script duration keeps a repaired payoff inside the stored integer schema", () => {
  const response = nestedScriptResponse(flatOf(renderScript(1, cardHypothesis.id, 36)));
  const lastSentence = response.sentences.at(-1);
  const lastCut = lastSentence?.cuts.at(-1);
  if (!lastSentence || !lastCut) throw new Error("fixture lacks final cut");
  lastCut.len -= 0.5;
  response.payoffSec = 60;
  const { script } = videoScriptFromResponse(response, {
    number: 1,
    hypothesisId: cardHypothesis.id,
    targetSec: 36,
    hasCardSlides: true,
  });
  expect(script.durationSec).toBe(35.5);
  expect(VideoScriptSchema.safeParse(script).success).toBe(true);
  expect(script.payoffSec).toBe(35);
});

test("fractional source durations honor millisecond limits without floating-point false positives", () => {
  const flat = flatOf(longVideoScript(1, hypothesis.id, 30));
  const template = flat.cuts[0];
  if (!template) throw new Error("fixture cut missing");
  const edges = [0, 0.5, 1.2, 2.9, 4.1, 5.9, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 30];
  flat.cuts = edges.slice(0, -1).map((startSec, index) => ({
    ...template,
    startSec,
    endSec: edges[index + 1] ?? 30,
    purpose: index === 0 ? "hook" : index === edges.length - 2 ? "cta" : "mechanism",
    source: [0, 2, 4].includes(index) ? "still_image" : "approved_image",
    stillId: [0, 2, 4].includes(index) ? "S1" : "",
    veoClip: "",
    phase: "",
    onScreenText: "",
  }));
  flat.veoClips = [];
  flat.stills = [{ id: "S1", prompt: "An object in natural light." }];
  flat.voiceover = fixtureVoiceover(flat.cuts).map((voice, index) =>
    index === 0 ? { ...voice, text: "처음이에요" } : voice,
  );
  const script = videoScriptFromFlat(flat);
  expect(classifyScriptProblems(script, expected).hard).toEqual([]);
  const overflow = {
    ...script,
    cuts: script.cuts.map((cut, index) =>
      index === 4 ? { ...cut, endSec: cut.endSec + 0.001 } : cut,
    ),
  };
  expect(
    classifyScriptProblems(overflow, expected).soft.some((item) =>
      item.includes("정지 이미지 S1을 총 4.001초"),
    ),
  ).toBe(true);
});
