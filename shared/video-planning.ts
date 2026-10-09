import { z } from "zod";
import { PlannedExplainerSceneSchema } from "./explainer-scene";
import { ExplanationPlanSchema } from "./explanation-plan";

const insight = z.string().trim().min(1).max(1000);
export const VideoAudienceSchema = z.strictObject({
  viewer: insight,
  situation: insight,
  trigger: insight,
  currentApproach: insight,
  friction: insight,
  concern: insight,
  desiredChange: insight,
  purchaseBarrier: insight,
  proofNeeded: insight,
  awareness: z.enum([
    "unaware",
    "problem_aware",
    "solution_aware",
    "product_aware",
    "ready_to_decide",
  ]),
  evidence: z.array(z.strictObject({ sourceId: z.string().min(1), observation: insight })).max(10),
  assumptions: z.array(insight).max(10),
  unknowns: z.array(insight).max(10),
});
// 장면별 화면 소스: project_asset = 프로젝트에 등록된 실제 사진·촬영본·승인 이미지,
// generated = AI 생성 이미지·Veo 클립, graphic = 모션그래픽(글자·숫자 카드).
export const ScenePlanItemSchema = z.strictObject({
  scene: insight,
  source: z.enum(["project_asset", "generated", "graphic", "info_clip"]),
  reason: insight,
  explanation: ExplanationPlanSchema.nullable().optional(),
  // 혼합형(2026-10-07) 설명 장면: info_clip 장면의 물체·동작·강조. 예전·immersive 기획에는 없다(선택, 기본값 없음).
  explainerScene: PlannedExplainerSceneSchema.nullable().optional(),
});
// 혼합형(hybrid_explainer_v1) 기획 응답의 장면: 글자 패널(graphic)은 없고, 설명 장면(info_clip)은 이름표·지시선 계획(explanation)
// 대신 물체·동작·강조(explainerScene)를 적는다. 실사 장면(project_asset·generated)은 explainerScene null.
export const HYBRID_SCENE_SOURCES = ["project_asset", "generated", "info_clip"] as const;
export const HybridScenePlanItemResponseSchema = z
  .strictObject({
    scene: insight,
    source: z.enum(HYBRID_SCENE_SOURCES),
    reason: insight,
    explainerScene: PlannedExplainerSceneSchema.nullable(),
  })
  .superRefine((scene, ctx) => {
    if (scene.source === "info_clip" && !scene.explainerScene)
      ctx.addIssue({
        code: "custom",
        path: ["explainerScene"],
        message: "설명 장면(info_clip)에는 물체·동작·강조를 적은 explainerScene 이 필요합니다.",
      });
    if (scene.source !== "info_clip" && scene.explainerScene)
      ctx.addIssue({
        code: "custom",
        path: ["explainerScene"],
        message: "실사 장면에는 explainerScene 을 적지 않습니다(null).",
      });
  });
// immersive·예전 응답의 장면: explanation 필수(nullable). 혼합형 전용 explainerScene 은 선택 필드라 strict 응답 스키마에서 뺀다.
export const ScenePlanItemResponseSchema = ScenePlanItemSchema.omit({ explainerScene: true })
  .extend({
    explanation: ExplanationPlanSchema.nullable(),
  })
  .superRefine((scene, ctx) => {
    if (scene.source === "info_clip" && !scene.explanation)
      ctx.addIssue({
        code: "custom",
        path: ["explanation"],
        message: "새 설명 클립에는 대상과 동작을 연결한 설명 계획이 필요합니다.",
      });
  });
const conceptCore = {
  idea: insight,
  viewerQuestion: insight,
  openingScene: insight,
  development: z.array(insight).min(1).max(8),
  payoff: insight,
  proofScene: insight,
  ctaIntent: insight,
  referenceNotes: insight,
};
// 2026-10-05 실전 테스트 뒤 추가한 기획 항목. 모델 응답에서는 필수이고, 저장본에서는 예전 기획이
// 이 항목 없이 저장돼 있으므로 선택이다(값을 채워 넣지 않아 예전 대본의 승인 해시가 바뀌지 않는다).
const conceptAdditions = {
  viewerChange: insight,
  mutedMessage: z.string().trim().min(1).max(40),
  stopReason: insight,
  scenePlan: z.array(ScenePlanItemSchema).min(2).max(12),
};
export const VideoConceptResponseSchema = z
  .strictObject({
    ...conceptCore,
    ...conceptAdditions,
    scenePlan: z.array(ScenePlanItemResponseSchema).min(2).max(12),
  })
  .superRefine((concept, ctx) => {
    const ids = new Set<string>();
    for (const [index, scene] of concept.scenePlan.entries()) {
      if (!scene.explanation) continue;
      if (ids.has(scene.explanation.id))
        ctx.addIssue({
          code: "custom",
          path: ["scenePlan", index, "explanation", "id"],
          message: "각 설명 계획에는 고유한 ID가 필요합니다.",
        });
      ids.add(scene.explanation.id);
    }
  });
// 혼합형 기획 응답의 콘셉트: 장면마다 실사(project_asset·generated)인지 설명 세계(info_clip)인지 source 로 적고,
// 같은 subjectId 의 색은 모든 설명 장면에서 같아야 한다(R3 색 구분은 영상 끝까지 고정).
export const HybridVideoConceptResponseSchema = z
  .strictObject({
    ...conceptCore,
    ...conceptAdditions,
    scenePlan: z.array(HybridScenePlanItemResponseSchema).min(2).max(12),
  })
  .superRefine((concept, ctx) => {
    const colors = new Map<string, string>();
    for (const [index, scene] of concept.scenePlan.entries()) {
      for (const [objectIndex, object] of (scene.explainerScene?.objects ?? []).entries()) {
        const fixed = colors.get(object.subjectId);
        if (fixed && fixed !== object.color)
          ctx.addIssue({
            code: "custom",
            path: ["scenePlan", index, "explainerScene", "objects", objectIndex, "color"],
            message: `물체 ${object.subjectId}의 색은 모든 설명 장면에서 같아야 합니다(${fixed}).`,
          });
        if (!fixed) colors.set(object.subjectId, object.color);
      }
    }
  });
export const VideoConceptSchema = z.strictObject({
  ...conceptCore,
  viewerChange: conceptAdditions.viewerChange.optional(),
  mutedMessage: conceptAdditions.mutedMessage.optional(),
  stopReason: conceptAdditions.stopReason.optional(),
  scenePlan: conceptAdditions.scenePlan.optional(),
});
export const VideoCopyLineSchema = z.strictObject({
  text: z.string().trim().min(1).max(160),
  screenText: z.string().trim().max(120),
});
const copySchema = z.strictObject({
  voicePersona: z.enum(["conversational", "storytelling"]),
  lines: z.array(VideoCopyLineSchema).min(4).max(40),
});
const durationSec = z.number().min(30).max(60);

export const VideoPlanningDraftSchema = z.strictObject({
  durationSec: durationSec.optional(),
  audience: VideoAudienceSchema,
  concept: VideoConceptSchema,
  copy: copySchema,
});
/** 모델에 넘기는 기획 응답 스키마(새 기획 항목 필수). 저장은 VideoPlanningDraftSchema 로 한다. */
export const VideoPlanningDraftResponseSchema = z.strictObject({
  durationSec,
  audience: VideoAudienceSchema,
  concept: VideoConceptResponseSchema,
  copy: copySchema,
});
// 혼합형 기획 응답 스키마(새 기획의 기본, 2026-10-07). immersive·예전 응답 스키마(VideoPlanningDraftResponseSchema)는 그대로다.
export const HybridVideoPlanningDraftResponseSchema = z.strictObject({
  durationSec,
  audience: VideoAudienceSchema,
  concept: HybridVideoConceptResponseSchema,
  copy: copySchema,
});
export type VideoPlanningDraftResponse = z.infer<typeof VideoPlanningDraftResponseSchema>;
export type HybridVideoPlanningDraftResponse = z.infer<
  typeof HybridVideoPlanningDraftResponseSchema
>;
export type PlanningResponseInput = VideoPlanningDraftResponse | HybridVideoPlanningDraftResponse;
export const VideoCopyEditSchema = z.strictObject({
  lineIndex: z.number().int().min(0).max(39),
  field: z.enum(["narration", "screenText"]),
  before: z.string().max(160),
  after: z.string().max(160),
  reason: insight,
});
export const VideoCopyReviewSchema = z.strictObject({
  status: z.enum(["pass", "revised"]),
  summary: insight,
  edits: z.array(VideoCopyEditSchema).max(80),
});
export const VideoCopyEditingResponseSchema = z.strictObject({
  lines: z.array(VideoCopyLineSchema).min(4).max(40),
  review: VideoCopyReviewSchema,
});
// 시각 정책(앱이 새 기획에만 부여): immersive_explanations_v1 = 2026-10-06 입체 설명 세계(글자 패널·이름표 INFO),
// hybrid_explainer_v1 = 2026-10-07 혼합형(고통·상황·결과·행동 비트는 실사, 메커니즘·기능·비교 비트만 3D 설명 세계).
// 정책이 없는 저장본은 예전 대본(legacy)이다. 예전 정책 코드는 그대로 두고 분기만 더한다.
export const VISUAL_POLICIES = ["immersive_explanations_v1", "hybrid_explainer_v1"] as const;
export const VisualPolicySchema = z.enum(VISUAL_POLICIES);
export type VisualPolicyId = (typeof VISUAL_POLICIES)[number];
export const VideoPlanningSchema = VideoPlanningDraftSchema.extend({
  // 앱이 새 기획에만 부여한다. 저장된 기획에는 기본값을 넣지 않아 승인 다이제스트를 보존한다.
  visualPolicy: VisualPolicySchema.optional(),
  copyReview: VideoCopyReviewSchema,
});
// 정책별 기획 응답 스키마. 두 형태 모두 저장 스키마(VideoPlanningDraftSchema)에 그대로 담긴다.
export function videoPlanningResponseSchemaFor(
  policy: VisualPolicyId,
): z.ZodType<PlanningResponseInput> {
  return policy === "hybrid_explainer_v1"
    ? HybridVideoPlanningDraftResponseSchema
    : VideoPlanningDraftResponseSchema;
}
export type VideoPlanningDraft = z.infer<typeof VideoPlanningDraftSchema>;
export type VideoPlanning = z.infer<typeof VideoPlanningSchema>;
export type VideoCopyEditingResponse = z.infer<typeof VideoCopyEditingResponseSchema>;
