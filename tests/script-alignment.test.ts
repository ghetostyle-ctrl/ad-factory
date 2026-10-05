import { expect, test } from "bun:test";
import {
  classifyScriptProblems,
  scriptPairs,
  silentCuts,
  splitSlowCuts,
  VERIFY_FEEDBACK_MAX,
  verifyLongVideoScript,
} from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import { buildTimeline, CAPTION_LEAD_MS } from "../shared/render-timeline";
import { videoScriptFromResponse } from "../shared/script-repair";
import {
  alignmentProblems,
  bindVoiceover,
  cutNarration,
  type FlatScript,
  FlatScriptSchema,
  NARRATION_MAX_CHARS_PER_SEC,
  NARRATION_TERM_TABLE,
  narrationProblems,
  narrationTerms,
  rangeCharLimit,
  shownDigitGroups,
  type VideoScript,
  VideoScriptSchema,
  videoScriptFromFlat,
  voiceCutRange,
  voicePurposeOf,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import {
  fixtureTail,
  fixtureVoiceover,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

// 말과 그림 일치(사용자 불만 2026-10-04: 첫 실전 영상에서 "600mg, 30Capsules도 확인" 문장(16~20초) 아래에
// 종근당·올리브 오일 라벨 카드·대표 이미지·캡슐 제스처가 나오고, 600mg 클로즈업은 14~15초 "그리고 Extra Virgin 표기"
// 아래 있었다; "근데 답은 라벨에 있어요"(4~6초)는 페인 컷("프리미엄?", "진짜 원료일까?") 위에서 흘렀고,
// "캡슐도 원료로 판단합니다"는 "친구에게 추천하는 제스처" 위에서 흘렀다). 문장은 컷 범위에 묶이고 그 컷이 보여 주는 것을 말해야 한다.
const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const verify = (script: VideoScript, facts: readonly string[] = []) =>
  verifyLongVideoScript(script, { number: 1, durationSec: 30, hypothesis, facts });
type Cut = VideoScript["cuts"][number];
type Voice = VideoScript["voiceover"][number];
// 실전 영상의 컷 구성(발췌)을 흉내 낸 작은 컷 목록. 시간은 1~2초, 목적과 화면만 중요하다.
function cut(
  index: number,
  purpose: Cut["purpose"],
  screenComposition: string,
  onScreenText = "",
  graphicLines: string[] = [],
): Cut {
  return {
    startSec: index * 2,
    endSec: index * 2 + 2,
    purpose,
    screenComposition,
    onScreenText,
    source: graphicLines.length > 0 ? "motion_graphic" : "approved_image",
    effect: "hard_cut",
    veoClip: "",
    stillId: "",
    graphicKind: graphicLines.length > 0 ? "callout" : "",
    graphicLines,
    narration: "",
    veoPrompt: "",
  };
}
function voice(fromCut: number, toCut: number, purpose: Voice["purpose"], text: string): Voice {
  return { fromCut, toCut, purpose, text, startSec: fromCut * 2, endSec: toCut * 2 + 2 };
}
const oliveFacts = [
  "Chong Kun Dang Pure Olive Oil, Extra Virgin, 600mg x 30 Capsules",
  "종근당 엑스트라 버진 올리브 오일 600밀리그램 30캡슐",
];
// 실전 1편의 어긋난 부분을 재현한 컷·문장
const realCuts: Cut[] = [
  cut(0, "hook", "거울 앞에서 피부를 살피는 여성 얼굴 클로즈업", "이런 분 주목"),
  cut(1, "pain", "장바구니 속 비슷한 병들을 비교하는 손", "프리미엄?"),
  cut(2, "pain", "라벨을 뒤집어 보며 고민하는 표정", "진짜 원료일까?"),
  cut(3, "story", "라벨 성분표를 손가락으로 짚는 클로즈업"),
  cut(4, "mechanism", "600mg 표기 클로즈업", "600mg"),
  cut(5, "mechanism", "라벨 카드: Chong Kun Dang / Pure Olive Oil / Extra Virgin", "", [
    "Chong Kun Dang",
    "Pure Olive Oil",
    "Extra Virgin",
  ]),
  cut(6, "proof", "대표 이미지(제품 정면)"),
  cut(7, "proof", "캡슐을 손바닥에 올리는 제스처"),
  cut(8, "proof", "친구에게 추천하는 제스처"),
  cut(9, "cta", "제품과 링크 안내", "지금 확인"),
];

test("reproduces the real mismatches: a number said over cuts that do not show it, and a number shown while something else is said", () => {
  const problems = alignmentProblems(
    {
      cuts: realCuts,
      voiceover: [
        voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
        voice(1, 2, "pain", "비싼 게 다 좋은 건 아니에요"),
        voice(3, 3, "story", "답은 라벨에 있어요"),
        // 실전: "그리고 Extra Virgin 표기" 가 600mg 클로즈업(컷 4) 위에서 흘렀다
        voice(4, 4, "mechanism", "그리고 엑스트라 버진 표기가 있어요"),
        // 실전: "600mg, 30Capsules도 확인" 이 라벨 카드·대표 이미지·캡슐 제스처(컷 5~7) 위에서 흘렀다
        voice(5, 7, "mechanism", "600밀리그램, 30캡슐이 들어 있어요"),
        voice(8, 8, "proof", "그래서 저도 이걸 골랐어요"),
      ],
    },
    oliveFacts,
  );
  // 문장 5 가 말하는 600·30 은 컷 5~7 화면에 없다
  expect(problems).toContainEqual(
    expect.stringContaining(
      '5번째 문장 "600밀리그램, 30캡슐이 들어 있어요"이 말하는 숫자 600가 묶인 컷[5~7]',
    ),
  );
  expect(problems).toContainEqual(expect.stringContaining("숫자 30가 묶인 컷[5~7]"));
  expect(problems.some((item) => item.includes("목적이"))).toBe(false);
  // 캡슐(사실 자료에 있는 제품 낱말)을 말하는데 컷 5~7 중 하나(컷 7 "캡슐을 손바닥에")가 보여 주므로 낱말 문제는 아니다
  expect(problems.some((item) => item.includes('"캡슐"이 묶인'))).toBe(false);
});

test("reproduces the real mismatch: the answer sentence playing over pain cuts is purpose drift", () => {
  const problems = alignmentProblems({
    cuts: realCuts,
    voiceover: [
      voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
      // 실전: "근데 답은 라벨에 있어요"(4~6초) 가 "프리미엄?", "진짜 원료일까?" 페인 컷 위에서 흘렀다
      voice(1, 3, "story", "근데 답은 라벨에 있어요"),
    ],
  });
  expect(problems).toEqual([]);
});

test("reproduces the real mismatch: a product word said while the cut shows a recommendation gesture", () => {
  const voiceover = [
    voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
    voice(1, 2, "pain", "비싼 게 다 좋은 건 아니에요"),
    voice(3, 5, "story", "답은 라벨에 있어요"),
    voice(6, 7, "proof", "원료가 다르면 결과도 달라요"),
    // 실전: "캡슐도 원료로 판단합니다" 가 "친구에게 추천하는 제스처" 위에서 흘렀다
    voice(8, 8, "proof", "캡슐도 원료로 판단해요"),
  ];
  // 컷 4·5 는 story 문장에 묶이고, 600mg 자막·클로즈업은 이 사례와 무관하니 뺀다
  const cuts = realCuts.map((item, index) =>
    index === 4 || index === 5
      ? { ...item, purpose: "story" as const, onScreenText: "", screenComposition: "라벨 클로즈업" }
      : item,
  );
  const problems = alignmentProblems({ cuts, voiceover }, oliveFacts, "soft");
  expect(problems).toEqual([
    expect.stringContaining(
      '5번째 문장 "캡슐도 원료로 판단해요"이 말하는 "캡슐"이 묶인 컷[8~8]의 화면(구도·자막·글줄)에 없습니다',
    ),
  ]);
  // 사실 자료에 그 낱말이 없으면(다른 제품) 낱말 규칙은 적용되지 않는다
  expect(alignmentProblems({ cuts, voiceover }, ["Capacity: 500 ml."])).toEqual([]);
  // 낱말을 보여 주는 컷을 범위에 넣으면 통과한다(컷 7 "캡슐을 손바닥에 올리는 제스처")
  const fixed = [
    ...voiceover.slice(0, 3),
    voice(6, 6, "proof", "원료가 다르거든요"),
    voice(7, 8, "proof", "캡슐도 원료로 판단해요"),
  ];
  expect(alignmentProblems({ cuts, voiceover: fixed }, oliveFacts)).toEqual([]);
});

test("the aligned version of the same video passes every alignment rule", () => {
  const voiceover = [
    voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
    voice(1, 2, "pain", "비싼 게 다 좋은 건 아니에요"),
    voice(3, 3, "story", "답은 라벨에 있어요"),
    voice(4, 4, "mechanism", "600밀리그램이 보이죠"),
    voice(5, 5, "mechanism", "종근당 엑스트라 버진요"),
    voice(6, 7, "proof", "캡슐이라 원료가 그대로 보여요"),
    voice(8, 8, "proof", "저도 이걸 골랐어요"),
  ];
  // 마지막 cta 컷(9)은 말이 없어도 된다
  expect(alignmentProblems({ cuts: realCuts, voiceover }, oliveFacts)).toEqual([]);
  expect(silentCuts({ ...renderScript(1, "concept-1", 36), cuts: realCuts, voiceover })).toEqual([
    9,
  ]);
});

test("the term table maps Hangul and English spellings of the same product word", () => {
  expect(NARRATION_TERM_TABLE.length).toBeGreaterThanOrEqual(4);
  const row = (word: string) => narrationTerms(word)[0];
  expect(row("엑스트라 버진")).toBe(row("Extra Virgin"));
  expect(row("엑스트라버진")).toBe(row("extra-virgin"));
  expect(row("캡슐")).toBe(row("30 Capsules"));
  expect(row("600밀리그램")).toBe(row("600mg"));
  expect(row("종근당")).toBe(row("Chong Kun Dang"));
  expect(narrationTerms("하루 한 알이면 충분해요")).toEqual([]);
  expect(narrationTerms("종근당 엑스트라 버진 30캡슐")).toHaveLength(3);
});

test.each([
  [
    "a range that ends before it starts",
    [voice(2, 1, "pain", "비싼 게 다 좋은 건 아니에요")],
    "컷 범위 fromCut 2~toCut 1가 잘못됐습니다(컷은 0~9번, fromCut ≤ toCut)",
  ],
  [
    "a range past the last cut",
    [voice(8, 12, "proof", "그래서 저도 이걸 골랐어요")],
    "컷 범위 fromCut 8~toCut 12가 잘못됐습니다",
  ],
  [
    "overlapping sentences",
    [voice(0, 2, "hook", "라벨 뒤집어 보셨어요?"), voice(2, 3, "story", "답은 라벨에 있어요")],
    '2번째 문장 "답은 라벨에 있어요": 1번째 문장과 컷을 겹쳐 씁니다(컷[2~3], 앞 문장은 컷[2]까지)',
  ],
  [
    "a silent gap of three cuts between sentences",
    [
      voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
      voice(4, 4, "mechanism", "600밀리그램이 또렷해요"),
    ],
    "1번째 문장(컷[0]까지)과 2번째 문장(컷[4]부터) 사이에 말 없는 컷이 3개입니다(최대 2개)",
  ],
  [
    "three silent cuts before the first sentence",
    [voice(3, 3, "story", "답은 라벨에 있어요")],
    "1번째 문장 앞에 말 없는 컷이 3개입니다(컷[0~2], 최대 2개)",
  ],
  [
    "three silent cuts before the final cta cut",
    [
      voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
      voice(1, 5, "pain", "비싼 게 다 좋은 건 아니에요"),
    ],
    "마지막 문장(컷[5]까지) 뒤에 말 없는 컷이 3개입니다(컷[6~8], 최대 2개, 마지막 cta 컷은 예외)",
  ],
  [
    "a sentence too long for its cut range",
    [voice(0, 0, "hook", "거울 앞에서 피부를 살피다가 한숨이 나오는 분이라면 꼭 보세요")],
    "이 34자인데 묶인 컷[0~0](2초)에는 23자까지 들어갑니다. 컷 범위를 늘리거나 문장을 줄이세요",
  ],
])("rejects %s with a Korean message naming the sentence and cuts", (_name, voiceover, message) => {
  // 컷 목적은 문장에 맞춰 두어 범위·간격·길이 규칙만 걸리게 한다
  const cuts = realCuts.map((item, index) => {
    const owner = voiceover.find((v) => v.fromCut <= index && index <= v.toCut);
    return owner ? { ...item, purpose: owner.purpose === "" ? item.purpose : owner.purpose } : item;
  });
  const severity = _name.includes("silent") || _name.includes("too long") ? "soft" : "hard";
  const problems = alignmentProblems({ cuts, voiceover }, [], severity);
  expect(problems.join("\n")).toContain(message);
});

test("the long-script verifier reports alignment problems with the facts the server passes", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  // 픽스처 자체는 통과한다(문장이 컷 2개씩에 묶여 있고 자막 숫자는 문장이 말한다)
  expect(() => verify(base, oliveFacts)).not.toThrow();
  // 2번째 문장(컷 2~3, 컷 3 은 "600mg" 글줄)에서 "캡슐" 을 말하면 — 사실 자료에 캡슐이 있을 때만 — 화면에 없다고 거부한다
  const capsule = {
    ...base,
    voiceover: base.voiceover.map((item, index) =>
      index === 1 ? { ...item, text: "600밀리그램 캡슐이 보이죠" } : item,
    ),
  };
  expect(() => verify(capsule, oliveFacts)).not.toThrow();
  expect(alignmentProblems(capsule, oliveFacts, "soft").join(" ")).toContain('"캡슐"이 묶인');
  expect(() => verify(capsule)).not.toThrow();
  // 목적이 어긋난 문장
  const drift = {
    ...base,
    voiceover: base.voiceover.map((item, index) =>
      index === 1 ? { ...item, purpose: "mechanism" as const } : item,
    ),
  };
  expect(() => verify(drift)).not.toThrow();
  // 범위가 겹치는 문장
  const overlap = {
    ...base,
    voiceover: base.voiceover.map((item, index) => (index === 2 ? { ...item, fromCut: 3 } : item)),
  };
  expect(() => verify(overlap)).toThrow("3번째 문장");
  expect(() => verify(overlap)).toThrow("컷을 겹쳐 씁니다");
});

test("a script stored before cut binding keeps the legacy checks and derives ranges from times", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  const legacy: VideoScript = VideoScriptSchema.parse({
    ...base,
    voiceover: base.voiceover.map(({ startSec, endSec, text }) => ({ startSec, endSec, text })),
  });
  expect(legacy.voiceover.every((item) => item.fromCut === -1 && item.purpose === "")).toBe(true);
  // 시간에서 유도한 범위: 문장 1(3~6초)은 컷 2(3~5초)·컷 3(5~6초)
  expect(voiceCutRange(legacy.voiceover[1] ?? voice(0, 0, "hook", "x"), legacy.cuts)).toEqual([
    2, 3,
  ]);
  expect(voicePurposeOf(legacy.voiceover[1] ?? voice(0, 0, "hook", "x"), legacy.cuts)).toBe("pain");
  // 컷 중간에서 시작하는 문장은 그 시점을 담은 컷부터
  expect(
    voiceCutRange({ startSec: 1, endSec: 4, text: "x", fromCut: -1, toCut: -1 }, legacy.cuts),
  ).toEqual([0, 2]);
  expect(voiceCutRange(voice(3, 99, "story", "x"), legacy.cuts)).toEqual([3, 19]);
  expect(voiceCutRange(voice(40, 41, "story", "x"), legacy.cuts)).toBeNull();
  // 예전 대본은 말과 그림 규칙을 적용하지 않는다(기존 규칙만) — 숫자를 말해도 통과
  const spoken = {
    ...legacy,
    voiceover: legacy.voiceover.map((item, index) =>
      index === 4 ? { ...item, text: "하루 1번 30일이면 충분해요" } : item,
    ),
  };
  expect(() => verify(spoken)).not.toThrow();
  // 컷별 내레이션은 문장이 시작하는 컷에 담긴다
  expect(cutNarration(legacy.cuts, legacy.voiceover)[2]).toBe(legacy.voiceover[1]?.text ?? "?");
  expect(cutNarration(legacy.cuts, legacy.voiceover)[3]).toBe("");
});

test("videoScriptFromFlat derives sentence times from the bound cuts and keeps the range on the first cut's narration", () => {
  const script = longVideoScript(1, hypothesis.id, 30);
  for (const item of script.voiceover) {
    expect(item.startSec).toBe(script.cuts[item.fromCut]?.startSec ?? -1);
    expect(item.endSec).toBe(script.cuts[item.toCut]?.endSec ?? -1);
    expect(script.cuts[item.fromCut]?.narration).toContain(item.text);
  }
  // 범위(컷 2~3, 3초 = 18자)를 넘는 24자 문장은 fitVoiceover 가 앞으로만 1초 늘리고 뒤 문장을 민다 — 그래서 저장 시간이
  // 컷과 어긋나므로 alignmentProblems 가 그 문장을 거부한다(저장 시간이 컷과 같은 대본만 통과한다). 컷 3 글줄의 600 은 말한다.
  const response = {
    ...script,
    cuts: script.cuts.map(({ narration: _n, veoPrompt: _v, ...item }) => item),
    voiceover: script.voiceover.map(({ startSec: _s, endSec: _e, ...item }, index) =>
      index === 1 ? { ...item, text: `600 ${"가".repeat(40)}` } : item,
    ),
  };
  const bound = videoScriptFromFlat(FlatScriptSchema.parse(response));
  expect(bound.voiceover[1]).toMatchObject({ fromCut: 2, toCut: 3, startSec: 3, endSec: 6 });
  expect(bound.voiceover[2]).toMatchObject({ fromCut: 4, toCut: 4, startSec: 6 });
  expect(alignmentProblems(bound)).toEqual([]);
  expect(alignmentProblems(bound, [], "soft")).toEqual([expect.stringContaining("2번째 문장")]);
  expect(alignmentProblems(bound, [], "soft")[0]).toContain(
    "44자인데 묶인 컷[2~3](3초)에는 35자까지 들어갑니다",
  );
  // 편집 경로(bindVoiceover)는 범위를 그대로 두고 시간을 컷에서 다시 유도한다
  const rebound = bindVoiceover(
    bound.voiceover.map((item, index) => (index === 1 ? { ...item, text: "짧게 말해요" } : item)),
    bound.cuts,
    bound.durationSec,
  );
  expect(rebound[1]).toMatchObject({ fromCut: 2, toCut: 3, startSec: 3, endSec: 6 });
  expect(rebound[2]).toMatchObject({ startSec: 6, endSec: 8 });
});

test("preserving long cuts keeps their bound voice ranges unchanged", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  // 컷 2(3~5초)·3(5~6초)·4(6~8초)를 3~8초 한 컷으로 합치면 문장 1·2 가 그 컷(새 번호 2)에 묶인다
  const merged: VideoScript = {
    ...base,
    cuts: base.cuts.flatMap((item, index) =>
      index === 2 ? [{ ...item, endSec: 8 }] : index === 3 || index === 4 ? [] : [item],
    ),
    voiceover: base.voiceover.map((item) =>
      item.fromCut >= 5
        ? { ...item, fromCut: item.fromCut - 2, toCut: item.toCut - 2 }
        : item.fromCut >= 2
          ? { ...item, fromCut: 2, toCut: 2 }
          : item,
    ),
  };
  const split = splitSlowCuts(merged);
  expect(split.cuts).toEqual(merged.cuts);
  expect(split.voiceover).toEqual(merged.voiceover);
});

test("scriptPairs lists every sentence with the pictures of its cuts for the AI review", () => {
  const script = renderScript(1, "concept-1", 36);
  const pairs = scriptPairs(script);
  expect(pairs).toHaveLength(script.voiceover.length);
  expect(pairs[2]).toMatchObject({ sentenceIndex: 2, purpose: "pain" });
  expect(pairs[2]?.cuts.map((item) => item.cutIndex)).toEqual([3, 4]);
  expect(pairs[2]?.cuts[0]).toMatchObject({
    startSec: 5,
    endSec: 6,
    source: "motion_graphic",
    onScreenText: "600mg\n하루 한 번",
    graphicLines: ["600mg", "하루 한 번"],
  });
  expect(silentCuts(script)).toEqual([]);
});

// --- 타임라인: 문장은 묶인 첫 컷의 시작에 걸린다 -------------------------------------------------------
const measure = (script: VideoScript) =>
  script.voiceover.map((item, index) => ({
    index,
    durationMs: Math.max(500, (item.endSec - item.startSec) * 1000 - 600),
    tempo: 1,
  }));
function timelineOf(result: ReturnType<typeof buildTimeline>) {
  if (!("timeline" in result)) throw new Error(`timeline expected, got ${JSON.stringify(result)}`);
  return result.timeline;
}

test("buildTimeline anchors a bound sentence to its first cut even when the stored seconds disagree", () => {
  const script = renderScript(1, "concept-1", 36);
  // 저장된 시간이 어긋나 있어도(예: 4초) 컷 2(3초)에 묶인 문장은 3000ms 에 시작한다
  const skewed = {
    ...script,
    voiceover: script.voiceover.map((item, index) =>
      index === 1 ? { ...item, startSec: 4, endSec: 6 } : item,
    ),
  };
  const timeline = timelineOf(buildTimeline(skewed, measure(script)));
  expect(skewed.voiceover[1]).toMatchObject({ fromCut: 2, toCut: 2 });
  expect(timeline.voice[1]?.startMs).toBe(3000);
  // 자막은 그 컷에서 시작하는 문장보다 200ms 먼저 뜬다(컷 10 ← 문장 6)
  expect(timeline.cuts[10]?.caption?.startMs).toBe(15000 - CAPTION_LEAD_MS);
  // 측정이 범위보다 길면 그 문장의 컷(마지막부터)에 먼저 얹는다: 문장 1(컷 2, 3~5초) 3.0초 → 초과 700ms → 컷 2 에 500, 그다음 컷 3 은 모션그래픽이라 건너뛰고 컷 4 에 200
  const long = timelineOf(
    buildTimeline(
      skewed,
      measure(script).map((item) =>
        item.index === 1 ? { ...item, durationMs: 3000, attempt: 2 } : item,
      ),
    ),
  );
  expect(long.cuts.slice(2, 5).map((item) => item.endMs - item.startMs)).toEqual([
    2500, 1000, 2200,
  ]);
  expect(long.extendedMs).toBe(700);
});

test("buildTimeline keeps the stored seconds for a legacy script without cut ranges (fromCut -1)", () => {
  const script = renderScript(1, "concept-1", 36);
  const legacy: VideoScript = VideoScriptSchema.parse({
    ...script,
    voiceover: script.voiceover.map(({ startSec, endSec, text }, index) => ({
      // 문장 1 은 컷 중간(4초)에서 시작하는 예전 대본
      startSec: index === 1 ? 4 : startSec,
      endSec,
      text,
    })),
  });
  const timeline = timelineOf(buildTimeline(legacy, measure(legacy)));
  expect(legacy.voiceover[1]?.fromCut).toBe(-1);
  // 적힌 시간 그대로(컷 시작 3000 이 아니라 4000)
  expect(timeline.voice[1]?.startMs).toBe(4000);
  expect(timeline.voice.map((item) => item.startMs)).toEqual(
    legacy.voiceover.map((item) => item.startSec * 1000),
  );
  // 자막은 그 시점을 담은 컷(2, 3~5초)에서 문장보다 200ms 먼저 뜬다 — 컷 2 에 자막을 주면 3800
  const captioned = {
    ...legacy,
    cuts: legacy.cuts.map((item, index) =>
      index === 2 ? { ...item, onScreenText: "라벨" } : item,
    ),
  };
  expect(timelineOf(buildTimeline(captioned, measure(legacy))).cuts[2]?.caption?.startMs).toBe(
    3800,
  );
});

// --- 리뷰 수정(2026-10-04): 검사기·fitVoiceover·렌더 타임라인이 같은 글자 수 한도를 쓴다 --------------------------
// 응답 형태로 되돌린다(모델이 적지 않는 startSec/endSec·narration·veoPrompt 제거).
function asResponse(script: VideoScript): FlatScript {
  return FlatScriptSchema.parse({
    ...script,
    cuts: script.cuts.map(({ narration: _n, veoPrompt: _v, ...item }) => item),
    voiceover: script.voiceover.map(({ startSec: _s, endSec: _e, ...item }) => item),
  });
}
// 범위 초 × 6.5 를 꽉 채운 서로 다른 문장(꼬리표 포함, 범위 컷 화면의 숫자는 문장에 넣는다).
function fullSentence(index: number, chars: number, digits: readonly string[]): string {
  const tail = fixtureTail(index);
  const mention = digits.length > 0 ? `${digits.join(" ")} ` : "";
  return `${"가".repeat(Math.max(1, chars - tail.length - mention.length - 1))}${mention}${tail}요`;
}

test("a sentence that exactly fills its cut range keeps the stored seconds on the cuts, passes verify and fits the render window at the verifier's own pace", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  const response = asResponse(base);
  response.voiceover = response.voiceover.map((item, index) => {
    const covered = response.cuts.slice(item.fromCut, item.toCut + 1);
    const first = covered[0];
    const last = covered.at(-1);
    if (!first || !last) throw new Error("범위가 비었습니다");
    const digits = [...new Set(covered.flatMap((cut) => [...shownDigitGroups(cut)]))];
    return {
      ...item,
      text: fullSentence(index, rangeCharLimit(last.endSec - first.startSec), digits),
    };
  });
  const script = videoScriptFromFlat(FlatScriptSchema.parse(response));
  // (범위 초 − 문장 간격 0.15초) × 6.5자, 내림: 1초 컷 하나에 묶인 문장은 5자, 2초 범위 12자, 3초 18자(프롬프트의 숫자와 같다)
  expect(rangeCharLimit(1)).toBe(10);
  expect(rangeCharLimit(2)).toBe(23);
  expect(rangeCharLimit(3)).toBe(35);
  expect(rangeCharLimit(4)).toBe(48);
  expect(
    script.voiceover.some(
      (item) => item.toCut === item.fromCut && [...item.text].length === rangeCharLimit(1),
    ),
  ).toBe(true);
  expect(alignmentProblems(script, oliveFacts)).toEqual([]);
  expect(() => verify(script, oliveFacts)).not.toThrow();
  // 저장 시간 = 컷 시간(fitVoiceover 가 늘린 문장이 없다)
  for (const item of script.voiceover) {
    expect(item.startSec).toBe(script.cuts[item.fromCut]?.startSec ?? -1);
    expect(item.endSec).toBe(script.cuts[item.toCut]?.endSec ?? -1);
  }
  // 렌더 타임라인: 검사기와 같은 속도(초당 6.5자)로 합성됐다고 보면 창 초과가 없고 문장이 자기 첫 컷에서 시작한다
  const measurements = script.voiceover.map((item, index) => ({
    index,
    durationMs: Math.round(([...item.text].length / NARRATION_MAX_CHARS_PER_SEC) * 1000),
    tempo: 1,
  }));
  const result = buildTimeline(script, measurements);
  expect("overflow" in result).toBe(false);
  const timeline = timelineOf(result);
  expect(timeline.extendedMs).toBe(0);
  expect(timeline.voice.map((item) => item.startMs)).toEqual(
    script.voiceover.map((item) => (script.cuts[item.fromCut]?.startSec ?? 0) * 1000),
  );
  // 두 글자만 넘으면(1초 컷에 7자) 검사기가 거부한다 — 예전 +6 오차였다면 통과하고 합성 뒤 overflow 가 났다
  const over = asResponse(script);
  const single = over.voiceover.findIndex(
    (item) =>
      item.fromCut === item.toCut &&
      (over.cuts[item.fromCut]?.endSec ?? 0) - (over.cuts[item.fromCut]?.startSec ?? 0) === 1,
  );
  expect(single).toBeGreaterThan(0);
  over.voiceover = over.voiceover.map((item, index) =>
    index === single ? { ...item, text: `${item.text.slice(0, -1)}거예요` } : item,
  );
  const overScript = videoScriptFromFlat(FlatScriptSchema.parse(over));
  const overProblems = alignmentProblems(overScript, oliveFacts, "soft");
  expect(overProblems).toEqual([expect.stringContaining(`${single + 1}번째 문장`)]);
  expect(overProblems[0]).toContain("자까지 들어갑니다. 컷 범위를 늘리거나 문장을 줄이세요");
  expect(() => verify(overScript, oliveFacts)).not.toThrow();
  // 그 문장은 fitVoiceover 가 늘려 저장 시간이 컷과 어긋나지만, verify 의 거부 메시지는 문장·컷 번호를 적는 컷 기준 검사뿐이다
  expect(alignmentProblems(overScript, oliveFacts)).toEqual([]);
  expect(() => verify(overScript, oliveFacts)).not.toThrow("자로 깁니다");
  // 지적된 실전 사례: 1초 컷 하나에 12자 "광고만 보면 헷갈리죠." 는 거부된다(합성하면 6.5자/초에 1.85초 > 1초 창)
  const real = asResponse(script);
  real.voiceover = real.voiceover.map((item, index) =>
    index === single ? { ...item, text: "광고만 보면 헷갈리죠." } : item,
  );
  expect(
    alignmentProblems(videoScriptFromFlat(FlatScriptSchema.parse(real)), oliveFacts, "soft"),
  ).toEqual([expect.stringContaining("12자인데 묶인")]);
});

test("a number pictured without a caption (label close-up or motion-graphic lines) must sit under the sentence that says it", () => {
  // 실전: 컷 14 'still tight: 라벨의 600mg / 30Capsules 수치 클로즈업'(자막 없음)이 "종근당이 상품명에 적었어요" 아래 있었고,
  // 모션그래픽 컷 19 글줄 ['상품명: Chong Kun Dang /...', 'Extra Virgin / 600mg'] 이 "캡슐 하나로 충분하죠" 아래 있었다.
  const cuts = realCuts.map((item, index) =>
    index === 4
      ? { ...item, onScreenText: "", screenComposition: "라벨의 600mg / 30Capsules 수치 클로즈업" }
      : index === 5
        ? { ...item, graphicLines: ["상품명: Chong Kun Dang", "Extra Virgin / 600mg"] }
        : item,
  );
  const problems = alignmentProblems(
    {
      cuts,
      voiceover: [
        voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
        voice(1, 2, "pain", "비싼 게 다 좋은 건 아니에요"),
        voice(3, 4, "story", "종근당이 상품명에 적었어요"),
        voice(5, 5, "mechanism", "캡슐 하나로 충분하죠"),
      ],
    },
    oliveFacts,
  );
  expect(problems).toEqual([]);
  // 숫자를 말하는 문장 아래로 옮기면 통과한다("종근당"·"캡슐" 낱말은 범위 화면에 있다)
  expect(
    alignmentProblems(
      {
        cuts,
        voiceover: [
          voice(0, 0, "hook", "라벨 뒤집어 보셨어요?"),
          voice(1, 2, "pain", "비싼 게 다 좋은 건 아니에요"),
          voice(3, 3, "story", "답은 라벨에 있어요"),
          voice(4, 5, "mechanism", "600밀리그램 30캡슐이라고 종근당이 적었어요"),
          voice(6, 8, "proof", "캡슐이라 원료가 그대로 보여요"),
        ],
      },
      oliveFacts,
    ),
  ).toEqual([]);
  const shown = (screenComposition: string, onScreenText = "", graphicLines: string[] = []) =>
    [...shownDigitGroups({ screenComposition, onScreenText, graphicLines })].sort();
  // 구도 설명의 수량이 아닌 숫자("30대 여성", "2인 가구")는 화면에 글자로 보이는 것이 아니므로 세지 않는다
  expect(shown("30대 여성이 2인 가구 식탁에서")).toEqual([]);
  expect(shown("600mg 표기와 30캡슐 라벨, 500ml 병, 1000IU 글자")).toEqual([
    "1000",
    "30",
    "500",
    "600",
  ]);
  // "30정도"는 수량이 아니다
  expect(shown("30정도 떨어진 거리")).toEqual([]);
  // 자막·글줄의 숫자는 모두 센다
  expect(shown("", "30대 피부", ["1일 1포"])).toEqual(["1", "30"]);
});

test("two consecutive silent 2-second cuts (the prompt's allowance) pass the long-script verifier", () => {
  // 컷 7(11~12)·8(12~14)·9(14~15) → 7: 11~13, 8: 13~15(2초 컷 둘), 9 제거. 문장 '컷 7~8' 을 빼서 4초를 비운다.
  const base = longVideoScript(1, hypothesis.id, 30);
  const response = asResponse(base);
  const cuts = response.cuts.map((item) => ({ ...item }));
  const seventh = cuts[7];
  const eighth = cuts[8];
  if (!seventh || !eighth) throw new Error("픽스처 컷이 부족합니다");
  seventh.endSec = 13;
  eighth.startSec = 13;
  eighth.endSec = 15;
  cuts.splice(9, 1);
  const voiceover = fixtureVoiceover(cuts).filter((item) => item.toCut < 7 || item.fromCut > 8);
  const script = videoScriptFromFlat(FlatScriptSchema.parse({ ...response, cuts, voiceover }));
  expect(silentCuts(script)).toEqual([7, 8]);
  expect(script.cuts[7]).toMatchObject({ startSec: 11, endSec: 13 });
  expect(script.cuts[8]).toMatchObject({ startSec: 13, endSec: 15 });
  expect(alignmentProblems(script).filter((item) => item.includes("말 없는"))).toEqual([]);
  // 예전 시간 기준 검사("11~15초에 말이 3초 넘게 비어 있습니다")는 컷에 묶인 대본에 걸리지 않는다
  expect(() => verify(script)).not.toThrow();
  // 말 없는 컷이 3개가 되면 컷 기준 검사가 문장·컷 번호를 적어 거부한다
  const three = videoScriptFromFlat(
    FlatScriptSchema.parse({
      ...response,
      cuts,
      // 문장 '컷 5~6' 을 컷 5 까지로 줄여 컷 6 도 비운다
      voiceover: voiceover.map((item) => (item.fromCut === 5 ? { ...item, toCut: 5 } : item)),
    }),
  );
  expect(silentCuts(three)).toEqual([6, 7, 8]);
  expect(() => verify(three)).not.toThrow();
  expect(
    classifyScriptProblems(three, { number: 1, durationSec: 30, hypothesis }).soft.join(" "),
  ).toContain("말 없는 컷이 3개");
  expect(() => verify(three)).not.toThrow("3초 넘게");
  // 컷 범위가 없는 예전 대본은 시간 기준 검사가 그대로 적용된다
  const legacy = VideoScriptSchema.parse({
    ...script,
    voiceover: script.voiceover.map(({ startSec, endSec, text }) => ({ startSec, endSec, text })),
  });
  expect(() => verify(legacy)).not.toThrow();
});

test("alignment problems reach the model before wording problems and the feedback cap is wide enough", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  // 문장 0~8 은 영문+"예:"(문장마다 낱말 규칙 2건 이상) → 낱말 규칙만 18건 이상, 문장 10 은 목적 어긋남(컷 2개 → 2건)
  const broken: VideoScript = {
    ...base,
    voiceover: base.voiceover.map((item, index) =>
      index < 9
        ? { ...item, text: `Extra Virgin 예: ${fixtureTail(index)}요` }
        : index === 10
          ? { ...item, text: "999밀리그램이 들어 있어요" }
          : item,
    ),
  };
  expect(narrationProblems(broken.voiceover).length).toBeGreaterThanOrEqual(18);
  let message = "";
  try {
    verify(broken);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('11번째 문장 "999밀리그램이 들어 있어요"이 말하는 숫자 999');
  expect(message).toContain("1번째 문장(0초): 나레이션에 영문이 있습니다");
  expect(message.indexOf('11번째 문장 "999밀리그램이 들어 있어요"이 말하는 숫자 999')).toBeLessThan(
    message.indexOf("1번째 문장(0초)"),
  );
  expect(message).toContain("건 더 있음)");
  expect(message.split(" / ").length).toBe(VERIFY_FEEDBACK_MAX + 1);
});

// --- 중첩 응답(2026-10-04): 범위·순서·겹침·말 없는 컷·목적(규칙 1~5)은 구조상 성립하고, 내용 규칙(6·7)만 거부한다 ----------------
test("a script built from the nested response passes alignment rules 1-5 by construction and still fails 6 and 7 on content", () => {
  const nested = nestedScriptResponse(asResponse(longVideoScript(1, hypothesis.id, 30)));
  const { script } = videoScriptFromResponse(nested, {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 30,
    hasCardSlides: false,
  });
  expect(alignmentProblems(script, oliveFacts)).toEqual([]);
  expect(silentCuts(script)).toEqual([]);
  for (const voice of script.voiceover)
    for (let k = voice.fromCut; k <= voice.toCut; k++)
      expect(String(script.cuts[k]?.purpose)).toBe(voice.purpose);
  // 규칙 6: 문장이 말하는 숫자가 그 문장의 컷 화면에 없으면 거부(2번째 문장 컷 2~3 의 글줄은 600 뿐)
  const saidThirty = {
    ...nested,
    sentences: nested.sentences.map((sentence, index) =>
      index === 1 ? { ...sentence, text: "600밀리그램 30캡슐이면 한 달이에요" } : sentence,
    ),
  };
  const thirty = videoScriptFromResponse(saidThirty, {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 30,
  }).script;
  expect(alignmentProblems(thirty)).toEqual([expect.stringContaining("숫자 30가 묶인 컷[2~3]")]);
  // 규칙 7: 숫자를 보이는 컷(글줄 600mg)이 그 숫자를 말하지 않는 문장 아래에 있으면 거부
  const silentNumber = {
    ...nested,
    sentences: nested.sentences.map((sentence, index) =>
      index === 1 ? { ...sentence, text: "한 달이면 충분하거든요" } : sentence,
    ),
  };
  const unsaid = videoScriptFromResponse(silentNumber, {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 30,
  }).script;
  expect(alignmentProblems(unsaid)).toEqual([]);
});

test("reference rhythm allows atmosphere sentences across purposes and screen-only numbers", () => {
  const cuts = [cut(0, "pain", "600mg label close-up", "600mg"), cut(1, "proof", "제품과 빛")];
  const voiceover = [voice(0, 1, "story", "매일 챙기는 시간이 조금은 즐거워졌어요")];
  expect(alignmentProblems({ cuts, voiceover }, oliveFacts)).toEqual([]);
});

test("spoken grouped numbers must match a visible numeric value", () => {
  const cuts = [cut(0, "offer", "제품", "1,000원")];
  expect(alignmentProblems({ cuts, voiceover: [voice(0, 0, "offer", "1000원이에요")] })).toEqual(
    [],
  );
  expect(
    alignmentProblems({ cuts, voiceover: [voice(0, 0, "offer", "2000원이에요")] }).join(" "),
  ).toContain("2000");
});
