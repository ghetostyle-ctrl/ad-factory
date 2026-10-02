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
  })
  .strict();
// 고객 질문 설계 이전에 저장된 기획도 읽을 수 있도록 저장본에서는 새 필드를 선택 항목으로 둔다.
export const HypothesisSchema = HypothesisResponseSchema.extend({
  customerQuestionId: z.string().optional(),
  decisionRole: DecisionRoleSchema.optional(),
  proofShown: concise.optional(),
  signals: FunnelSignalsSchema.optional(),
  cardSlides: z.array(CardSlideSchema).max(4).default([]),
});
export const CreativePlanResponseSchema = z
  .object({
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
  customerQuestions: z.array(CustomerQuestionSchema).max(12).default([]),
  hypotheses: z.array(HypothesisSchema).min(1).max(10),
  learningSignal: LearningSignalSchema.nullable().default(null),
  sourceDigest: z.string(),
  referenceAnalyses: z.array(ReferenceAnalysisSchema).max(8),
  sourceCoverage: z.object({
    factsUsed: z.array(z.string()).max(8),
    referencesUsed: z.array(z.string()).max(5),
    voicesUsed: z.array(z.string()).max(4),
    excluded: z.array(z.object({ sourceId: z.string(), reason: z.string() })).max(100),
    limits: z.object({
      maxFactSources: z.literal(8),
      maxFactCharacters: z.literal(24000),
      maxReferenceSources: z.literal(5),
      maxReferenceCharacters: z.literal(8000),
      maxVoiceSources: z.literal(4),
      maxVoiceCharacters: z.literal(8000),
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
