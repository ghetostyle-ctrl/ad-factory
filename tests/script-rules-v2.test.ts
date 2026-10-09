import { expect, test } from "bun:test";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import {
  COPY_GAP_MS,
  type CopyContext,
  copyProblems,
  estimateSpeechMs,
  sceneProblemsV2,
} from "../shared/script-rules-v2";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  type CopyLine,
  sentenceSimilarity,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

// 카피 먼저 흐름(2026-10-08)의 규칙 20개: 카피 8개(copyProblems)와 장면 제작 안전 12개(sceneProblemsV2).
// 합격 예시와 규칙 하나씩의 거부·경고 케이스를 여기서 보장한다.

// --- 카피 ---------------------------------------------------------------------------------------------------------
const FACTS = [
  "엑스트라 버진 올리브유 100%(스페인산)",
  "다른 식물성 기름을 섞지 않았다",
  "종근당이 제조한다",
];
const ctx: CopyContext = { durationTargetSec: 45, facts: FACTS };
const BASE_LINES: readonly CopyLine[] = [
  { chainStep: "pain", text: "싸게 산 올리브 캡슐, 뒤늦게 보니 대두유가 섞여 있었죠." },
  { chainStep: "pain", text: "올리브유 백 퍼센트인 줄 알고 샀는데, 속은 기분이죠." },
  { chainStep: "real_cause", text: "겉도 이름도 똑같아 보이지만, 속에 든 기름은 달라요." },
  { chainStep: "requirement", text: "그래서 사기 전에 원재료명 한 줄만 읽으면 돼요." },
  { chainStep: "product_fact", text: "종근당이 만든 퓨어는 다른 식물성 기름을 섞지 않았어요." },
  { chainStep: "reason_why", text: "오일 원료가 스페인산 엑스트라 버진 올리브유 백 퍼센트거든요." },
  { chainStep: "outcome", text: "이번엔 이름 말고 원재료를 보고 고르는 거죠." },
  { chainStep: "cta", text: "지금 원재료 한 줄, 읽어 보세요." },
];
const has = (list: readonly string[], text: string) =>
  list.some((message) => message.includes(text));
const withText = (lines: readonly CopyLine[], index: number, text: string): CopyLine[] =>
  lines.map((line, at) => (at === index ? { ...line, text } : line));
const insertAt = (lines: readonly CopyLine[], index: number, line: CopyLine): CopyLine[] => [
  ...lines.slice(0, index),
  line,
  ...lines.slice(index),
];
const textsOf = (lines: readonly CopyLine[]) => lines.map((line) => line.text);

test("estimateSpeechMs counts every character at the natural rate and adds the gap between sentences", () => {
  // Given: 27자 문장 8개
  const eight = Array.from({ length: 8 }, () => "가".repeat(27));
  // Then: 216자 / 5.5 = 39.27초 + 간격 7 × 0.5초 = 3.5초
  expect(estimateSpeechMs(eight)).toBe(Math.round((216 / 5.5) * 1000 + 3500));
  expect(COPY_GAP_MS).toBe(500);
  expect(estimateSpeechMs([])).toBe(0);
  expect(estimateSpeechMs(["가".repeat(10), "나".repeat(10)], 10, 0)).toBe(2000);
  // 합격 예시 8문장은 40~50초
  const example = estimateSpeechMs(textsOf(BASE_LINES));
  expect(example).toBeGreaterThanOrEqual(40_000);
  expect(example).toBeLessThanOrEqual(50_000);
});

test("copyProblems passes the 8-sentence example with no hard problems and no warnings", () => {
  // When / Then
  expect(copyProblems(BASE_LINES, ctx)).toEqual({ hard: [], soft: [] });
});

test("rule 1 rejects a chain that breaks the order, misses a required step, or misuses bridge and cta", () => {
  // 순서: 해결 조건(④)이 우리 상품의 사실(⑤) 뒤로
  const [a, b, c, requirement, fact, ...tail] = BASE_LINES;
  if (!a || !b || !c || !requirement || !fact) throw new TypeError("fixture lines");
  const swapped = copyProblems([a, b, c, fact, requirement, ...tail], ctx);
  expect(has(swapped.hard, '5번째 문장(④ 해결 조건) "그래서 사기 전에')).toBe(true);
  expect(has(swapped.hard, "순서를 거슬렀습니다")).toBe(true);
  // 빠진 단계: 가능한 이유(⑥) 없음
  const missing = copyProblems(
    BASE_LINES.filter((line) => line.chainStep !== "reason_why"),
    ctx,
  );
  expect(has(missing.hard, "빠진 단계가 있습니다: ⑥ 가능한 이유")).toBe(true);
  // 믿는 원인(②)은 생략해도 된다
  expect(BASE_LINES.some((line) => line.chainStep === "believed_cause")).toBe(false);
  // 연결(bridge)은 사이에는 되고 맨 앞·맨 뒤는 안 된다
  const bridge: CopyLine = { chainStep: "bridge", text: "자, 그럼 이렇게 해요." };
  expect(copyProblems(insertAt(BASE_LINES, 4, bridge), ctx).hard).toEqual([]);
  expect(has(copyProblems([bridge, ...BASE_LINES], ctx).hard, "1번째 문장이 연결(bridge)")).toBe(
    true,
  );
  expect(
    has(copyProblems([...BASE_LINES, bridge], ctx).hard, "9번째 문장이 연결(bridge)입니다"),
  ).toBe(true);
  // 행동 문장은 맨 뒤 한 문장
  const twoCtas = copyProblems(
    [...BASE_LINES, { chainStep: "cta", text: "오늘 한번 비교해 보세요." }],
    ctx,
  );
  expect(has(twoCtas.hard, "행동 문장이 2개(8·9번째)")).toBe(true);
  // 고통(①)이 없다
  const noPain = copyProblems(
    BASE_LINES.filter((line) => line.chainStep !== "pain"),
    ctx,
  );
  expect(has(noPain.hard, "① 고통")).toBe(true);
});

test("rule 2 rejects Arabic numerals that are not in the registered facts and skips when no facts are given", () => {
  // Given: 사실에 없는 700
  const lines = withText(BASE_LINES, 5, "오일 원료가 700밀리그램 엑스트라 버진 올리브유거든요.");
  // Then: 몇 번째 문장인지와 숫자가 메시지에 있다
  const result = copyProblems(lines, ctx);
  expect(has(result.hard, '6번째 문장(⑥ 가능한 이유) "오일 원료가 700밀리그램')).toBe(true);
  expect(has(result.hard, "숫자(700)")).toBe(true);
  // 사실에 있는 숫자(100)·쉼표 표기와 한글 숫자는 통과
  const allowed = withText(BASE_LINES, 5, "오일 원료가 100% 엑스트라 버진 올리브유거든요.");
  expect(has(copyProblems(allowed, ctx).hard, "숫자")).toBe(false);
  expect(
    has(
      copyProblems(withText(BASE_LINES, 5, "원료가 1,000분의 100이거든요."), {
        ...ctx,
        facts: ["함량 1000분의 100"],
      }).hard,
      "숫자",
    ),
  ).toBe(false);
  // 사실이 비면 숫자 검사를 건너뛴다
  expect(has(copyProblems(lines, { ...ctx, facts: [] }).hard, "숫자")).toBe(false);
});

test("rule 3 rejects a sentence over the beat limit (40 characters) and ignores the 34-character target", () => {
  // Given: 40자(통과)와 41자(거부)
  const forty = `${"가".repeat(36)}했어요.`;
  const fortyOne = `${"가".repeat(37)}했어요.`;
  expect([...forty].length).toBe(40);
  expect([...fortyOne].length).toBe(41);
  expect(has(copyProblems(withText(BASE_LINES, 3, forty), ctx).hard, "자입니다")).toBe(false);
  const result = copyProblems(withText(BASE_LINES, 3, fortyOne), ctx);
  expect(has(result.hard, '4번째 문장(④ 해결 조건) "')).toBe(true);
  expect(has(result.hard, "41자입니다. 한 문장은 한 호흡(40자 이내)")).toBe(true);
  // 34자 초과 40자 이하는 거부도 경고도 아니다
  const long = withText(BASE_LINES, 3, `${"가".repeat(35)}해요.`);
  expect(has(copyProblems(long, ctx).hard, "자입니다")).toBe(false);
  expect(has(copyProblems(long, ctx).soft, "자입니다")).toBe(false);
});

test("rule 4 rejects a sentence count or reading time out of range and warns when the target is far", () => {
  // 문장 수 5개 → 범위 밖(6~10)
  const five = copyProblems(BASE_LINES.slice(0, 5), ctx);
  expect(has(five.hard, "문장이 5개입니다. 6~10개로 맞추세요")).toBe(true);
  // 읽는 시간 30초 미만: 문장 수는 범위 안(8개)이지만 짧다
  const short: CopyLine[] = [
    { chainStep: "pain", text: "싸게 샀는데 속았어요." },
    { chainStep: "pain", text: "또 속은 기분이죠." },
    { chainStep: "real_cause", text: "속 기름이 달라요." },
    { chainStep: "requirement", text: "원재료를 읽으면 돼요." },
    { chainStep: "product_fact", text: "퓨어는 섞지 않았어요." },
    { chainStep: "reason_why", text: "스페인산 올리브유거든요." },
    { chainStep: "outcome", text: "이제 보고 고르죠." },
    { chainStep: "cta", text: "읽어 보세요." },
  ];
  const tooShort = copyProblems(short, ctx);
  expect(has(tooShort.hard, "읽는 시간이 약")).toBe(true);
  expect(has(tooShort.hard, "문장을 자르지 말고 수를 조절하세요(문장을 더하세요)")).toBe(true);
  expect(has(tooShort.hard, "(문장 8개)")).toBe(true);
  // 읽는 시간 60초 초과: 33자 문장 10개(330자 / 5.5 = 60초 + 간격 4.5초)
  const filler = "원재료명을 꼼꼼히 읽어 보는 습관이 생겨서 마음이 놓여요.";
  const longSteps: CopyLine[] = [
    ...BASE_LINES.slice(0, 7),
    { chainStep: "bridge", text: "" },
    { chainStep: "bridge", text: "" },
    { chainStep: "cta", text: "" },
  ];
  const longLines: CopyLine[] = longSteps.map((line, index) => ({
    ...line,
    text: `${"가나다라마바사아자차"[index] ?? "가"}${filler}`,
  }));
  const tooLong = copyProblems(longLines, ctx);
  expect(has(tooLong.hard, "문장을 빼세요")).toBe(true);
  // 목표 길이와 8초 넘게 다르면 경고만(합격 예시는 약 45초)
  expect(has(copyProblems(BASE_LINES, { ...ctx, durationTargetSec: 30 }).soft, "목표 30초")).toBe(
    true,
  );
  expect(copyProblems(BASE_LINES, { ...ctx, durationTargetSec: 50 }).soft).toEqual([]);
});

test("rule 5 rejects more than one requirement sentence", () => {
  // Given: 해결 조건(④)이 두 문장
  const lines = insertAt(BASE_LINES, 4, {
    chainStep: "requirement",
    text: "그리고 만든 곳도 같이 보면 돼요.",
  });
  // Then
  const result = copyProblems(lines, ctx);
  expect(
    has(result.hard, "해결 조건(④) 문장이 2개(4·5번째)입니다. 조건은 한 문장으로 쓰세요"),
  ).toBe(true);
});

test("rule 6 rejects Latin letters, memo and source markers, and sentences that do not end in a predicate", () => {
  // 영문 상품명
  const latin = copyProblems(withText(BASE_LINES, 4, "Chong Kun Dang 퓨어는 섞지 않았어요."), ctx);
  expect(has(latin.hard, '5번째 문장(⑤ 우리 상품의 사실) "Chong Kun Dang')).toBe(true);
  expect(has(latin.hard, "영문이 있습니다")).toBe(true);
  // 출처·메모 표기
  expect(
    has(copyProblems(withText(BASE_LINES, 2, "출처는 자료에 있어요."), ctx).hard, "메모·출처 표기"),
  ).toBe(true);
  expect(
    has(copyProblems(withText(BASE_LINES, 2, "예: 속 기름이 달라요."), ctx).hard, "메모·출처 표기"),
  ).toBe(true);
  // 명사·조사 종결
  for (const text of ["원재료명 확인.", "이름 말고 원재료를", "원료를 비교했음."]) {
    const result = copyProblems(withText(BASE_LINES, 6, text), ctx);
    expect(has(result.hard, '7번째 문장(결과·변화) "')).toBe(true);
    expect(has(result.hard, "서술어 없이 명사·조사로 끝납니다")).toBe(true);
  }
  // 합격 예시의 서술어 종결(~죠/~요/~세요)은 통과
  expect(has(copyProblems(BASE_LINES, ctx).hard, "서술어")).toBe(false);
});

test("rule 7 rejects two or more near-duplicate sentence pairs and warns about one", () => {
  // Given: 3번째 문장의 거의 같은 되풀이를 4번째 자리에 둔다(해결 조건 대신 같은 진짜 원인)
  const [a, b, c, ...rest] = BASE_LINES;
  if (!a || !b || !c) throw new TypeError("fixture lines");
  const repeatOfThird = `${c.text.replace(/\.$/, "")}, 정말요.`;
  expect(sentenceSimilarity(c.text, repeatOfThird)).toBeGreaterThanOrEqual(0.6);
  const onePair = copyProblems(
    [a, b, c, { chainStep: "real_cause", text: repeatOfThird }, ...rest],
    ctx,
  );
  // Then: 1쌍은 경고(번호 쌍 포함), 거부 아님
  expect(has(onePair.soft, "3·4번째 문장이 거의 같은 말")).toBe(true);
  expect(has(onePair.hard, "되풀이한 문장 쌍")).toBe(false);
  // 2쌍이면 거부: 첫 고통 문장도 되풀이한다
  const repeatOfFirst = `${a.text.replace(/\.$/, "")}, 진짜로요.`;
  expect(sentenceSimilarity(a.text, repeatOfFirst)).toBeGreaterThanOrEqual(0.6);
  const twoPairs = copyProblems(
    [
      a,
      { chainStep: "pain", text: repeatOfFirst },
      c,
      { chainStep: "real_cause", text: repeatOfThird },
      ...rest,
    ],
    ctx,
  );
  expect(has(twoPairs.hard, "되풀이한 문장 쌍이 2쌍(1·2번째, 3·4번째)")).toBe(true);
});

test("rule 8 requires the call to action to end with an imperative or invitation and warns on verification words", () => {
  // 권유·명령 종결은 통과
  for (const text of ["오늘 한번 비교해 보세요.", "지금 골라 보세요.", "지금 시작해요."]) {
    expect(has(copyProblems(withText(BASE_LINES, 7, text), ctx).hard, "행동을 권하는")).toBe(false);
  }
  // 서술형 종결은 거부
  const declarative = copyProblems(withText(BASE_LINES, 7, "지금 원재료를 읽는 중이에요."), ctx);
  expect(has(declarative.hard, '8번째 문장(행동) "지금 원재료를 읽는 중이에요.')).toBe(true);
  expect(has(declarative.hard, "행동을 권하는 말로 끝나지 않습니다")).toBe(true);
  // 검증 낱말은 경고(거부 아님)
  const verify = copyProblems(withText(BASE_LINES, 7, "상세페이지를 확인하세요."), ctx);
  expect(verify.hard).toEqual([]);
  expect(has(verify.soft, "검증 낱말")).toBe(true);
});

// --- 장면 ---------------------------------------------------------------------------------------------------------
const hypothesis = (() => {
  const item = sourcePlanResponse("fact-1").hypotheses[0];
  if (!item) throw new TypeError("Missing test hypothesis");
  return item;
})();
const scriptCtx = { number: 1, hypothesisId: hypothesis.id, targetSec: 36, hasCardSlides: false };
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true };
type Cut = VideoScript["cuts"][number];
type CutPatch = Partial<Cut> & { readonly len?: number };

// 혼합형 픽스처 → 카피 먼저 흐름 대본. 문장 1~3 은 컷 하나(2.5~3초)에 묶여 있어 규칙 11 이 5.5자/초로는 걸리므로(원본) 합격본은 문장을 줄인다.
function copyFirstScript(): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), scriptCtx);
  return VideoScriptSchema.parse({
    ...script,
    flow: "copy_first",
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
}
const SHORT_SENTENCES = ["아침 영양제, 고민되시죠?", "좋은 줄만 알았어요.", "차이는 원료예요."];
function passingScript(): VideoScript {
  const script = copyFirstScript();
  return {
    ...script,
    voiceover: script.voiceover.map((voice, index) => ({
      ...voice,
      text: SHORT_SENTENCES[index] ?? voice.text,
    })),
  };
}
// 컷 일부를 고치고(len 은 컷 길이) 시간을 처음부터 다시 이어 붙인다. 영상 길이는 컷 합계.
function edit(script: VideoScript, patches: Readonly<Record<number, CutPatch>>): VideoScript {
  let at = 0;
  const cuts = script.cuts.map((cut, index) => {
    const { len, ...patch } = patches[index] ?? {};
    const length = len ?? cut.endSec - cut.startSec;
    const next = { ...cut, ...patch, startSec: at, endSec: at + length };
    at += length;
    return next;
  });
  return { ...script, cuts, durationSec: at };
}
const scene = (script: VideoScript) => sceneProblemsV2(script, expected);
const withInfoLines = (script: VideoScript, id: "I1" | "I2", infoLines: string[]): VideoScript => ({
  ...script,
  infoClips: script.infoClips.map((clip) => (clip.id === id ? { ...clip, infoLines } : clip)),
});

test("sceneProblemsV2 passes the hybrid fixture once its sentences fit their cuts", () => {
  // Given: 혼합형 픽스처에서 문장 1~3 만 짧게 줄인 대본
  // Then: hard·soft 모두 없다
  expect(scene(passingScript())).toEqual({ hard: [], soft: [] });
});

test("sceneProblemsV2 rule 11 rejects a sentence that needs more time than its cuts give", () => {
  // Given: 원본 픽스처(문장 1~3 이 컷 하나에 묶인 19·16·17자)
  const result = scene(copyFirstScript());
  // Then: 필요한 초와 컷의 초가 메시지에 있고 다른 규칙은 걸리지 않는다
  expect(result.hard).toEqual([
    '문장 1("아침마다 영양제 고르기 고…")은 3.8초가 필요한데 컷[0~0]은 3초입니다 — 컷을 더 주세요.',
    '문장 2("비싼 게 좋은 줄만 알았어…")은 3.2초가 필요한데 컷[1~1]은 2.5초입니다 — 컷을 더 주세요.',
    '문장 3("진짜 차이는 캡슐 속 원료…")은 3.4초가 필요한데 컷[2~2]은 2.5초입니다 — 컷을 더 주세요.',
  ]);
  // 문장 범위가 겹치면 거부
  const script = copyFirstScript();
  const overlapped: VideoScript = {
    ...script,
    voiceover: script.voiceover.map((voice, index) =>
      index === 1 ? { ...voice, fromCut: 0, toCut: 1 } : voice,
    ),
  };
  expect(has(scene(overlapped).hard, "앞 문장과 겹치거나 순서가 거꾸로")).toBe(true);
});

test("sceneProblemsV2 rule 1 rejects undeclared ids and warns about declared but unused ones", () => {
  const base = passingScript();
  // 선언하지 않은 클립·정지 이미지
  const unknown = edit(base, { 9: { stillId: "S9" }, 0: { veoClip: "E" } });
  expect(has(scene(unknown).hard, '선언하지 않은 정지 이미지 "S9"')).toBe(true);
  expect(has(scene(unknown).hard, '선언하지 않은 클립 "E"')).toBe(true);
  // 선언만 하고 안 쓴 정지 이미지는 경고
  const unused: VideoScript = {
    ...base,
    stills: [
      ...base.stills,
      { id: "S2", prompt: "Photographic still of a pharmacy shelf, daylight." },
    ],
  };
  expect(scene(unused).hard).toEqual([]);
  expect(has(scene(unused).soft, "선언한 정지 이미지 S2를 쓰는 컷이 없습니다")).toBe(true);
  // 설명 ID 를 Veo 목록에 넣거나 같은 ID 를 두 번 선언하면 거부
  const [clipA] = base.veoClips;
  if (!clipA) throw new TypeError("fixture clip");
  expect(
    has(scene({ ...base, veoClips: [...base.veoClips, { ...clipA, id: "A" }] }).hard, "중복 선언"),
  ).toBe(true);
});

test("sceneProblemsV2 rule 2 rejects broken cut timing and lengths outside 30 to 60 seconds", () => {
  const base = passingScript();
  // 컷 시간이 끊김
  const gap: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) => (index === 4 ? { ...cut, endSec: cut.endSec + 0.5 } : cut)),
  };
  expect(has(scene(gap).hard, "컷 시간이 이어지지 않습니다")).toBe(true);
  // 합계와 영상 길이 불일치
  expect(has(scene({ ...base, durationSec: 40 }).hard, "컷 합계가 36초인데 영상 길이는 40초")).toBe(
    true,
  );
  // 30초 미만
  const short: VideoScript = {
    ...base,
    cuts: base.cuts.slice(0, 8).map((cut) => cut),
    durationSec: 24,
  };
  expect(has(scene(short).hard, "길이 24초는 허용 범위 30~60초 밖")).toBe(true);
});

test("sceneProblemsV2 rule 3 rejects a clip read longer than 8 seconds, past its end, or twice over the same range", () => {
  const base = passingScript();
  // 같은 클립 A 를 13초 읽음(합계 8초 초과)
  const long = edit(base, {
    11: { veoClip: "A", phase: "mid" },
    12: { veoClip: "A", phase: "late" },
  });
  expect(has(scene(long).hard, "겹쳐 읽습니다(조립 기준)")).toBe(true);
  // early 컷이 4초면 조립은 mid·late 를 밀어서 이어 읽는다(겹침 아님, 끝 꼬리 1초 이내 허용) → 통과. 5.5초면 꼬리가 1초를 넘어 거부.
  const pushed = edit(base, { 0: { len: 4 } });
  expect(has(scene(pushed).hard, "겹쳐 읽습니다(조립 기준)")).toBe(false);
  // early 5.5초면 late 컷이 mid 와 같은 구간(5.5~8초)을 2.5초 겹쳐 읽는다 → hard(1초 초과)
  const overlap = edit(base, { 0: { len: 5.5 } });
  expect(has(scene(overlap).hard, "겹쳐 읽습니다(조립 기준)")).toBe(true);
  // 합계는 8초지만 late 구간 컷이 클립 끝(8초)을 넘음
  // late 3초 컷은 조립이 0.5초 당겨 읽는다(0.5초 반복) → 1초 이하라 soft, hard 아님(2026-10-09 완화)
  const past = edit(base, { 12: { len: 3 } });
  expect(has(scene(past).hard, "겹쳐 읽습니다")).toBe(false);
  expect(has(scene(past).soft, "겹쳐 읽습니다")).toBe(true);
});

test("sceneProblemsV2 rule 4 requires one phase and at most 4 seconds for explainer cuts", () => {
  const base = passingScript();
  const noPhase = edit(base, { 3: { phase: "" } });
  expect(has(scene(noPhase).hard, "컷 3(I1 클립, 8~11초)에 구간(phase)이 없습니다")).toBe(true);
  const long = edit(base, { 4: { len: 4.5 } });
  expect(has(scene(long).hard, "설명 컷은 4초 이하입니다")).toBe(true);
});

test("sceneProblemsV2 rule 5 caps the declared clips, stills and explainer clips", () => {
  const base = passingScript();
  const [clipA] = base.veoClips;
  const [still] = base.stills;
  const [info] = base.infoClips;
  if (!clipA || !still || !info) throw new TypeError("fixture declarations");
  const many: VideoScript = {
    ...base,
    veoClips: [
      ...base.veoClips,
      { ...clipA, id: "C" },
      { ...clipA, id: "D" },
      { ...clipA, id: "E" },
    ],
    stills: [
      ...base.stills,
      { ...still, id: "S2" },
      { ...still, id: "S3" },
      { ...still, id: "S4" },
    ],
    infoClips: [...base.infoClips, { ...info, id: "I3" }, { ...info, id: "I3" }],
  };
  const result = scene(many);
  expect(has(result.hard, "Veo 클립은 영상 1편에 4개까지입니다(A~D)")).toBe(true);
  expect(has(result.hard, "정지 이미지는 영상 1편에 3장까지입니다")).toBe(true);
  expect(has(result.hard, "설명 컷은 영상 1편에 3개까지입니다")).toBe(true);
});

test("sceneProblemsV2 rule 6 keeps pain, cause, outcome and cta beats live and the first and last cuts live", () => {
  const base = passingScript();
  // 고통 문장(1번째)의 컷이 설명 컷
  const pain = edit(base, { 0: { veoClip: "I1" } });
  expect(
    has(scene(pain).hard, '1번째 문장(① 고통) "아침 영양제, 고민되시죠?"의 컷 0(I1 클립'),
  ).toBe(true);
  // 승인 이미지는 결과 문장(7번째)에는 안 되고 행동 문장에는 된다(픽스처 엔딩)
  const outcome = edit(base, { 9: { source: "approved_image", stillId: "" } });
  expect(has(scene(outcome).hard, "7번째 문장(결과·변화)")).toBe(true);
  expect(scene(base).hard).toEqual([]);
  // 첫 컷이 승인 이미지(사람·상황이 없음)
  const first = edit(base, { 0: { source: "approved_image", veoClip: "" } });
  expect(has(scene(first).hard, "컷 0(대표 이미지, 0~3초): 첫 컷은 사람·상황이 보이는 실사")).toBe(
    true,
  );
  // 마지막 컷이 설명 장면
  const last = edit(base, { 13: { source: "veo_clip", veoClip: "I2", phase: "late" } });
  expect(has(scene(last).hard, "마지막 컷은 실사여야 합니다")).toBe(true);
  // 글자 패널 컷 금지
  const panel = edit(base, { 12: { source: "motion_graphic", veoClip: "", phase: "" } });
  expect(has(scene(panel).hard, "글자 패널(motion_graphic) 컷을 쓰지 않습니다")).toBe(true);
});

test("sceneProblemsV2 rule 7 starts a comparison explainer at the early phase", () => {
  const base = passingScript();
  const result = scene(edit(base, { 6: { phase: "mid" } }));
  expect(has(result.hard, "설명 장면 I2(비교)의 첫 컷 컷 6(I2 클립, 16~19초)이 mid 구간")).toBe(
    true,
  );
});

test("sceneProblemsV2 rule 8 keeps INFO lines at 1 to 4 lines of 24 characters with facts-only numbers", () => {
  const base = passingScript();
  expect(has(scene(withInfoLines(base, "I1", [])).hard, "INFO 문구가 0줄입니다")).toBe(true);
  expect(
    has(
      scene(withInfoLines(base, "I1", ["가", "나", "다", "라", "마"])).hard,
      "INFO 문구가 5줄입니다",
    ),
  ).toBe(true);
  expect(
    has(scene(withInfoLines(base, "I1", ["가".repeat(25)])).hard, "25자입니다. 24자 이하"),
  ).toBe(true);
  // 영문은 explainerSceneProblems 의 hard 로 거부된다
  expect(has(scene(withInfoLines(base, "I1", ["Olive oil"])).hard, "영문이 있습니다")).toBe(true);
  // 숫자는 사실에 있는 것만: 사실이 없으면 건너뛰고, 있으면 대조한다
  const priced = withInfoLines(base, "I1", ["올리브유 99%"]);
  expect(scene(priced).hard).toEqual([]);
  const withFacts = sceneProblemsV2(priced, { ...expected, facts: ["올리브유 100% 함유"] });
  expect(has(withFacts.hard, "사실에 없는 숫자(99)")).toBe(true);
  const matching = sceneProblemsV2(withInfoLines(base, "I1", ["올리브유 100%"]), {
    ...expected,
    facts: ["올리브유 100% 함유"],
  });
  expect(matching.hard).toEqual([]);
});

test("sceneProblemsV2 rule 9 rejects live prompts that erase people or products", () => {
  const base = passingScript();
  const anchor = scene({ ...base, styleAnchor: `${base.styleAnchor} Empty kitchen, no people.` });
  expect(has(anchor.hard, 'styleAnchor 프롬프트에 실사를 지우는 문구("no people")')).toBe(true);
  const [still] = base.stills;
  if (!still) throw new TypeError("fixture still");
  const stills = scene({
    ...base,
    stills: [{ ...still, prompt: "An unpopulated kitchen at dawn." }],
  });
  expect(has(stills.hard, "정지 이미지 S1 프롬프트에 실사를 지우는 문구")).toBe(true);
  // 설명 세계 기준(explainerAnchor)에는 "no people" 이 있어도 된다
  expect(base.explainerAnchor).toContain("no people");
  expect(has(scene(base).hard, "실사를 지우는")).toBe(false);
});

test("sceneProblemsV2 rule 10 needs an explainer anchor with two brand colors when explainer clips exist", () => {
  const base = passingScript();
  expect(has(scene({ ...base, explainerAnchor: "" }).hard, "explainerAnchor")).toBe(true);
  const oneColor = scene({
    ...base,
    explainerAnchor: "Clay-white world, deep olive accent, no people, no text.",
  });
  expect(has(oneColor.hard, "브랜드 강조색 이름이 2개 이상")).toBe(true);
  // 설명 컷이 없으면 explainerAnchor 는 필요 없다
  const noInfo = scene({ ...base, infoClips: [], explainerAnchor: "" });
  expect(has(noInfo.hard, "explainerAnchor")).toBe(false);
});

test("sceneProblemsV2 rule 12 caps a still cut at 3 seconds and all stills at 6 seconds", () => {
  const base = passingScript();
  // 정지 컷 하나가 4초
  const long = edit(base, { 9: { len: 4 } });
  expect(has(scene(long).hard, "컷 9(정지 이미지, 24~28초)은 정지 이미지 4초입니다")).toBe(true);
  // 정지 컷 3개(2 + 2.5 + 2.5 = 7초)가 합계 6초 초과
  const total = edit(base, {
    1: { source: "still_image", veoClip: "", phase: "", stillId: "S1" },
    2: { source: "still_image", veoClip: "", phase: "", stillId: "S1" },
  });
  expect(has(scene(total).hard, "정지 이미지 컷이 합계 7초입니다")).toBe(true);
  expect(has(scene(total).hard, "한 컷은 3초까지")).toBe(false);
});

test("sceneProblemsV2 rejects a number or hypothesis id that does not match the expectation", () => {
  const base = passingScript();
  expect(has(sceneProblemsV2(base, { ...expected, number: 2 }).hard, "number는 2")).toBe(true);
});

test("classifyScriptProblems hands copy_first scripts to the v2 scene rules and keeps the old rules otherwise", () => {
  // Given: 같은 대본을 두 흐름으로
  const copyFirst = copyFirstScript();
  const legacy: VideoScript = { ...copyFirst, flow: "" };
  // Then: copy_first 는 v2 결과를 그대로 돌려준다
  expect(classifyScriptProblems(copyFirst, expected)).toEqual(sceneProblemsV2(copyFirst, expected));
  expect(classifyScriptProblems(copyFirst, expected).hard.length).toBe(3);
  // 예전 흐름은 규칙 11 이 없는 예전 규칙을 쓴다
  expect(classifyScriptProblems(legacy, expected)).not.toEqual(
    sceneProblemsV2(copyFirst, expected),
  );
  expect(has(classifyScriptProblems(legacy, expected).hard, "컷을 더 주세요")).toBe(false);
  // 문장을 줄인 대본은 v2 로 hard 가 없다
  expect(classifyScriptProblems(passingScript(), expected).hard).toEqual([]);
});
