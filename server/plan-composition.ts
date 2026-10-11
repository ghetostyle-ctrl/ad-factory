import type { CreativeFormat, CreativePlan } from "../shared/creative-plan";
import { customerKnowsProblem, targetFragments } from "../shared/persuasion-chain";
import type { evidencePack } from "./evidence-pack";

const guaranteePattern =
  /환불|보증|반품|무료\s*체험|체험\s*후|guarantee|refund|money[-\s]?back|trial/i;
export function planCompositionWarnings(
  plan: CreativePlan,
  pack: ReturnType<typeof evidencePack>,
  expectedCount: number,
): string[] {
  if (expectedCount < 3 || plan.hypotheses.every((item) => !item.signals)) return [];
  const offerSources = pack.facts.filter((source) => source.kind === "offer");
  const hasVoices = pack.voices.length > 0;
  const stages = new Set(plan.hypotheses.map((item) => item.decisionRole));
  const required: NonNullable<CreativePlan["hypotheses"][number]["decisionRole"]>[] = [
    "comparison",
  ];
  if (
    !plan.hypotheses.some((item) => item.chain) ||
    (plan.targets ?? []).some((target) => !customerKnowsProblem(targetFragments(plan, target.id)))
  )
    required.unshift("need_awareness");
  if (offerSources.length || hasVoices) required.push("final_decision");
  const names = {
    need_awareness: "관심 끌기(TOFU)",
    comparison: "제품 비교(MOFU)",
    final_decision: "구매 결정(BOFU)",
  } as const;
  const warnings = required
    .filter((stage) => !stages.has(stage))
    .map((stage) => names[stage] + " 광고가 세트에 없습니다.");
  if (expectedCount < 5) return warnings;
  const feasible = new Set<CreativeFormat>(["problem_empathy", "mechanism_explainer"]);
  if (hasVoices) feasible.add("review_proof");
  if (offerSources.length) feasible.add("benefit_offer");
  if (offerSources.some((source) => guaranteePattern.test(source.content)))
    feasible.add("risk_reversal");
  const formats = new Set(plan.hypotheses.map((item) => item.signals?.format));
  const formatNames = {
    problem_empathy: "문제 제기형",
    mechanism_explainer: "메커니즘 설명형",
    review_proof: "리뷰형",
    benefit_offer: "혜택 강조형",
    risk_reversal: "리스크 제거형",
  } as const;
  const missing = [...feasible].filter((format) => !formats.has(format));
  if (missing.length)
    warnings.push(
      "편성 권장 유형이 빠져 있습니다: " + missing.map((format) => formatNames[format]).join(", "),
    );
  return warnings;
}
