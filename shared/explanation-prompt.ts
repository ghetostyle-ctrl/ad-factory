import type { ExplanationPlan } from "./explanation-plan";

export function explanationLabels(plan: ExplanationPlan): string[] {
  return [...new Set(plan.annotations.map((annotation) => annotation.label))];
}

// 설명 계약 문단(instructions/flow.md EXPLANATION_CONTRACT_INTRO) + <explanation-plan> JSON. JSON 골격은 코드다.
export function explanationPrompt(
  plan: ExplanationPlan | null | undefined,
  contractIntro: string,
): string {
  if (!plan) return "";
  return [contractIntro, "<explanation-plan>", JSON.stringify(plan), "</explanation-plan>"].join(
    "\n",
  );
}
