import { z } from "zod";
import { CreativeSchema } from "./planning";

const concise = z.string().trim().min(1).max(1500);
export const ReferenceAnalysisResponseSchema = z
  .object({
    observedStructure: z.array(concise).max(10),
    inferences: z.array(concise).max(10),
    unknowns: z.array(concise).min(1).max(10),
  })
  .strict();
export const ReferenceAnalysisSchema = ReferenceAnalysisResponseSchema.extend({
  sourceId: z.string(),
});
export type ReferenceAnalysis = z.infer<typeof ReferenceAnalysisSchema>;
export const CustomerQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    kind: z.enum(["buying_reason", "hesitation", "decision_criterion"]),
    question: concise,
    basis: z.enum(["customer_voice", "product_fact", "inferred"]),
    sourceIds: z.array(z.string()).max(8),
    proofNeeded: concise,
    answeredByReferences: z.array(z.string()).max(8),
  })
  .strict();
export type CustomerQuestion = z.infer<typeof CustomerQuestionSchema>;
// decisionRole 은 고객 인식 단계(퍼널)와 같다: need_awareness=TOFU, comparison=MOFU, final_decision=BOFU.
const DecisionRoleSchema = z.enum(["need_awareness", "comparison", "final_decision"]);
// 안드로메다 소재 신호 4가지(대상 호출·페인포인트·고유 메커니즘·오퍼)와 한 세트 5종 소재 유형.
export const CreativeFormatSchema = z.enum([
  "problem_empathy",
  "mechanism_explainer",
  "review_proof",
  "benefit_offer",
  "risk_reversal",
]);
export type CreativeFormat = z.infer<typeof CreativeFormatSchema>;
export const OfferTypeSchema = z.enum([
  "none",
  "value_bundle",
  "free_trial",
  "discount",
  "urgency",
  "risk_reversal",
]);
export const FunnelSignalsSchema = z
  .object({
    format: CreativeFormatSchema,
    avatarCallout: concise,
    painPoint: concise,
    mechanism: z
      .object({
        mode: z.enum(["unique_mechanism", "cause_reframe", "social_proof"]),
        statement: concise,
      })
      .strict(),
    offer: z
      .object({
        type: OfferTypeSchema,
        statement: z.string().trim().max(1500),
      })
      .strict(),
  })
  .strict();
export type FunnelSignals = z.infer<typeof FunnelSignalsSchema>;
// 메커니즘 설명형 카드뉴스의 2~5번째 장. 1번째 장(표지)은 creative.imagePrompt 로 만든다.
export const CardSlideSchema = z
  .object({
    headline: z.string().trim().min(1).max(80),
    body: z.string().trim().max(300),
    imagePrompt: concise,
  })
  .strict();
export type CardSlide = z.infer<typeof CardSlideSchema>;
// 2026-10-05 기획 재설계(CREATIVE-PLANNING-DESIGN.md): 리뷰·레퍼런스에서 뽑은 장면 조각을 묶어 타겟을 만들고,
// 광고안마다 타겟 1개·진입점·해결 과정(원인 재해석 또는 기준 선점)을 정한다.
const shortText = z.string().trim().max(600);
export const MarketFragmentSchema = z
  .object({
    id: z.string().regex(/^f[0-9]{1,2}$/),
    situation: concise,
    desire: concise,
    pain: concise,
    alternative: shortText,
    failedAttempt: shortText,
    believedCause: shortText,
    hesitation: shortText,
    quote: shortText,
    origin: z.enum(["customer_review", "reference_ad", "reference_video", "inferred"]),
    sourceIds: z.array(z.string()).max(8),
  })
  .strict();
export type MarketFragment = z.infer<typeof MarketFragmentSchema>;
// 타겟 점수(2026-10-06): 영상 수보다 타겟이 많을 때 "고통의 강도 × 우리 상품이 그 고통에 고유하게 답하는 정도 × 경쟁과의 차이"가
// 높은 타겟부터 쓴다. 예전 기획에는 없어 선택 항목이지만, 설득 사슬(chain)이 있는 기획에서는 필수다.
export const TargetFitSchema = z
  .object({
    painStrength: z.number().int().min(1).max(5),
    productAnswer: z.number().int().min(1).max(5),
    distinctness: z.number().int().min(1).max(5),
    reason: concise,
  })
  .strict();
export type TargetFit = z.infer<typeof TargetFitSchema>;
export const targetFitScore = (fit: TargetFit): number =>
  fit.painStrength * fit.productAnswer * fit.distinctness;
// 응답(json_schema strict)은 fit 필수, 저장본은 예전 기획 호환을 위해 선택.
export const PlanTargetResponseSchema = z
  .object({
    id: z.string().regex(/^t[0-9]{1,2}$/),
    label: concise,
    experience: z.enum(["tried_failed", "first_time"]),
    fragmentIds: z.array(z.string()).min(1).max(20),
    fit: TargetFitSchema,
  })
  .strict();
export const PlanTargetSchema = PlanTargetResponseSchema.extend({
  fit: TargetFitSchema.optional(),
});
export type PlanTarget = z.infer<typeof PlanTargetSchema>;
export const SolutionStageSchema = z.enum([
  "past_attempt",
  "believed_cause",
  "real_cause",
  "criteria",
  "mechanism",
  "verification",
  "outcome",
]);
export const SolutionStepSchema = z
  .object({
    stage: SolutionStageSchema,
    content: concise,
    basis: z.enum(["product_fact", "customer_voice", "reference", "general_knowledge", "inferred"]),
    sourceIds: z.array(z.string()).max(8),
  })
  .strict();
export const SolutionPathSchema = z
  .object({
    flow: z.enum(["cause_reframe", "criteria_first"]),
    steps: z.array(SolutionStepSchema).min(4).max(9),
  })
  .strict();
export type SolutionPath = z.infer<typeof SolutionPathSchema>;
export const EntryPointSchema = z.enum(["pain", "alternative", "doubt", "price", "desire"]);
// 설득 사슬(사용자 결정 2026-10-06): 영상 1개 = 타겟 1명 = 고통 1개 = 메시지 1개. 해결이 고객의 고통을 실제로 없애는지를
// 칸으로 강제한다. ① 고통 → ② 믿는 원인 → ③ 진짜 원인 → ④ 해결 조건 → ⑤ 우리 상품이 ④를 채우는 사실 → ⑥ ⑤가 가능한 이유
// (제품 사실) → 결과(①의 고통이 사라지고 조각의 욕망이 이루어진 상태). ⑥이 비거나 아무 제품에나 맞으면 사슬 실패.
export const ChainStepSchema = z
  .object({
    content: shortText,
    basis: z.enum(["product_fact", "customer_voice", "reference", "general_knowledge", "inferred"]),
    sourceIds: z.array(z.string()).max(8),
  })
  .strict();
export type ChainStep = z.infer<typeof ChainStepSchema>;
export const PersuasionChainSchema = z
  .object({
    pain: ChainStepSchema,
    believedCause: ChainStepSchema,
    realCause: ChainStepSchema,
    requirement: ChainStepSchema,
    productFact: ChainStepSchema,
    reasonWhy: ChainStepSchema,
    outcome: ChainStepSchema,
    // ④~⑥을 다른 제품에 그대로 붙여도 말이 되면 any_product — 그 타겟은 사슬 실패.
    exclusivity: z.enum(["product_specific", "any_product"]),
  })
  .strict();
export type PersuasionChain = z.infer<typeof PersuasionChainSchema>;
export const CHAIN_STEP_KEYS = [
  "pain",
  "believedCause",
  "realCause",
  "requirement",
  "productFact",
  "reasonWhy",
  "outcome",
] as const;
const targetingFields = {
  targetId: z.string(),
  entryPoint: EntryPointSchema,
  solutionPath: SolutionPathSchema,
  chain: PersuasionChainSchema,
};
export const HypothesisResponseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    angle: z.enum(["problem_solution", "usage_context", "objection_answer"]),
    customerQuestionId: z.string(),
    decisionRole: DecisionRoleSchema,
    proofShown: concise,
    signals: FunnelSignalsSchema,
    cardSlides: z.array(CardSlideSchema).max(4),
    targetAudience: concise,
    targetReason: concise,
    customerSituation: concise,
    problem: concise,
    message: concise,
    hook: concise,
    difference: concise,
    visualMechanism: concise,
    claimCitations: z
      .array(z.object({ sourceId: z.string(), quote: concise }).strict())
      .min(1)
      .max(10),
    referenceSourceIds: z.array(z.string()).max(8),
    creative: CreativeSchema,
    ...targetingFields,
  })
  .strict();
// 고객 질문 설계 이전에 저장된 기획도 읽을 수 있도록 저장본에서는 새 필드를 선택 항목으로 둔다.
export const HypothesisSchema = HypothesisResponseSchema.extend({
  customerQuestionId: z.string().optional(),
  decisionRole: DecisionRoleSchema.optional(),
  proofShown: concise.optional(),
  signals: FunnelSignalsSchema.optional(),
  cardSlides: z.array(CardSlideSchema).max(4).default([]),
  targetId: targetingFields.targetId.optional(),
  entryPoint: targetingFields.entryPoint.optional(),
  solutionPath: targetingFields.solutionPath.optional(),
  chain: targetingFields.chain.optional(),
});
export const CreativePlanResponseSchema = z
  .object({
    fragments: z.array(MarketFragmentSchema).min(1).max(40),
    targets: z.array(PlanTargetResponseSchema).min(1).max(10),
    customerQuestions: z.array(CustomerQuestionSchema).min(1).max(12),
    hypotheses: z.array(HypothesisResponseSchema).min(1).max(10),
    diversityRationale: concise,
    limitations: z.array(concise).min(1).max(15),
  })
  .strict();
export const LearningSignalSchema = z.object({
  optimizationResult: z.enum(["purchase", "link_click"]),
  dailyBudget: z.number().positive(),
  weeklyBudget: z.number().positive(),
  currency: z.string(),
  weeklyResultsReference: z.literal(50),
  maxCostPerResultFor50: z.number().positive(),
  conceptCount: z.number().int().min(1).max(10),
});
export type LearningSignal = z.infer<typeof LearningSignalSchema>;
export const CreativePlanSchema = CreativePlanResponseSchema.extend({
  // 예전 기획에는 없다. 기본값을 채우면 저장된 기획의 승인 해시(approvedPlanDigest)가 바뀌므로 선택 항목으로 둔다.
  fragments: z.array(MarketFragmentSchema).max(40).optional(),
  targets: z.array(PlanTargetSchema).max(10).optional(),
  customerQuestions: z.array(CustomerQuestionSchema).max(12).default([]),
  hypotheses: z.array(HypothesisSchema).min(1).max(10),
  learningSignal: LearningSignalSchema.nullable().default(null),
  sourceDigest: z.string(),
  referenceAnalyses: z.array(ReferenceAnalysisSchema).max(8),
  sourceCoverage: z.object({
    factsUsed: z.array(z.string()).max(8),
    referencesUsed: z.array(z.string()).max(5),
    voicesUsed: z.array(z.string()).max(12),
    excluded: z.array(z.object({ sourceId: z.string(), reason: z.string() })).max(100),
    limits: z.object({
      maxFactSources: z.literal(8),
      maxFactCharacters: z.literal(24000),
      maxReferenceSources: z.literal(5),
      maxReferenceCharacters: z.literal(8000),
      // 1판 4개·8,000자, 2판(타겟·조각 기획) 12개·12,000자.
      maxVoiceSources: z.union([z.literal(4), z.literal(12)]),
      maxVoiceCharacters: z.union([z.literal(8000), z.literal(12000)]),
    }),
  }),
});
export type CreativePlan = z.infer<typeof CreativePlanSchema>;
export const PlanCritiqueSchema = z
  .object({
    status: z.enum(["pass", "revise"]),
    issues: z.array(concise).max(15),
  })
  .strict();
export const CreativeVariantSchema = z.object({
  id: z.string(),
  creative: CreativeSchema,
  imageAttempts: z.number().int().min(0).max(2),
  approvedImageId: z.string().nullable(),
  approvedImageDigest: z.string().nullable(),
  approvedCreativeDigest: z.string().nullable(),
  reviewStatus: z.enum(["pending", "pass", "revise"]),
  // 카드뉴스 2~5번째 장 이미지 (cardSlides 순서). 승인 후 확정된 이미지 산출물 ID.
  cardImageIds: z.array(z.string()).max(4).default([]),
});
export type CreativeVariant = z.infer<typeof CreativeVariantSchema>;
export const StagedVariantSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  creativeSnapshot: CreativeSchema,
  creativeId: z.string().nullable(),
  adId: z.string().nullable(),
  imageHash: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
});
