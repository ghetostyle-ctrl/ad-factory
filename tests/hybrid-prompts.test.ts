import { expect, test } from "bun:test";
import { z } from "zod";
import { formatScriptView } from "../scripts/script-cli";
import { DEFAULT_VISUAL_POLICY, videoPlanningInstructions } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import { applyScriptEdit } from "../shared/script-edit";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import {
  HybridVideoPlanningDraftResponseSchema,
  type VideoPlanning,
  VideoPlanningDraftResponseSchema,
  VideoPlanningSchema,
  videoPlanningResponseSchemaFor,
} from "../shared/video-planning";
import { type VideoScript, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { planningHttpFixture } from "./video-planning-http-fixture";
import { HYBRID_EXPLAINER_ANCHOR, hybridScriptResponse } from "./video-script-fixture";

// 혼합형 정책(hybrid_explainer_v1, 2026-10-07)의 기획·대본·검토 프롬프트, 기획 응답 스키마, 실제 와이어(HTTP 픽스처), 편집 보존, CLI 표시.
// 규칙·저장 스키마·수리 계약은 tests/hybrid-policy.test.ts 가 보장한다.
function requiredHypothesis() {
  const hypothesis = sourcePlanResponse("fact-1").hypotheses[0];
  if (!hypothesis) throw new TypeError("Missing test hypothesis");
  return hypothesis;
}
const hypothesis = requiredHypothesis();
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 36, hasCardSlides: false };
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true };
const hybridPlanning = (): VideoPlanning =>
  VideoPlanningSchema.parse({ ...fixtureVideoPlanning(), visualPolicy: "hybrid_explainer_v1" });
function hybridScript(): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), ctx);
  return VideoScriptSchema.parse({ ...script, planning: hybridPlanning() });
}
type JsonSchemaNode = {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
};
function walk(node: JsonSchemaNode, visit: (node: JsonSchemaNode) => void) {
  visit(node);
  for (const child of Object.values(node.properties ?? {})) walk(child, visit);
  if (node.items) walk(node.items, visit);
  for (const child of node.anyOf ?? []) walk(child, visit);
}
// nullable 객체의 JSON 스키마(anyOf [object, null])에서 객체 쪽을 꺼낸다.
const objectOf = (node: JsonSchemaNode | undefined) =>
  node?.type === "object" ? node : node?.anyOf?.find((item) => item.type === "object");
// 혼합형 기획 초안(픽스처 기획 + 설명 장면 하나).
function hybridDraft() {
  const { copyReview: _review, ...draft } = fixtureVideoPlanning();
  return {
    ...draft,
    durationSec: 40,
    concept: {
      ...draft.concept,
      scenePlan: [
        { scene: "현관에서 멈칫", source: "generated", reason: "상황", explainerScene: null },
        {
          scene: "캡슐 속 오일 과정",
          source: "info_clip",
          reason: "메커니즘",
          explainerScene: {
            sceneType: "process",
            objects: [
              { subjectId: "capsule", appearance: "clay-white capsule shell", color: "accent1" },
              { subjectId: "oil", appearance: "golden oil volume", color: "accent2" },
            ],
            actions: ["The shell splits open", "Oil pours in and rises"],
            emphasis: [{ kind: "glow_line", target: "oil", afterAction: 1 }],
            analogy: "",
          },
        },
      ],
    },
  };
}

test("the default planning policy is hybrid and its prompt separates live scenes from the explainer world", () => {
  expect(DEFAULT_VISUAL_POLICY).toBe("hybrid_explainer_v1");
  const hybrid = videoPlanningInstructions("hybrid_explainer_v1");
  for (const phrase of [
    "HYBRID SCENE PLAN",
    "EXPLAINER WORLD GRAMMAR",
    "There is no graphic source",
    'never write "no people"',
    "explainerScene",
    "sceneType process|comparison|analogy",
    "analogy (English; only for an analogy scene",
    "clay-white 3D models, two brand accent colors",
    '<copy-rhythm-policy id="legacy_rhythm">',
  ])
    expect(hybrid).toContain(phrase);
  expect(hybrid).not.toContain("EXPLANATION PLAN:");
  expect(hybrid).not.toContain("Maintain ivory backgrounds");
  // immersive 기획 프롬프트는 2026-10-06 그대로
  const immersive = videoPlanningInstructions("immersive_explanations_v1");
  expect(immersive).toContain("EXPLANATION PLAN:");
  expect(immersive).toContain("Maintain ivory backgrounds");
  expect(immersive).toContain('<copy-rhythm-policy id="natural_v1">');
  expect(immersive).not.toContain("HYBRID SCENE PLAN");
});

test("the hybrid planning response schema is strict, requires explainerScene per scene and rejects label fields and text cards", () => {
  // Given
  expect(videoPlanningResponseSchemaFor("hybrid_explainer_v1")).toBe(
    HybridVideoPlanningDraftResponseSchema,
  );
  expect(videoPlanningResponseSchemaFor("immersive_explanations_v1")).toBe(
    VideoPlanningDraftResponseSchema,
  );
  // When
  const schema = z.toJSONSchema(HybridVideoPlanningDraftResponseSchema) as JsonSchemaNode;
  // Then: strict(필수 전수·additionalProperties false·default 없음)
  walk(schema, (node) => {
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
    }
    expect("default" in node).toBe(false);
  });
  const item = schema.properties?.["concept"]?.properties?.["scenePlan"]?.items;
  expect(item?.required).toEqual(["scene", "source", "reason", "explainerScene"]);
  expect(item?.properties?.["source"]?.enum).toEqual(["project_asset", "generated", "info_clip"]);
  expect(item?.properties?.["explanation"]).toBeUndefined();
  expect(objectOf(item?.properties?.["explainerScene"])?.required).toEqual([
    "sceneType",
    "objects",
    "actions",
    "emphasis",
    "analogy",
  ]);
  // 유효한 초안은 통과하고 저장 스키마에도 담긴다
  const draft = hybridDraft();
  expect(HybridVideoPlanningDraftResponseSchema.safeParse(draft).success).toBe(true);
  const stored = VideoPlanningSchema.parse({
    ...draft,
    visualPolicy: "hybrid_explainer_v1",
    copyReview: fixtureVideoPlanning().copyReview,
  });
  expect(stored.concept.scenePlan?.[1]?.explainerScene?.sceneType).toBe("process");
  // info_clip 인데 explainerScene 없음 / 실사 장면에 explainerScene 있음 / 비교 색 겹침 / 장면 간 색 불일치 / 비유 없는 analogy
  const scenes = draft.concept.scenePlan;
  const [live, info] = scenes;
  if (!live || !info?.explainerScene) throw new TypeError("fixture needs two scenes");
  const reject = (scenePlan: unknown[]) =>
    HybridVideoPlanningDraftResponseSchema.safeParse({
      ...draft,
      concept: { ...draft.concept, scenePlan },
    }).success;
  expect(reject([live, { ...info, explainerScene: null }])).toBe(false);
  expect(reject([{ ...live, explainerScene: info.explainerScene }, info])).toBe(false);
  expect(
    reject([
      live,
      {
        ...info,
        explainerScene: {
          ...info.explainerScene,
          sceneType: "comparison",
          objects: info.explainerScene.objects.map((object) => ({ ...object, color: "accent1" })),
        },
      },
    ]),
  ).toBe(false);
  expect(
    reject([
      live,
      info,
      {
        ...info,
        explainerScene: {
          ...info.explainerScene,
          objects: info.explainerScene.objects.map((object) =>
            object.subjectId === "oil" ? { ...object, color: "neutral" } : object,
          ),
        },
      },
    ]),
  ).toBe(false);
  expect(
    reject([live, { ...info, explainerScene: { ...info.explainerScene, sceneType: "analogy" } }]),
  ).toBe(false);
  expect(reject([live, { ...info, source: "graphic" }])).toBe(false);
  // 예전 기획은 그대로 읽힌다
  const old = fixtureVideoPlanning();
  expect(VideoPlanningSchema.parse(old)).toEqual(old);
});

test("the real writer and reviewer send the hybrid schema, prompt and anchors when the planning policy is hybrid", async () => {
  // Given
  const fixture = planningHttpFixture();
  try {
    const planning = hybridPlanning();
    // When
    const written = await generateVideoScript(
      fixture.job,
      fixture.hypothesis,
      1,
      fixture.task.signal,
      undefined,
      fixture.connection,
      planning,
    );
    await reviewVideoScript(
      {
        job: fixture.job,
        hypothesis: fixture.hypothesis,
        script: written.value,
        signal: fixture.task.signal,
      },
      fixture.connection,
    );
    // Then: 대본 요청은 혼합형 응답 스키마(explainerAnchor·장면 필드, 이름표 필드 없음)와 혼합형 프롬프트
    const request = fixture.requests.find((item) => item.name === "video_script");
    const schema = request?.schema as JsonSchemaNode | undefined;
    expect(request?.strict).toBe(true);
    expect(schema?.required).toContain("explainerAnchor");
    expect(schema?.properties?.["infoClips"]?.items?.required).toEqual([
      "id",
      "stage",
      "cleanPrompt",
      "infoPrompt",
      "infoLines",
      "plan",
      "sceneType",
      "objects",
      "actions",
      "emphasis",
    ]);
    expect(request?.prompt).toContain("HYBRID PRODUCTION CONTRACT");
    expect(request?.prompt).not.toContain("IMMERSIVE PRODUCTION CONTRACT");
    expect(request?.data["planning"]).toEqual(planning);
    // 픽스처의 혼합형 응답이 저장 대본으로 변환된다(explainerAnchor·장면 필드 보존, 대표 이미지 강제 없음)
    expect(written.value.explainerAnchor).toBe(HYBRID_EXPLAINER_ANCHOR);
    expect(written.value.infoClips.map((clip) => clip.sceneType)).toEqual([
      "process",
      "comparison",
    ]);
    expect(written.value.planning?.visualPolicy).toBe("hybrid_explainer_v1");
    expect(written.repairs?.some((item) => item.includes("대표 이미지"))).toBe(false);
    // 검토 요청: 혼합형 규칙 1c·설명 세계 문법·짧은 호흡 리듬, DATA 에 두 기준
    const review = fixture.requests.find((item) => item.name === "video_script_review");
    expect(review?.prompt).toContain("1c. HYBRID CONTRACT");
    expect(review?.prompt).toContain("EXPLAINER WORLD GRAMMAR");
    expect(review?.prompt).toContain('<copy-rhythm-policy id="legacy_rhythm">');
    expect(review?.prompt).not.toContain("IMMERSIVE PRODUCTION CONTRACT");
    expect(review?.data["explainerAnchor"]).toBe(HYBRID_EXPLAINER_ANCHOR);
    expect(review?.data["visualPolicy"]).toBe("hybrid_explainer_v1");
  } finally {
    fixture.close();
  }
});

test("editing sentences and captions keeps the hybrid anchor, scene fields and policy", () => {
  // Given
  const script = hybridScript();
  // When
  const edited = VideoScriptSchema.parse(
    applyScriptEdit(script, {
      voiceover: [{ index: 2, text: "차이는 캡슐 속 원료예요." }],
      captions: [{ cutIndex: 0, onScreenText: "아침 고민" }],
    }),
  );
  // Then
  expect(edited.voiceover[2]?.text).toBe("차이는 캡슐 속 원료예요.");
  expect(edited.cuts[0]?.onScreenText).toBe("아침 고민");
  expect(edited.explainerAnchor).toBe(script.explainerAnchor);
  expect(edited.infoClips).toEqual(script.infoClips);
  expect(edited.subjects).toEqual(script.subjects);
  expect(edited.planning?.visualPolicy).toBe("hybrid_explainer_v1");
  expect(classifyScriptProblems(edited, expected).hard).toEqual([]);
});

test("the CLI shows the policy, the explainer anchor and each explainer scene", () => {
  // Given
  const view = {
    number: 1,
    script: hybridScript(),
    approvalMode: "required" as const,
    approved: false,
    approval: null,
    review: null,
    synthesized: false,
    pending: [1],
  };
  // When
  const output = formatScriptView(view).join("\n");
  // Then
  expect(output).toContain("혼합형(실사 + 3D 설명)");
  expect(output).toContain("[설명 세계 기준]");
  expect(output).toContain(`- ${HYBRID_EXPLAINER_ANCHOR}`);
  expect(output).toContain("설명 컷 I1 (mechanism)");
  expect(output).toContain("장면: 과정 · 물체: capsule(강조색 1), oil(강조색 2)");
  expect(output).toContain(
    "동작: 1) The capsule shell splits open along its seam 2) Golden olive oil",
  );
  expect(output).toContain(
    "강조: 빨간 외곽선 → capsule (1번째 동작 뒤) · 흰 발광선 → oil (2번째 동작 뒤)",
  );
  expect(output).toContain("장면: 비교 · 물체: capsule(강조색 1), bottle(중립)");
  expect(output).not.toContain("그래픽 순서:");
  // 예전 대본은 그 절이 없다
  const legacy = formatScriptView({ ...view, script: renderScript(1, "concept-1", 36) }).join("\n");
  expect(legacy).not.toContain("[설명 세계 기준]");
  expect(legacy).not.toContain("장면: ");
  expect(legacy).not.toContain("혼합형");
});
