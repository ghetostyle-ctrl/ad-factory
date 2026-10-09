import {
  CHAIN_STEP_KEYS,
  type CreativePlan,
  type MarketFragment,
  type PersuasionChain,
} from "./creative-plan";

// 설득 사슬 공용 도우미(사용자 결정 2026-10-06). 서버 기획 검사(source-evidence)와 대본 규칙(script-rules)·화면이 같이 쓴다.

// 결과·변화 문장이 고객이 말한 욕망·고통의 낱말을 되받는지 볼 때 쓰는 낱말 꼴: 공백·문장부호로 자른 토큰의 앞 2글자.
// 한국어 어미 변화("섭취하고 싶다" ↔ "섭취하게")를 거칠게 흡수한다. 뜻이 없는 흔한 낱말은 뺀다.
const STOP = new Set([
  "싶다",
  "싶어",
  "있다",
  "없다",
  "하고",
  "해서",
  "그리고",
  "그래서",
  "하는",
  "하지",
  "것을",
  "것이",
  "이게",
  "제품",
  "상품",
  "우리",
  "내가",
  "너무",
  "정말",
  "진짜",
  "매우",
  "좀",
  "더",
  "the",
  "and",
  "for",
  "with",
]);
export function keyWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...token].length < 2 || STOP.has(token)) continue;
    // 로마자 낱말은 어미 변화가 없으므로 통째로 비교한다(앞 2글자만 보면 "in"처럼 너무 흔하다).
    words.add(/^[a-z0-9]+$/.test(token) ? token : [...token].slice(0, 2).join(""));
  }
  return words;
}
export function sharesKeyWord(text: string, reference: string): boolean {
  const words = keyWords(reference);
  const normalized = text.toLowerCase();
  for (const word of words) if (normalized.includes(word)) return true;
  return false;
}

// 모델이 "없음"·"해당 없음"·"N/A" 처럼 적은 칸은 빈 칸으로 본다(실측 2026-10-06: 그런 값 때문에 실패 경험이 있다고 판정됐다).
const BLANK_ANSWERS =
  /^(없음|없다|없어요|해당\s?없음|해당\s?없다|확인\s?안\s?됨|불명|미상|none|n\/a|na|null|-|—)$/iu;
export function isBlankAnswer(text: string): boolean {
  const value = text.trim().replace(/[.。]$/u, "");
  return value === "" || BLANK_ANSWERS.test(value);
}
// 조각에 실패 경험·현재 대안·믿는 원인이 있으면 고객은 자기 문제를 안다 → TOFU(need_awareness)가 아니다.
export function customerKnowsProblem(fragments: readonly MarketFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      !isBlankAnswer(fragment.failedAttempt) ||
      !isBlankAnswer(fragment.alternative) ||
      !isBlankAnswer(fragment.believedCause),
  );
}
export function customerTriedAndFailed(fragments: readonly MarketFragment[]): boolean {
  return fragments.some((fragment) => !isBlankAnswer(fragment.failedAttempt));
}
// 타겟의 experience 는 조각에서 유도할 수 있으므로 거부 대신 고친다(재작성 기회를 아낀다).
export function normalizePlanTargets<T extends Pick<CreativePlan, "fragments" | "targets">>(
  plan: T,
): T {
  if (!plan.targets) return plan;
  return {
    ...plan,
    targets: plan.targets.map((target) =>
      target.experience === "first_time" && customerTriedAndFailed(targetFragments(plan, target.id))
        ? { ...target, experience: "tried_failed" as const }
        : target,
    ),
  };
}

export function targetFragments(
  plan: Pick<CreativePlan, "fragments" | "targets">,
  targetId: string | undefined,
): MarketFragment[] {
  const target = plan.targets?.find((item) => item.id === targetId);
  if (!target) return [];
  const ids = new Set(target.fragmentIds);
  return (plan.fragments ?? []).filter((fragment) => ids.has(fragment.id));
}
// 결과·변화 문장이 되받아야 하는 고객의 말: 타겟 조각의 욕망·고통.
export function desireTexts(fragments: readonly MarketFragment[]): string[] {
  return fragments.flatMap((fragment) => [fragment.desire, fragment.pain]).filter(Boolean);
}

export function chainTexts(chain: PersuasionChain): string[] {
  return CHAIN_STEP_KEYS.map((key) => chain[key].content).filter(Boolean);
}
// 사슬 안의 숫자 묶음("600", "100", "30"). 내레이션의 숫자는 여기 있는 것만 허용한다(사슬 밖 사실 금지).
export function digitGroups(text: string): Set<string> {
  return new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
}
export function chainDigitGroups(chain: PersuasionChain): Set<string> {
  return digitGroups(chainTexts(chain).join(" "));
}

// 대본 문장이 적는 사슬 칸. bridge 는 사슬에 속하지 않는 연결·분위기 문장(순서 검사에서 무시).
export const SCRIPT_CHAIN_STEPS = [
  "pain",
  "believed_cause",
  "real_cause",
  "requirement",
  "product_fact",
  "reason_why",
  "outcome",
  "cta",
  "bridge",
] as const;
export type ScriptChainStep = (typeof SCRIPT_CHAIN_STEPS)[number];
export const CHAIN_ORDER: readonly ScriptChainStep[] = [
  "pain",
  "believed_cause",
  "real_cause",
  "requirement",
  "product_fact",
  "reason_why",
  "outcome",
  "cta",
];
export const CHAIN_STEP_LABELS: Record<ScriptChainStep, string> = {
  pain: "① 고통",
  believed_cause: "② 믿는 원인",
  real_cause: "③ 진짜 원인",
  requirement: "④ 해결 조건",
  product_fact: "⑤ 우리 상품의 사실",
  reason_why: "⑥ 가능한 이유",
  outcome: "결과·변화",
  cta: "행동",
  bridge: "연결",
};

// 대본 규칙·화면·CLI 가 같은 방식으로 광고안의 사슬 기대치를 만든다.
export function chainExpectation(
  plan: Pick<CreativePlan, "fragments" | "targets"> | null | undefined,
  hypothesis: {
    readonly chain?: PersuasionChain | undefined;
    readonly targetId?: string | undefined;
  },
): { chain?: PersuasionChain; desireTexts?: string[] } {
  if (!hypothesis.chain) return {};
  const fragments = plan ? targetFragments(plan, hypothesis.targetId) : [];
  return { chain: hypothesis.chain, desireTexts: desireTexts(fragments) };
}

// ⑥ "가능한 이유"는 ⑤를 되풀이하면 안 된다(실측 2026-10-06: "캡슐이라 오일이 안 닿고 하루 1회"를 ⑤·⑥에 똑같이 적었다).
// ⑥에는 ⑤에 없는 제품 고유 세부(숫자·함량·원재료·공정·제조사)가 하나 이상 있어야 한다.
const IDENTITY_TERMS =
  /(냉압착|GMP|스페인|이탈리아|그리스|원재료|원산지|종근당|엑스트라\s?버진|extra\s?virgin|100\s?%|섞지|혼합|무첨가|밀리그램|mg|캡슐당|한\s?알에|한\s?캡슐에|함량|제조)/giu;
export function productDetailTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const value of text.match(
    /\d+(?:[.,]\d+)*\s?(?:%|mg|밀리그램|ml|g|캡슐|알|정|통|개|년)?/giu,
  ) ?? [])
    tokens.add(value.replace(/\s+/g, "").toLowerCase());
  for (const value of text.match(IDENTITY_TERMS) ?? [])
    tokens.add(value.replace(/\s+/g, "").toLowerCase());
  return tokens;
}
export function addsProductDetail(reason: string, fact: string): boolean {
  const known = productDetailTokens(fact);
  for (const token of productDetailTokens(reason)) if (!known.has(token)) return true;
  return false;
}
