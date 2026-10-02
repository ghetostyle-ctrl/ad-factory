import type { CreativeFormat, CreativePlan } from "../shared/creative-plan";
import type { ProjectSource, ProjectSourceSnapshot } from "../shared/sources";
import { StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";

export function factualSources(snapshot: ProjectSourceSnapshot): ProjectSource[] {
  return snapshot.sources.filter(
    (source) =>
      ["product_fact", "offer"].includes(source.kind) &&
      source.evidence === "observed" &&
      source.contentStatus === "content" &&
      source.status === "eligible",
  );
}
// 광고안의 차이는 표현이 아니라 고객의 구매 질문(사는 이유·망설임·확인 기준)에서 나와야 한다.
function validateCustomerQuestions(
  plan: CreativePlan,
  pack: ReturnType<typeof evidencePack>,
  expectedCount: number,
): void {
  const questions = plan.customerQuestions;
  // 고객 질문 설계 이전에 저장된 기획은 재개할 때 그대로 인정한다. 새 기획은 응답 스키마가 질문을 강제한다.
  if (!questions.length && plan.hypotheses.every((item) => !item.customerQuestionId)) return;
  const questionIds = new Set(questions.map((item) => item.id));
  if (!questions.length || questionIds.size !== questions.length)
    throw new StudioError(
      "customer_questions",
      "고객이 사는 이유·망설임·확인 기준을 서로 다른 질문으로 정리해야 합니다.",
    );
  const factIds = new Set<string>(pack.facts.map((source) => source.id));
  const voiceIds = new Set<string>(pack.voices.map((source) => source.id));
  const referenceIds = new Set<string>(pack.references.map((source) => source.id));
  for (const question of questions) {
    const allowed =
      question.basis === "customer_voice"
        ? voiceIds
        : question.basis === "product_fact"
          ? factIds
          : new Set<string>();
    if (
      (question.basis !== "inferred" && question.sourceIds.length === 0) ||
      question.sourceIds.some((id) => !allowed.has(id))
    )
      throw new StudioError(
        "customer_questions",
        "고객 질문의 근거 자료가 근거 유형과 맞지 않습니다. 근거가 없으면 추정으로 표시해야 합니다.",
      );
    if (question.answeredByReferences.some((id) => !referenceIds.has(id)))
      throw new StudioError(
        "customer_questions",
        "이번 작업에 고정된 레퍼런스만 고객 질문의 기존 답변으로 표시할 수 있습니다.",
      );
  }
  const answered = plan.hypotheses.map((item) => item.customerQuestionId);
  if (answered.some((id) => !id || !questionIds.has(id)))
    throw new StudioError("customer_questions", "광고안마다 답할 고객 질문을 지정해야 합니다.");
  if (!plan.hypotheses.every((item) => item.decisionRole && item.proofShown))
    throw new StudioError(
      "customer_questions",
      "광고안마다 구매 결정에서의 역할과 보여 줄 증거가 필요합니다.",
    );
  const required = Math.min(expectedCount, 3);
  if (new Set(answered).size < required)
    throw new StudioError(
      "diversity",
      `광고안은 최소 ${required}개의 서로 다른 고객 질문에 답해야 합니다. 표현만 바꾼 소재는 다양성이 아닙니다.`,
    );
}
// 같은 메시지도 어느 인식 단계에 두느냐에 따라 스팸이 되거나 전환의 결정타가 된다.
// 단계(TOFU·MOFU·BOFU)마다 맞는 소재 유형과 신호를 강제하고, 오퍼는 등록된 오퍼 자료에서만 쓴다.
const formatStages: Record<CreativeFormat, readonly string[]> = {
  problem_empathy: ["need_awareness"],
  mechanism_explainer: ["comparison"],
  review_proof: ["comparison", "final_decision"],
  benefit_offer: ["final_decision"],
  risk_reversal: ["final_decision"],
};
const guaranteePattern =
  /환불|보증|반품|무료\s*체험|체험\s*후|guarantee|refund|money[-\s]?back|trial/i;
function validateFunnelSignals(
  plan: CreativePlan,
  pack: ReturnType<typeof evidencePack>,
  expectedCount: number,
): void {
  // 신호 설계 이전에 저장된 기획은 재개할 때 그대로 인정한다. 새 기획은 응답 스키마가 신호를 강제한다.
  if (plan.hypotheses.every((item) => !item.signals)) return;
  const offerIds = new Set<string>(
    pack.facts.filter((source) => source.kind === "offer").map((source) => source.id),
  );
  const hasVoices = pack.voices.length > 0;
  const hasGuarantee = pack.facts.some(
    (source) => source.kind === "offer" && guaranteePattern.test(source.content),
  );
  for (const hypothesis of plan.hypotheses) {
    const signals = hypothesis.signals;
    if (!signals || !hypothesis.decisionRole)
      throw new StudioError("funnel", "광고안마다 인식 단계와 소재 신호가 필요합니다.");
    if (!formatStages[signals.format].includes(hypothesis.decisionRole))
      throw new StudioError(
        "funnel",
        "소재 유형이 인식 단계와 맞지 않습니다. 문제 제기형은 TOFU, 메커니즘 설명형은 MOFU, 혜택·리스크 제거형은 BOFU입니다.",
      );
    if (hypothesis.decisionRole !== "final_decision" && signals.offer.type !== "none")
      throw new StudioError(
        "funnel",
        "할인·체험·보증 같은 직접 오퍼는 BOFU(구매 직전) 광고안에만 씁니다. 제품을 모르는 단계에서는 스팸이 됩니다.",
      );
    if (hypothesis.decisionRole === "need_awareness" && signals.mechanism.mode === "social_proof")
      throw new StudioError(
        "funnel",
        "TOFU 광고안은 고객의 문제와 우리만의 해결 방식(메커니즘·원인 재해석)을 보여 줘야 합니다.",
      );
    if (
      signals.format === "benefit_offer" &&
      ["none", "risk_reversal"].includes(signals.offer.type)
    )
      throw new StudioError("funnel", "혜택 강조형 소재에는 혜택 오퍼가 필요합니다.");
    if (signals.format === "risk_reversal" && signals.offer.type !== "risk_reversal")
      throw new StudioError(
        "funnel",
        "리스크 제거 소재에는 환불·보증 같은 리스크 제거 조건이 필요합니다.",
      );
    if (signals.offer.type !== "none") {
      if (!signals.offer.statement) throw new StudioError("funnel", "오퍼 내용을 적어야 합니다.");
      if (!hypothesis.claimCitations.some((citation) => offerIds.has(citation.sourceId)))
        throw new StudioError(
          "funnel",
          "오퍼는 자료 라이브러리에 등록한 오퍼 자료(할인·번들·체험·보증)를 근거로만 쓸 수 있습니다.",
        );
    }
    if (
      (signals.format === "review_proof" || signals.mechanism.mode === "social_proof") &&
      !hasVoices
    )
      throw new StudioError(
        "funnel",
        "사용자 리뷰·비포애프터 소재는 실제 고객 후기 자료가 있을 때만 만들 수 있습니다.",
      );
  }
  if (expectedCount < 3) return;
  const stages = new Set<string | undefined>(plan.hypotheses.map((item) => item.decisionRole));
  const bofuPossible = offerIds.size > 0 || hasVoices;
  const requiredStages = ["need_awareness", "comparison"];
  if (bofuPossible) requiredStages.push("final_decision");
  for (const stage of requiredStages)
    if (!stages.has(stage))
      throw new StudioError(
        "funnel",
        "한 세트 안에 TOFU·MOFU·BOFU 단계 소재가 모두 있어야 합니다. 같은 오디언스 안에도 인식 단계가 다른 사람이 섞여 있습니다.",
      );
  if (expectedCount < 5) return;
  const feasible = new Set<CreativeFormat>(["problem_empathy", "mechanism_explainer"]);
  if (hasVoices) feasible.add("review_proof");
  if (offerIds.size > 0) feasible.add("benefit_offer");
  if (hasGuarantee) feasible.add("risk_reversal");
  const formats = new Set(plan.hypotheses.map((item) => item.signals?.format));
  const missing = [...feasible].filter((format) => !formats.has(format));
  if (missing.length)
    throw new StudioError(
      "funnel",
      "광고안 5개 이상이면 문제 제기형·메커니즘 설명형·리뷰·혜택 강조·리스크 제거 소재를 자료가 허락하는 만큼 모두 편성해야 합니다.",
    );
}
export function validatePlanEvidence(
  plan: CreativePlan,
  snapshot: ProjectSourceSnapshot,
  expectedCount = 3,
): void {
  if (plan.sourceDigest !== snapshot.digest)
    throw new StudioError("source_digest", "기획의 자료 스냅샷이 일치하지 않습니다.");
  const pack = evidencePack(snapshot);
  const facts = pack.facts;
  if (JSON.stringify(plan.sourceCoverage) !== JSON.stringify(pack.coverage))
    throw new StudioError(
      "source_coverage",
      "기획에 사용한 자료 범위가 고정 자료와 일치하지 않습니다.",
    );
  if (
    plan.referenceAnalyses.length !== pack.references.length ||
    new Set(plan.referenceAnalyses.map((item) => item.sourceId)).size !== pack.references.length ||
    plan.referenceAnalyses.some(
      (item) => !pack.references.some((source) => source.id === item.sourceId),
    )
  )
    throw new StudioError(
      "reference",
      "레퍼런스 관찰이 이번 작업의 본문 자료 범위와 일치하지 않습니다.",
    );
  if (!facts.length)
    throw new StudioError("source_facts", "확인된 제품 사실 또는 오퍼 본문 자료가 필요합니다.");
  const ids = new Set(plan.hypotheses.map((item) => item.id));
  if (
    plan.hypotheses.length !== expectedCount ||
    ids.size !== expectedCount ||
    new Set(plan.hypotheses.map((item) => item.angle)).size < Math.min(expectedCount, 3)
  )
    throw new StudioError("diversity", `서로 다른 고객 가설 ${expectedCount}개가 필요합니다.`);
  for (const field of [
    "targetAudience",
    "customerSituation",
    "problem",
    "message",
    "visualMechanism",
    "hook",
  ] as const)
    if (
      new Set(
        plan.hypotheses.map((item) =>
          item[field].normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
        ),
      ).size !== expectedCount
    )
      throw new StudioError(
        "diversity",
        "타깃 오디언스·고객 상황·문제·메시지·시각 구성·훅이 중복됩니다.",
      );
  validateCustomerQuestions(plan, pack, expectedCount);
  validateFunnelSignals(plan, pack, expectedCount);
  for (const hypothesis of plan.hypotheses) {
    if (pack.references.length > 0 && hypothesis.referenceSourceIds.length === 0)
      throw new StudioError(
        "reference",
        "레퍼런스가 있는 프로젝트에서는 광고안마다 참고한 광고 구조를 표시해야 합니다.",
      );
    for (const id of hypothesis.referenceSourceIds)
      if (
        !plan.referenceAnalyses.some(
          (item) => item.sourceId === id && item.observedStructure.length > 0,
        )
      )
        throw new StudioError("reference", "본문을 관찰한 레퍼런스만 제작에 참고할 수 있습니다.");
  }
}
