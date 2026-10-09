import { z } from "zod";

// --- 혼합형 설명 장면(2026-10-07, hybrid_explainer_v1, 레퍼런스 문법 R1~R6) -------------------------------------
// 설명 세계의 컷은 물체가 있는 3D 장면이다. 글자는 자막 한 줄뿐이라 이름표·지시선·수치 박스(annotations·infoLines)는 받지 않고,
// 장면 종류(과정·비교·비유)·물체(색 고정)·동작 순서·강조 수단만 적는다. 강조는 전부 장면 속 물체에 붙는다(평면 그래픽 금지).
// 기획(shared/video-planning.ts)과 대본(shared/video-script.ts)이 같은 낱말을 쓰도록 여기 한 곳에 둔다
// (video-script.ts 가 video-planning.ts 를 가져오므로 반대 방향 import 는 순환이 된다).
export const EXPLAINER_SCENE_TYPES = ["process", "comparison", "analogy"] as const;
export const ExplainerSceneTypeSchema = z.enum(EXPLAINER_SCENE_TYPES);
export type ExplainerSceneType = (typeof EXPLAINER_SCENE_TYPES)[number];
// 물체 색: 브랜드 강조색 2개 또는 중립(클레이·화이트). 같은 subjectId 의 색은 영상 전체에서 고정이다.
export const EXPLAINER_COLORS = ["accent1", "accent2", "neutral"] as const;
export const ExplainerColorSchema = z.enum(EXPLAINER_COLORS);
// 강조 수단 네 가지: color_code(두 대상의 색 구분), outline(빨간 외곽선), glow_line(흰 발광 선·화살표·나선), ghost_object(반투명 비유 오브젝트).
export const EXPLAINER_EMPHASIS_KINDS = [
  "color_code",
  "outline",
  "glow_line",
  "ghost_object",
] as const;
export const ExplainerEmphasisKindSchema = z.enum(EXPLAINER_EMPHASIS_KINDS);
export const EXPLAINER_OBJECTS_MAX = 3;
export const EXPLAINER_ACTIONS_MAX = 3;
export const EXPLAINER_EMPHASIS_MAX = 4;
const line = z.string().trim().min(1).max(1200);
const subjectId = z.string().regex(/^[a-z0-9]{1,12}$/, "영문 소문자·숫자 1~12자");
export const ExplainerObjectSchema = z.strictObject({
  // 대본 subjects 에 선언한 대상 ID.
  subjectId,
  color: ExplainerColorSchema,
});
export type ExplainerObject = z.infer<typeof ExplainerObjectSchema>;
export const ExplainerEmphasisSchema = z.strictObject({
  kind: ExplainerEmphasisKindSchema,
  // 강조가 붙는 물체(objects 의 subjectId).
  target: subjectId,
  // 몇 번째 동작(actions 번호, 0부터) 뒤에 나타나는가.
  afterAction: z
    .number()
    .int()
    .min(0)
    .max(EXPLAINER_ACTIONS_MAX - 1),
});
export type ExplainerEmphasis = z.infer<typeof ExplainerEmphasisSchema>;

// 기획 단계의 설명 장면(장면 계획 scenePlan[].explainerScene). 대본은 이 물체를 같은 subjectId 로 subjects 에 선언하고
// 설명 컷(I1~I3)의 sceneType·objects·actions·emphasis 로 옮긴다. appearance 는 대본 subjects[].traits 의 바탕이 된다.
export const PlannedExplainerObjectSchema = z.strictObject({
  subjectId,
  // 물체의 고정 외형 한 줄(영어): 무엇인지·재질·형태. 글자·라벨이 아니라 물체 자체를 적는다.
  appearance: z.string().trim().min(1).max(300),
  color: ExplainerColorSchema,
});
export type PlannedExplainerObject = z.infer<typeof PlannedExplainerObjectSchema>;
export const PlannedExplainerSceneSchema = z
  .strictObject({
    sceneType: ExplainerSceneTypeSchema,
    objects: z.array(PlannedExplainerObjectSchema).min(1).max(EXPLAINER_OBJECTS_MAX),
    // 물체가 하는 일의 순서(영어 한 줄씩): 올라감·쏟아짐·열림·차오름. 과정은 이 순서가 곧 메커니즘이다.
    actions: z.array(line).min(1).max(EXPLAINER_ACTIONS_MAX),
    emphasis: z.array(ExplainerEmphasisSchema).max(EXPLAINER_EMPHASIS_MAX),
    // 비유(R6): 수치를 체감 물체로 바꾼 한 줄(영어). analogy 장면에만 적고 다른 장면은 "".
    analogy: z.string().trim().max(300),
  })
  .superRefine((scene, ctx) => {
    const ids = scene.objects.map((object) => object.subjectId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["objects"], message: "물체 subjectId 가 중복됩니다." });
    if (scene.sceneType === "comparison") {
      if (scene.objects.length < 2)
        ctx.addIssue({
          code: "custom",
          path: ["objects"],
          message: "비교 장면에는 물체가 2개 이상 필요합니다(두 모형을 나란히).",
        });
      const colors = scene.objects.map((object) => object.color);
      if (new Set(colors).size !== colors.length)
        ctx.addIssue({
          code: "custom",
          path: ["objects"],
          message: "비교 대상은 서로 다른 색으로 구분해야 합니다.",
        });
    }
    if (scene.sceneType === "analogy" && scene.analogy.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["analogy"],
        message: "비유 장면에는 수치를 대신하는 체감 물체(analogy)가 필요합니다.",
      });
    scene.emphasis.forEach((item, index) => {
      if (!ids.includes(item.target))
        ctx.addIssue({
          code: "custom",
          path: ["emphasis", index, "target"],
          message: "강조는 이 장면의 물체(objects)에만 붙습니다.",
        });
      if (item.afterAction >= scene.actions.length)
        ctx.addIssue({
          code: "custom",
          path: ["emphasis", index, "afterAction"],
          message: "강조가 나타나는 동작 번호가 동작 수를 넘습니다.",
        });
    });
  });
export type PlannedExplainerScene = z.infer<typeof PlannedExplainerSceneSchema>;
