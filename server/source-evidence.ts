import { type CreativeFormat, type CreativePlan, targetFitScore } from "../shared/creative-plan";
import {
  addsProductDetail,
  customerKnowsProblem,
  customerTriedAndFailed,
  desireTexts,
  sharesKeyWord,
  targetFragments,
} from "../shared/persuasion-chain";
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
// 시장 조각·타겟·해결 과정(CREATIVE-PLANNING-DESIGN.md). 예전 기획(타겟 없음)은 그대로 인정한다.
const SOLUTION_ORDER = [
  "past_attempt",
  "believed_cause",
  "real_cause",
  "criteria",
  "mechanism",
  "verification",
  "outcome",
] as const;
export function validatePlanTargets(
  plan: CreativePlan,
  pack: ReturnType<typeof evidencePack>,
  expectedCount: number,
): void {
  const fragments = plan.fragments ?? [];
  const targets = plan.targets ?? [];
  if (!targets.length && plan.hypotheses.every((item) => !item.targetId)) return;
  const fail = (message: string) => new StudioError("plan_targets", message);
  const factIds = new Set<string>(pack.facts.map((source) => source.id));
  const voiceIds = new Set<string>(pack.voices.map((source) => source.id));
  const referenceIds = new Set<string>(pack.references.map((source) => source.id));
  const fragmentIds = new Set(fragments.map((item) => item.id));
  if (!fragments.length || fragmentIds.size !== fragments.length)
    throw fail(
      "리뷰·레퍼런스에서 뽑은 장면 조각(상황·욕망·불편)이 필요하고 ID가 겹치면 안 됩니다.",
    );
  for (const fragment of fragments) {
    const allowed =
      fragment.origin === "customer_review"
        ? voiceIds
        : fragment.origin === "inferred"
          ? new Set<string>()
          : referenceIds;
    if (
      (fragment.origin !== "inferred" && fragment.sourceIds.length === 0) ||
      fragment.sourceIds.some((id) => !allowed.has(id))
    )
      throw fail(
        `조각 ${fragment.id}의 출처가 출처 종류와 맞지 않습니다. 리뷰 조각은 VOICES, 레퍼런스 조각은 REFERENCES ID를 쓰고, 근거가 없으면 inferred 로 표시하세요.`,
      );
  }
  const targetIds = new Set(targets.map((item) => item.id));
  if (!targets.length || targetIds.size !== targets.length)
    throw fail("조각을 묶은 타겟이 필요하고 타겟 ID가 겹치면 안 됩니다.");
  for (const target of targets)
    if (target.fragmentIds.some((id) => !fragmentIds.has(id)))
      throw fail(`타겟 ${target.id}이 없는 조각을 가리킵니다.`);
  for (const hypothesis of plan.hypotheses) {
    const target = targets.find((item) => item.id === hypothesis.targetId);
    const path = hypothesis.solutionPath;
    if (!target || !path || !hypothesis.entryPoint)
      throw fail(`광고안 ${hypothesis.id}은 타겟 1개·진입점·해결 과정을 정해야 합니다.`);
    // 실패 경험 타겟은 원인 재해석, 처음 알아보는 타겟은 기준 선점이 기본이지만(설계 3절) 강제하지 않는다.
    // 실전 실행에서 이 검사가 재작성 기회를 다 써 버렸다. 흐름별 필수 단계만 검사한다.
    const order = path.steps.map((step) => SOLUTION_ORDER.indexOf(step.stage));
    if (order.some((value, index) => index > 0 && value < (order[index - 1] ?? 0)))
      throw fail(`광고안 ${hypothesis.id}의 해결 과정 단계 순서가 뒤바뀌었습니다.`);
    const stages = new Set(path.steps.map((step) => step.stage));
    const required =
      path.flow === "cause_reframe"
        ? (["past_attempt", "real_cause", "mechanism", "outcome"] as const)
        : (["criteria", "mechanism", "outcome"] as const);
    if (required.some((stage) => !stages.has(stage)))
      throw fail(
        `광고안 ${hypothesis.id}의 해결 과정이 결과만 있고 과정이 빠졌습니다. ${required.join("·")} 단계가 필요합니다.`,
      );
    for (const step of path.steps) {
      const allowed =
        step.basis === "product_fact"
          ? factIds
          : step.basis === "customer_voice"
            ? voiceIds
            : step.basis === "reference"
              ? referenceIds
              : new Set<string>();
      if (step.sourceIds.some((id) => !allowed.has(id)))
        throw fail(
          `광고안 ${hypothesis.id}의 ${step.stage} 단계 출처가 근거 종류와 맞지 않습니다.`,
        );
      if (
        (step.stage === "mechanism" || step.stage === "verification") &&
        (step.basis !== "product_fact" || step.sourceIds.length === 0)
      )
        throw fail(
          `광고안 ${hypothesis.id}: 우리 상품이 푸는 방식(mechanism)과 확인 방법(verification)은 제품 사실(FACTS) 인용이 필요합니다.`,
        );
    }
  }
  const pairs = new Set(plan.hypotheses.map((item) => `${item.targetId}:${item.entryPoint}`));
  const used = new Set(plan.hypotheses.map((item) => item.targetId));
  if (pairs.size !== expectedCount || used.size < Math.min(expectedCount, targets.length))
    throw fail(
      "광고안마다 다른 타겟을 쓰고, 타겟이 모자라면 같은 타겟이라도 진입점(불편·대안·의심·가격·욕망)을 달리해야 합니다.",
    );
  validatePersuasionChains(plan, factIds, voiceIds, referenceIds, expectedCount, fail);
}

// 설득 사슬(사용자 결정 2026-10-06): 해결이 고객의 고통을 실제로 없애는지, 그 해결이 우리 상품이어야만 하는지를 칸으로 검사한다.
// 사슬이 없는 기획(예전 저장본)은 검사하지 않는다. 사슬이 하나라도 있으면 모든 광고안·타겟에 적용한다.
function validatePersuasionChains(
  plan: CreativePlan,
  factIds: ReadonlySet<string>,
  voiceIds: ReadonlySet<string>,
  referenceIds: ReadonlySet<string>,
  expectedCount: number,
  fail: (message: string) => StudioError,
): void {
  if (plan.hypotheses.every((item) => !item.chain)) return;
  const targets = plan.targets ?? [];
  // 타겟 점수: 영상 수보다 타겟이 많을 때 점수 상위 타겟만 광고안이 쓴다(동점은 모두 허용).
  if (targets.some((target) => !target.fit))
    throw fail(
      "타겟마다 fit(painStrength·productAnswer·distinctness 1~5, reason)을 매겨야 합니다. 우리 상품이 고유하게 답하지 못하는 고통은 productAnswer 를 낮게 두세요.",
    );
  const scores = targets
    .map((target) => (target.fit ? targetFitScore(target.fit) : 0))
    .sort((left, right) => right - left);
  const cutoff = scores[Math.min(expectedCount, scores.length) - 1] ?? 0;
  for (const hypothesis of plan.hypotheses) {
    const target = targets.find((item) => item.id === hypothesis.targetId);
    const chain = hypothesis.chain;
    if (!target || !chain) throw fail(`광고안 ${hypothesis.id}에 설득 사슬(chain)이 없습니다.`);
    if ((target.fit ? targetFitScore(target.fit) : 0) < cutoff)
      throw fail(
        `광고안 ${hypothesis.id}의 타겟 ${target.id}은 점수가 낮은 타겟입니다. 점수가 높은 타겟부터 광고안 ${expectedCount}개에 쓰세요.`,
      );
    const fragments = targetFragments(plan, target.id);
    if (target.experience === "first_time" && customerTriedAndFailed(fragments))
      throw fail(
        `타겟 ${target.id}의 조각에 실패 경험이 있으니 experience 는 tried_failed 여야 합니다.`,
      );
    if (chain.exclusivity !== "product_specific")
      throw fail(
        `광고안 ${hypothesis.id}: 해결 조건~이유(④~⑥)가 아무 제품에나 맞는 말입니다(any_product). 한 칸 더 내려가 우리 상품만의 제품 사실에 닿게 하거나, 이 타겟을 버리고 점수가 높은 다른 타겟을 쓰세요.`,
      );
    const allowed = (basis: string) =>
      basis === "product_fact"
        ? factIds
        : basis === "customer_voice"
          ? voiceIds
          : basis === "reference"
            ? referenceIds
            : new Set<string>();
    for (const [key, step] of Object.entries(chain)) {
      if (typeof step === "string") continue;
      if (step.sourceIds.some((id) => !allowed(step.basis).has(id)))
        throw fail(`광고안 ${hypothesis.id}의 사슬 ${key} 출처가 근거 종류와 맞지 않습니다.`);
    }
    if (!chain.pain.content.trim())
      throw fail(`광고안 ${hypothesis.id}: 사슬의 고통(pain) 칸이 비어 있습니다.`);
    if (
      chain.pain.basis !== "inferred" &&
      chain.pain.sourceIds.length === 0 &&
      (voiceIds.size > 0 || referenceIds.size > 0)
    )
      throw fail(
        `광고안 ${hypothesis.id}: 사슬의 고통(pain)은 고객 말을 인용해야 합니다(VOICES 또는 REFERENCES 출처). 근거가 없으면 basis inferred 로 표시하세요.`,
      );
    for (const key of ["productFact", "reasonWhy"] as const) {
      const step = chain[key];
      if (!step.content.trim() || step.basis !== "product_fact" || step.sourceIds.length === 0)
        throw fail(
          `광고안 ${hypothesis.id}: 사슬의 ${key === "productFact" ? "우리 상품의 사실(⑤)" : "가능한 이유(⑥)"}은 FACTS 를 인용한 제품 사실이어야 합니다. ⑥이 비면 이 해결은 아무 제품이나 할 수 있는 말입니다.`,
        );
    }
    for (const key of ["realCause", "requirement", "outcome"] as const)
      if (!chain[key].content.trim())
        throw fail(`광고안 ${hypothesis.id}: 사슬의 ${key} 칸이 비어 있습니다.`);
    if (!addsProductDetail(chain.reasonWhy.content, chain.productFact.content))
      throw fail(
        `광고안 ${hypothesis.id}: 사슬의 가능한 이유(⑥)가 우리 상품의 사실(⑤)을 되풀이합니다. ⑥에는 ⑤에 없는 제품 고유 세부(한 알의 함량·원재료 100%·섞지 않음·냉압착·제조사 같은 FACTS 숫자·낱말)가 있어야 "왜 ⑤가 가능한지"가 됩니다.`,
      );
    // 결과는 고객이 말한 욕망·고통의 낱말을 되받아야 한다(지어낸 감정·효능 금지).
    const desires = desireTexts(fragments);
    if (desires.length > 0 && !desires.some((text) => sharesKeyWord(chain.outcome.content, text)))
      throw fail(
        `광고안 ${hypothesis.id}: 사슬의 결과(outcome)가 타겟 조각의 욕망·고통 낱말을 되받지 않습니다. 고객이 말한 상태가 이루어진 모습을 고객의 낱말로 쓰세요.`,
      );
  }
}

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
  // 인식 단계는 조각에서 나온다(사용자 결정 2026-10-06): 써 본 것·현재 대안·믿는 원인이 있으면 고객은 자기 문제를 안다 → TOFU 가 아니다.
  for (const hypothesis of plan.hypotheses)
    if (
      hypothesis.chain &&
      hypothesis.decisionRole === "need_awareness" &&
      customerKnowsProblem(targetFragments(plan, hypothesis.targetId))
    )
      throw new StudioError(
        "funnel",
        `광고안 ${hypothesis.id}: 타겟 ${hypothesis.targetId}의 조각에 실패 경험·현재 대안·믿는 원인이 있어 고객이 자기 문제를 압니다. decisionRole 은 comparison(MOFU) 이상이어야 합니다.`,
      );
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
    const slides = hypothesis.cardSlides ?? [];
    if (signals.format === "mechanism_explainer" ? slides.length < 2 : slides.length > 0)
      throw new StudioError(
        "funnel",
        "메커니즘 설명형 카드뉴스는 표지 다음 카드 2~4장이 필요하고, 다른 소재 유형은 카드를 만들지 않습니다.",
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
  const requiredStages = ["comparison"];
  // 설득 사슬 기획: 조각에서 고객이 문제를 모르는 타겟이 하나도 없으면 TOFU 소재를 만들 수 없다.
  const tofuPossible =
    !plan.hypotheses.some((item) => item.chain) ||
    (plan.targets ?? []).some((target) => !customerKnowsProblem(targetFragments(plan, target.id)));
  if (tofuPossible) requiredStages.unshift("need_awareness");
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
// 구조 검사 세 가지를 각각 돌려 걸린 오류를 모두 모은다(2026-10-06): 실제 호출에서 시도마다 다른 규칙 하나씩에 걸려
// 재작성 4회를 다 썼다. 모델에는 한 번에 전부 알려 준다.
export function planStructureProblems(
  plan: CreativePlan,
  snapshot: ProjectSourceSnapshot,
  expectedCount: number,
): StudioError[] {
  const pack = evidencePack(snapshot, plan.targets ? 2 : 1);
  const problems: StudioError[] = [];
  for (const check of [validateCustomerQuestions, validatePlanTargets, validateFunnelSignals])
    try {
      check(plan, pack, expectedCount);
    } catch (error) {
      if (error instanceof StudioError) problems.push(error);
      else throw error;
    }
  return problems;
}
export function validatePlanEvidence(
  plan: CreativePlan,
  snapshot: ProjectSourceSnapshot,
  expectedCount = 3,
): void {
  if (plan.sourceDigest !== snapshot.digest)
    throw new StudioError("source_digest", "기획의 자료 스냅샷이 일치하지 않습니다.");
  // 타겟·조각이 있는 기획은 2판(레퍼런스 묶음 대표·후기 12개), 그 전 기획은 만들 때의 1판으로 검증한다.
  const pack = evidencePack(snapshot, plan.targets ? 2 : 1);
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
  validatePlanTargets(plan, pack, expectedCount);
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
