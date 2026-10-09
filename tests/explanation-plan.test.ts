import { expect, test } from "bun:test";
import { z } from "zod";
import { type ExplanationPlan, ExplanationPlanSchema } from "../shared/explanation-plan";
import {
  ScenePlanItemResponseSchema,
  ScenePlanItemSchema,
  VideoConceptResponseSchema,
} from "../shared/video-planning";
import { scriptDigestJson, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

function exampleExplanation(): ExplanationPlan {
  return {
    id: "capsule-interior",
    productForm: "자료 사진에 보이는 타원형 연질 캡슐의 비율과 색을 유지한다.",
    entities: [
      {
        id: "capsule",
        name: "캡슐",
        representation: "product",
        appearance: "자료 사진의 타원형 캡슐",
      },
      { id: "oil", name: "내부 오일", representation: "component", appearance: "캡슐 안쪽의 오일" },
    ],
    beats: [
      {
        id: "reveal",
        targetIds: ["capsule", "oil"],
        startProgress: 0.1,
        endProgress: 0.8,
        before: "완전한 캡슐을 같은 시점에서 보여준다.",
        action: "앞쪽 껍질만 투명하게 바꿔 내부를 드러낸다.",
        after: "외피와 내부 오일이 구분된 단면을 유지한다.",
        narrationCue: "캡슐 안에 든 오일",
        viewerTakeaway: "껍질과 내부 오일은 다른 부분이다.",
      },
    ],
    annotations: [
      {
        targetId: "oil",
        beatId: "reveal",
        label: "내부 오일",
        kind: "pointer",
        motionIntent: "단면이 드러날 때 내부에 연결선을 붙이고 유지한다.",
      },
    ],
  };
}

test("a scene preserves explicit object, action and annotation relationships", () => {
  // Given
  const scene = {
    scene: "캡슐 내부 보기",
    source: "info_clip" as const,
    reason: "단면으로 구분한다.",
    explanation: exampleExplanation(),
  };
  // When
  const parsed = ScenePlanItemSchema.safeParse(scene);
  // Then
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual(scene);
});

test.each(["before", "action", "after", "narrationCue", "viewerTakeaway"])(
  "an explanation cannot omit its %s instruction",
  (field) => {
    // Given
    const plan = exampleExplanation();
    const incomplete = { ...plan, beats: plan.beats.map((beat) => ({ ...beat, [field]: " " })) };
    // When
    const parsed = ExplanationPlanSchema.safeParse(incomplete);
    // Then
    expect(parsed.success).toBe(false);
  },
);

test("a beat cannot refer to an undeclared or duplicate target", () => {
  // Given
  const plan = exampleExplanation();
  const invalidTargets = [["unknown"], ["oil", "oil"]];
  // When
  const parsed = invalidTargets.map((targetIds) =>
    ExplanationPlanSchema.safeParse({
      ...plan,
      beats: plan.beats.map((beat) => ({ ...beat, targetIds })),
    }),
  );
  // Then
  expect(parsed.every((result) => !result.success)).toBe(true);
});

test("an annotation cannot name a target outside its referenced beat", () => {
  // Given
  const plan = exampleExplanation();
  const mismatched = {
    ...plan,
    beats: plan.beats.map((beat) => ({ ...beat, targetIds: ["capsule"] })),
  };
  // When
  const parsed = ExplanationPlanSchema.safeParse(mismatched);
  // Then
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["annotations", 0, "targetId"]);
});

test.each(["targetId", "beatId"])("an annotation rejects an unknown %s", (field) => {
  // Given
  const plan = exampleExplanation();
  const unknown = {
    ...plan,
    annotations: plan.annotations.map((item) => ({ ...item, [field]: "unknown" })),
  };
  // When
  const parsed = ExplanationPlanSchema.safeParse(unknown);
  // Then
  expect(parsed.success).toBe(false);
});

test.each(["entities", "beats"] as const)(
  "an explanation rejects duplicate %s identities",
  (field) => {
    // Given
    const plan = exampleExplanation();
    const duplicate = { ...plan, [field]: [...plan[field], ...plan[field]] };
    // When
    const parsed = ExplanationPlanSchema.safeParse(duplicate);
    // Then
    expect(parsed.success).toBe(false);
  },
);

test.each([
  { startProgress: -0.1, endProgress: 0.8 },
  { startProgress: 0.1, endProgress: 1.1 },
  { startProgress: 0.8, endProgress: 0.8 },
  { startProgress: 0.8, endProgress: 0.1 },
])("a beat rejects an invalid normalized action window %j", (window) => {
  // Given
  const plan = exampleExplanation();
  const invalid = { ...plan, beats: plan.beats.map((beat) => ({ ...beat, ...window })) };
  // When
  const parsed = ExplanationPlanSchema.safeParse(invalid);
  // Then
  expect(parsed.success).toBe(false);
});

test("beats reject overlapping action windows", () => {
  // Given
  const plan = exampleExplanation();
  const overlapping = {
    ...plan,
    beats: [
      ...plan.beats,
      ...plan.beats.map((beat) => ({
        ...beat,
        id: "compare",
        startProgress: 0.7,
        endProgress: 0.9,
      })),
    ],
  };
  // When
  const parsed = ExplanationPlanSchema.safeParse(overlapping);
  // Then
  expect(parsed.success).toBe(false);
});

test("adjacent action windows preserve their order and exact proportions", () => {
  // Given
  const plan = exampleExplanation();
  const adjacent = {
    ...plan,
    beats: [
      ...plan.beats,
      ...plan.beats.map((beat) => ({ ...beat, id: "compare", startProgress: 0.8, endProgress: 1 })),
    ],
  };
  // When
  const parsed = ExplanationPlanSchema.parse(adjacent);
  // Then
  expect(parsed.beats).toEqual(adjacent.beats);
});

test("new INFO response scenes require an explanation but other scenes explicitly use null", () => {
  // Given
  const scene = { scene: "제품 보기", source: "generated", reason: "실제 형태를 보여준다." };
  // When
  const missing = ScenePlanItemResponseSchema.safeParse(scene);
  const ordinary = ScenePlanItemResponseSchema.safeParse({ ...scene, explanation: null });
  const info = ScenePlanItemResponseSchema.safeParse({
    ...scene,
    source: "info_clip",
    explanation: null,
  });
  // Then
  expect(missing.success).toBe(false);
  expect(ordinary.success).toBe(true);
  expect(info.success).toBe(false);
  expect(z.toJSONSchema(ScenePlanItemResponseSchema).required).toContain("explanation");
});

test("saved scenes without explanation keep their original JSON and approval digest", () => {
  // Given
  const planning = fixtureVideoPlanning();
  const original = VideoScriptSchema.parse({
    ...renderScript(1, "concept-1", 36),
    planning: {
      ...planning,
      concept: {
        ...planning.concept,
        scenePlan: planning.concept.scenePlan?.map(({ explanation: _unused, ...scene }) => scene),
      },
    },
  });
  const before = JSON.stringify(original);
  // When
  const restored = VideoScriptSchema.parse(JSON.parse(before));
  // Then
  expect(JSON.stringify(restored)).toBe(before);
  expect(
    restored.planning?.concept.scenePlan?.every((scene) => !Object.hasOwn(scene, "explanation")),
  ).toBe(true);
  expect(scriptDigestJson(restored)).toBe(scriptDigestJson(original));
});

test("new concepts reject duplicate explanation identities before script mapping", () => {
  // Given
  const concept = fixtureVideoPlanning().concept;
  const scene = {
    scene: "구조 보기",
    source: "info_clip",
    reason: "같은 대상의 내부를 본다.",
    explanation: exampleExplanation(),
  };
  // When
  const parsed = VideoConceptResponseSchema.safeParse({ ...concept, scenePlan: [scene, scene] });
  // Then
  expect(parsed.success).toBe(false);
  if (!parsed.success)
    expect(parsed.error.issues[0]?.path).toEqual(["scenePlan", 1, "explanation", "id"]);
});
