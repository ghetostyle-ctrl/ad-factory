import type { CreativePlan } from "../shared/creative-plan";
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
