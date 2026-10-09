import { expect, test } from "bun:test";
import type { PersuasionChain } from "../shared/creative-plan";
import {
  chainExpectation,
  customerKnowsProblem,
  keyWords,
  sharesKeyWord,
} from "../shared/persuasion-chain";
import { chainProblems } from "../shared/script-rules";
import type { VideoScript } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";

// 설득 사슬 대본 규칙(사용자 결정 2026-10-06). 실전 영상 3의 대본("먼저 기준을 확인해볼게요", "표기를 확인해 보세요",
// 600mg·100%·오일 나열)이 왜 설득력이 없었는지를 규칙으로 잡는다.
const chain: PersuasionChain = {
  pain: {
    content: "출근 준비하다 보면 깜빡해서 한 통을 다 못 먹었어요",
    basis: "customer_voice",
    sourceIds: ["v1"],
  },
  believedCause: { content: "바빠서", basis: "customer_voice", sourceIds: ["v1"] },
  realCause: {
    content: "챙길 때마다 번거로우면 미루고, 미루면 잊는다",
    basis: "general_knowledge",
    sourceIds: [],
  },
  requirement: { content: "하루 한 번, 한 알로 끝나야 한다", basis: "inferred", sourceIds: [] },
  productFact: { content: "하루 1알로 충분", basis: "product_fact", sourceIds: ["f1"] },
  reasonWhy: {
    content: "한 알에 엑스트라 버진 올리브유 100%, 600밀리그램",
    basis: "product_fact",
    sourceIds: ["f1"],
  },
  outcome: { content: "한 통을 끝까지, 매일 챙긴다", basis: "inferred", sourceIds: [] },
  exclusivity: "product_specific",
};
const desireTexts = ["간단히 챙겨서 매일 섭취하고 싶다", "바쁘면 깜빡해 한 통을 다 못 먹는다"];
type Step = VideoScript["voiceover"][number]["chainStep"];
type Line = readonly [Step, string];
function script(lines: readonly Line[]): VideoScript {
  const base = renderScript(1, "concept-1", 36);
  return {
    ...base,
    voiceover: lines.map(([chainStep, text], index) => ({
      startSec: index * 4,
      endSec: index * 4 + 4,
      fromCut: index,
      toCut: index,
      purpose: "story" as const,
      chainStep,
      text,
      callouts: [],
    })),
  };
}
const good: readonly Line[] = [
  ["pain", "바쁘면 깜빡해서 한 통도 못 먹었죠?"],
  ["believed_cause", "바빠서 그런 줄 알았죠?"],
  ["real_cause", "챙길 때마다 번거로우니 미루죠."],
  ["real_cause", "미루다 보니 잊는 거예요."],
  ["requirement", "하루 한 번, 한 알로 끝나야 해요."],
  ["product_fact", "이건 하루 한 알이면 충분해요."],
  ["reason_why", "한 알에 600밀리그램을 담았거든요."],
  ["reason_why", "엑스트라 버진 올리브유 100%니까요."],
  ["outcome", "이번엔 매일, 한 통을 끝까지 챙겨요."],
  ["cta", "지금 드시는 것과 비교해 보세요."],
];
const hypothesis = sourcePlanResponse("f1").hypotheses[0];
if (!hypothesis) throw new Error("fixture hypothesis");
const expected = { chain, desireTexts, hypothesis };
const replace = (step: Step, text: string): Line[] =>
  good.map(([at, original]) => (at === step ? [at, text] : [at, original]));

test("a script that argues the whole chain in order passes", () => {
  const result = chainProblems(script(good), expected);
  expect(result.hard).toEqual([]);
  expect(result.soft).toEqual([]);
});

test("old scripts without chain steps are not checked", () => {
  const old = script(good.map(([, text]): Line => ["", text]));
  expect(chainProblems(old, expected)).toEqual({ hard: [], soft: [] });
});

test("the real video 3 script is rejected for the reasons the user named", () => {
  const video3 = script([
    ["pain", "출근 준비하다 보면 자꾸 깜빡해서 한 통을 다 못 먹었어요."],
    ["requirement", "먼저, 하루 한 알로 충분한지 기준을 확인해볼게요."],
    ["product_fact", "제품 안내에는 '하루 한 캡슐' 복용을 권장하고 있어요."],
    ["reason_why", "한 캡슐, 육백밀리그램—캡슐이라 오일이 입에 닿지 않아 깔끔합니다."],
    ["bridge", "원재료에는 '엑스트라 버진 올리브유 30%'로 표기되어 있습니다."],
    ["outcome", "아침에 물 한 컵과 한 알이면 끝나요."],
    ["cta", "마지막으로 제품 상세에서 '하루 한 캡슐'과 '캡슐 제형' 표기를 확인해 보세요."],
  ]);
  const text = chainProblems(video3, expected).hard.join("\n");
  expect(text).toContain("진짜 원인");
  expect(text).toContain("진행·설명서 멘트");
  expect(text).toContain("확인·표기·라벨·상세페이지");
  expect(text).toContain("사슬 밖 숫자 30");
});

test("order, adjacency of ⑤→⑥, first pain and last cta are enforced", () => {
  const swapped = [...good];
  const factIndex = good.findIndex(([step]) => step === "product_fact");
  const reasonIndex = factIndex + 1;
  const fact = swapped[factIndex];
  const reason = swapped[reasonIndex];
  if (fact && reason) {
    swapped[factIndex] = reason;
    swapped[reasonIndex] = fact;
  }
  expect(chainProblems(script(swapped), expected).hard.join(" ")).toContain("사슬 순서를 거슬렀");
  const apart: Line[] = [
    ...good.slice(0, reasonIndex),
    ["bridge", "잠깐만요."],
    ...good.slice(reasonIndex),
  ];
  expect(chainProblems(script(apart), expected).hard.join(" ")).toContain("바로 다음 문장");
  expect(chainProblems(script(good.slice(0, -1)), expected).hard.join(" ")).toContain(
    "행동 문장이 없습니다",
  );
});

test("the outcome must echo the customer's desire words and the cta carries no digits", () => {
  const invented = replace("outcome", "찜찜함 없이 안심으로 아침이 시작돼요.");
  expect(chainProblems(script(invented), expected).hard.join(" ")).toContain("욕망·고통의 낱말");
  const digits = replace("cta", "600밀리그램, 지금 시작해 보세요.");
  expect(chainProblems(script(digits), expected).hard.join(" ")).toContain("숫자를 넣지 않습니다");
});

test("missing reason connector or conditional form and a short solution part are warnings", () => {
  const flat = good.map(([step, text]): Line => {
    if (step === "reason_why") return [step, "600밀리그램."];
    if (step === "requirement") return [step, "하루에 딱 한 번, 한 알."];
    if (step === "pain")
      return [
        step,
        "출근 준비하다 보면 자꾸 깜빡해서, 한 통을 다 못 먹었죠? 매일 아침 그랬죠? 정말 자주 그랬죠? 또 그랬죠?",
      ];
    return [step, text];
  });
  const { hard, soft } = chainProblems(script(flat), expected);
  expect(hard).toEqual([]);
  expect(soft.join(" ")).toContain("가능한 이유(⑥)");
  expect(soft.join(" ")).toContain("조건문");
  expect(soft.join(" ")).toContain("절반 이상");
});

test("key words, problem awareness and expectation helpers", () => {
  expect([...keyWords("간단히 챙겨서 매일 섭취하고 싶다")]).toEqual([
    "간단",
    "챙겨",
    "매일",
    "섭취",
  ]);
  expect(sharesKeyWord("이번엔 매일 챙기게 돼요", "매일 섭취하고 싶다")).toBe(true);
  expect(sharesKeyWord("찜찜함 없이 안심", "매일 섭취하고 싶다")).toBe(false);
  const plan = sourcePlanResponse("f1");
  expect(customerKnowsProblem(plan.fragments.filter((item) => item.id === "f1"))).toBe(false);
  expect(customerKnowsProblem(plan.fragments.filter((item) => item.id === "f2"))).toBe(true);
  const second = plan.hypotheses[1];
  if (!second) throw new Error("fixture");
  const expectation = chainExpectation(plan, second);
  expect(expectation.chain?.exclusivity).toBe("product_specific");
  expect(expectation.desireTexts?.length).toBe(2);
  expect(chainExpectation(plan, { targetId: "t1" })).toEqual({});
});

test("the reason-why sentence must add a product detail beyond the product-fact sentence", () => {
  const restated = replace("reason_why", "캡슐이라 하루 한 알이면 충분하니까요.");
  expect(chainProblems(script(restated), expected).hard.join(" ")).toContain("⑤)을 되풀이");
});
