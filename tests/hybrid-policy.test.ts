import { expect, test } from "bun:test";
import { z } from "zod";
import {
  explainerAnchorColorCount,
  explainerSceneProblems,
  hybridProblems,
  isExplainerCut,
  isLiveCut,
  isLiveSceneCut,
  LIVE_PROMPT_FORBIDDEN,
  plannedScenePlanProblems,
} from "../shared/hybrid-script-rules";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  HybridVideoScriptResponseSchema,
  InfoClipSchema,
  isHybrid,
  scriptDigestJson,
  usesNaturalTiming,
  type VideoScript,
  VideoScriptResponseSchema,
  VideoScriptSchema,
  videoPolicyOf,
  videoScriptResponseSchemaFor,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import {
  fixtureClipPlan,
  flatOf,
  HYBRID_EXPLAINER_ANCHOR,
  hybridScriptResponse,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

// 혼합형 정책(hybrid_explainer_v1, 사용자 결정 2026-10-07): 고통·상황·결과·행동 비트는 실사, 메커니즘·기능·비교 비트만 3D 설명 세계.
// 스키마(H3·H4)·규칙(H2·H3·H4·H7·H8)·수리·픽스처 계약을 여기서 보장한다. 예전·immersive 대본은 영향이 없어야 한다.
function requiredHypothesis() {
  const hypothesis = sourcePlanResponse("fact-1").hypotheses[0];
  if (!hypothesis) throw new TypeError("Missing test hypothesis");
  return hypothesis;
}
const hypothesis = requiredHypothesis();
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 36, hasCardSlides: false };
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true };
const hybridPlanning = () =>
  VideoPlanningSchema.parse({ ...fixtureVideoPlanning(), visualPolicy: "hybrid_explainer_v1" });
// 저장 스키마로 한 번 읽어 키 순서를 저장본과 같게 맞춘다(다이제스트 비교용).
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
function walk(
  node: JsonSchemaNode,
  visit: (node: JsonSchemaNode, level: number) => void,
  level = 0,
) {
  visit(node, level);
  for (const child of Object.values(node.properties ?? {})) walk(child, visit, level + 1);
  if (node.items) walk(node.items, visit, level + 1);
  for (const child of node.anyOf ?? []) walk(child, visit, level);
}

test("the hybrid response schema is strict and requires explainerAnchor and the scene fields of each info clip", () => {
  // Given: 정책별 응답 스키마
  expect(videoScriptResponseSchemaFor("hybrid_explainer_v1")).toBe(HybridVideoScriptResponseSchema);
  expect(videoScriptResponseSchemaFor("immersive_explanations_v1")).toBe(VideoScriptResponseSchema);
  expect(videoScriptResponseSchemaFor(undefined)).toBe(VideoScriptResponseSchema);
  // When: json_schema strict 로 내보낸다
  const schema = z.toJSONSchema(HybridVideoScriptResponseSchema) as JsonSchemaNode;
  // Then: 모든 필드 필수, explainerAnchor 는 styleAnchor 바로 뒤, 설명 컷은 이름표 필드 없이 장면 필드만
  expect(schema.required).toEqual([
    "fixedTitle",
    "disclaimer",
    "voicePersona",
    "title",
    "openLoop",
    "payoffSec",
    "styleAnchor",
    "explainerAnchor",
    "subjects",
    "veoClips",
    "stills",
    "infoClips",
    "sentences",
    "flowPrompt",
    "editInstructions",
  ]);
  const info = schema.properties?.["infoClips"]?.items;
  expect(info?.required).toEqual([
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
  expect(info?.properties?.["graphicOrder"]).toBeUndefined();
  expect(info?.properties?.["explanation"]).toBeUndefined();
  // 2026-10-08: INFO 인포그래픽 문구는 혼합형 응답의 필수 필드(1~4줄)다.
  expect(info?.properties?.["infoLines"]).toMatchObject({
    type: "array",
    minItems: 1,
    maxItems: 4,
  });
  expect(info?.properties?.["objects"]?.items?.required).toEqual(["subjectId", "color"]);
  expect(info?.properties?.["emphasis"]?.items?.required).toEqual([
    "kind",
    "target",
    "afterAction",
  ]);
  let depth = 0;
  let enumValues = 0;
  walk(schema, (node, level) => {
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
    }
    expect("default" in node).toBe(false);
    if (node.type === "object" || node.type === "array") depth = Math.max(depth, level + 1);
    enumValues += node.enum?.length ?? 0;
  });
  expect(depth).toBeLessThanOrEqual(6);
  expect(enumValues).toBeLessThan(200);
  // immersive 응답 스키마는 그대로다(explainerAnchor 없음, 설명 컷에 graphicOrder·explanation)
  const immersive = z.toJSONSchema(VideoScriptResponseSchema) as JsonSchemaNode;
  expect(immersive.required).not.toContain("explainerAnchor");
  expect(immersive.properties?.["infoClips"]?.items?.required).toContain("graphicOrder");
  // 혼합형 응답에 이름표 필드를 넣으면 거부한다
  const response = hybridScriptResponse();
  const withOrder = {
    ...response,
    infoClips: response.infoClips.map((clip) => ({ ...clip, graphicOrder: ["a", "b"] })),
  };
  expect(HybridVideoScriptResponseSchema.safeParse(withOrder).success).toBe(false);
  const { explainerAnchor: _anchor, ...withoutAnchor } = response;
  expect(HybridVideoScriptResponseSchema.safeParse(withoutAnchor).success).toBe(false);
});

test("legacy and immersive scripts keep their digest: new stored fields are defaults and are left out", () => {
  // Given: 혼합형 이전 저장본(explainerAnchor·sceneType 없음)
  const legacy = {
    number: 1,
    hypothesisId: "concept-1",
    title: "예전 대본",
    durationSec: 40,
    openLoop: "왜 실패할까?",
    payoffSec: 30,
    cuts: [
      {
        startSec: 0,
        endSec: 2,
        purpose: "hook",
        screenComposition: "첫 장면",
        onScreenText: "",
        source: "veo_clip",
        effect: "hard_cut",
        veoClip: "A",
        graphicKind: "",
        graphicLines: [],
        narration: "안녕하세요",
        veoPrompt: "Motion A.",
      },
      {
        startSec: 2,
        endSec: 40,
        purpose: "cta",
        screenComposition: "마지막",
        onScreenText: "",
        source: "approved_image",
        effect: "hard_cut",
        veoClip: "",
        graphicKind: "",
        graphicLines: [],
        narration: "",
        veoPrompt: "",
      },
    ],
    voiceover: [{ startSec: 0, endSec: 3, text: "안녕하세요" }],
    styleAnchor: "Same woman.",
    veoClips: [{ id: "A", startImagePrompt: "Start A.", prompt: "Motion A." }],
    flowPrompt: "Flow",
    editInstructions: "편집",
  };
  const parsed = VideoScriptSchema.parse(legacy);
  // Then: 기본값이 붙어도 다이제스트 JSON 은 저장본 그대로
  expect(parsed.explainerAnchor).toBe("");
  expect(scriptDigestJson(parsed)).toBe(JSON.stringify(legacy));
  expect(videoPolicyOf(parsed)).toBe("legacy");
  // immersive 설명 컷(graphicOrder·plan)이 있는 대본: 다이제스트 JSON 을 다시 읽어도 같다(장면 필드 기본값 제외)
  const immersive = VideoScriptSchema.parse({
    ...renderScript(1, hypothesis.id, 36),
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    infoClips: [
      InfoClipSchema.parse({
        id: "I1",
        stage: "mechanism",
        cleanPrompt: "Transparent oil capsule",
        infoPrompt: "Oil separates inside a cutaway capsule",
        graphicOrder: ["Shell separates", "Oil volume is revealed"],
        plan: fixtureClipPlan("I1"),
      }),
    ],
  });
  const digest = scriptDigestJson(immersive);
  for (const key of ["explainerAnchor", "sceneType", "objects", "actions", "emphasis"])
    expect(digest).not.toContain(`"${key}"`);
  expect(scriptDigestJson(VideoScriptSchema.parse(JSON.parse(digest)))).toBe(digest);
  expect(videoPolicyOf(immersive)).toBe("immersive");
  expect(isHybrid(immersive)).toBe(false);
  // 혼합형 대본은 새 필드가 다이제스트에 들어간다
  const hybrid = hybridScript();
  expect(videoPolicyOf(hybrid)).toBe("hybrid");
  expect(isHybrid(hybrid)).toBe(true);
  const hybridDigest = scriptDigestJson(hybrid);
  expect(hybridDigest).toContain('"explainerAnchor"');
  expect(hybridDigest).toContain('"sceneType":"process"');
  expect(scriptDigestJson(VideoScriptSchema.parse(JSON.parse(hybridDigest)))).toBe(hybridDigest);
});

test("the hybrid fixture passes every hard rule and leaves no hybrid warning", () => {
  // Given
  const script = hybridScript();
  // When
  const problems = classifyScriptProblems(script, expected);
  const hybrid = hybridProblems(script);
  // Then
  expect(problems.hard).toEqual([]);
  expect(hybrid.hard).toEqual([]);
  expect(hybrid.soft).toEqual([]);
  expect(script.durationSec).toBe(36);
  expect(script.cuts.filter(isExplainerCut)).toHaveLength(6);
  expect(script.cuts.every((cut) => isLiveCut(cut) || isExplainerCut(cut))).toBe(true);
  // 스키마로 저장할 수 있다
  expect(VideoScriptSchema.safeParse(script).success).toBe(true);
});

test("hybrid rules do not touch legacy or immersive scripts", () => {
  // Given: 예전 대본(모션그래픽 컷·"no people" 프롬프트 포함)과 immersive 대본
  const legacy = renderScript(1, hypothesis.id, 36);
  const immersive: VideoScript = {
    ...legacy,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
  };
  // Then
  expect(hybridProblems(legacy)).toEqual({ hard: [], soft: [] });
  expect(hybridProblems(immersive)).toEqual({ hard: [], soft: [] });
  // 예전 정책은 대표 이미지 컷을 여전히 요구한다
  const withoutImage: VideoScript = {
    ...legacy,
    cuts: legacy.cuts.map((cut) =>
      cut.source === "approved_image"
        ? { ...cut, source: "still_image" as const, stillId: "S1" as const }
        : cut,
    ),
    stills: [...legacy.stills, { id: "S1" as const, prompt: "Still S1: kitchen, no text." }],
  };
  expect(
    classifyScriptProblems(withoutImage, expected).hard.some((item) =>
      item.includes("대표 이미지(approved_image)"),
    ),
  ).toBe(true);
});

test("hard: a pain or outcome sentence over an explanation cut, a text panel cut and a non-live ending are rejected", () => {
  // Given: 고통 문장(1번째)의 컷을 설명 클립 I1 로 바꾼다
  const base = hybridScript();
  const painOverInfo: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === 0 ? { ...cut, veoClip: "I1" as const, phase: "early" as const } : cut,
    ),
  };
  const pain = hybridProblems(painOverInfo).hard;
  expect(
    pain.some((item) => item.includes("1번째 문장(pain)") && item.includes("실사가 아닙니다")),
  ).toBe(true);
  expect(pain.some((item) => item.includes("첫 컷은 실사여야"))).toBe(true);
  // 결과 문장(7번째)의 정지 이미지 컷을 모션그래픽으로
  const graphicIndex = base.voiceover[6]?.fromCut ?? -1;
  const panel: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === graphicIndex
        ? {
            ...cut,
            source: "motion_graphic" as const,
            stillId: "" as const,
            graphicKind: "callout" as const,
            graphicLines: ["가벼운 아침"],
          }
        : cut,
    ),
  };
  const hard = hybridProblems(panel).hard;
  expect(hard.some((item) => item.includes("7번째 문장(outcome)"))).toBe(true);
  expect(hard.some((item) => item.includes("글자 패널(motion_graphic)"))).toBe(true);
  // 엔딩을 글자 패널로
  const last = base.cuts.length - 1;
  const textEnding: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === last
        ? {
            ...cut,
            source: "motion_graphic" as const,
            graphicKind: "callout" as const,
            graphicLines: ["지금 비교"],
          }
        : cut,
    ),
  };
  const ending = hybridProblems(textEnding).hard;
  expect(ending.some((item) => item.includes("엔딩이 글자 패널"))).toBe(true);
  // 설명 장면으로 끝내도 거부
  const infoEnding: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === last
        ? { ...cut, source: "veo_clip" as const, veoClip: "I2" as const, phase: "late" as const }
        : cut,
    ),
  };
  expect(
    hybridProblems(infoEnding).hard.some((item) => item.includes("마지막 컷은 실사 + 제품")),
  ).toBe(true);
  // 사슬 밖 연결 문장(bridge)은 소스를 제한하지 않는다
  const bridge: VideoScript = {
    ...painOverInfo,
    voiceover: painOverInfo.voiceover.map((voice, index) =>
      index === 0 ? { ...voice, chainStep: "bridge" as const } : voice,
    ),
  };
  expect(hybridProblems(bridge).hard.some((item) => item.includes("1번째 문장"))).toBe(false);
  // classifyScriptProblems 도 같은 결과를 hard 로 돌려준다
  expect(classifyScriptProblems(panel, expected).hard).toEqual(expect.arrayContaining(hard));
});

test("hard: live prompts that erase people or products, over-long explanation cuts and a missing explainerAnchor are rejected", () => {
  // Given: styleAnchor 와 정지 이미지 프롬프트에 금지 문구
  const base = hybridScript();
  const erased: VideoScript = {
    ...base,
    styleAnchor: `${base.styleAnchor} No people, branded packaging, photographs.`,
    stills: base.stills.map((still) => ({ ...still, prompt: `${still.prompt} no products shown` })),
  };
  const hard = hybridProblems(erased).hard;
  expect(hard.some((item) => item.includes("styleAnchor") && item.includes('"No people"'))).toBe(
    true,
  );
  expect(
    hard.some((item) => item.includes("정지 이미지 S1") && item.includes('"no products"')),
  ).toBe(true);
  // 설명 세계 기준(explainerAnchor 에 "no people, no text")에는 같은 문구가 있어도 된다: 금지 문구 거부는 두 건뿐
  expect(hard.filter((item) => item.includes("실사를 지우는 문구"))).toHaveLength(2);
  expect(erased.explainerAnchor).toMatch(/no people/i);
  // 설명 컷 4초 초과(5초 상한보다 엄격)
  const firstInfo = base.cuts.findIndex(isExplainerCut);
  const long: VideoScript = {
    ...base,
    durationSec: base.durationSec + 1.5,
    cuts: base.cuts.map((cut, index) =>
      index < firstInfo
        ? cut
        : index === firstInfo
          ? { ...cut, endSec: cut.endSec + 1.5 }
          : { ...cut, startSec: cut.startSec + 1.5, endSec: cut.endSec + 1.5 },
    ),
  };
  expect(hybridProblems(long).hard.some((item) => item.includes("설명 컷은 4초 이하"))).toBe(true);
  // explainerAnchor 없음
  expect(
    hybridProblems({ ...base, explainerAnchor: "" }).hard.some((item) =>
      item.includes("explainerAnchor"),
    ),
  ).toBe(true);
});

test("hard: explanation scenes need distinct comparison colors, fixed subject colors, declared objects and real actions", () => {
  // Given: 픽스처의 설명 장면
  const base = hybridScript();
  const [process, comparison] = base.infoClips;
  if (!process || !comparison) throw new TypeError("fixture needs two info clips");
  // 비교 장면의 두 물체가 같은 색
  const sameColor = explainerSceneProblems(
    [
      process,
      {
        ...comparison,
        objects: comparison.objects.map((o) => ({ ...o, color: "accent1" as const })),
      },
    ],
    base.subjects,
  );
  expect(sameColor.hard.some((item) => item.includes("I2(비교)의 물체 색이 겹칩니다"))).toBe(true);
  // 비교 장면 물체 1개
  const single = explainerSceneProblems(
    [{ ...comparison, objects: comparison.objects.slice(0, 1), emphasis: [] }],
    base.subjects,
  );
  expect(single.hard.some((item) => item.includes("물체가 2개 이상"))).toBe(true);
  // 같은 subjectId(capsule)의 색이 장면마다 다름
  const drift = explainerSceneProblems(
    [
      process,
      {
        ...comparison,
        objects: comparison.objects.map((o) =>
          o.subjectId === "capsule" ? { ...o, color: "accent2" as const } : o,
        ),
      },
    ],
    base.subjects,
  );
  expect(drift.hard.some((item) => item.includes("capsule 색(accent2)이 I1의 색(accent1)"))).toBe(
    true,
  );
  // 강조 대상이 물체에 없음, 동작 없음, 선언 안 된 subjectId, 장면 종류 없음
  const broken = explainerSceneProblems(
    [
      {
        ...process,
        actions: [],
        objects: [{ subjectId: "ghost", color: "neutral" }],
        emphasis: [{ kind: "ghost_object", target: "oil", afterAction: 0 }],
      },
    ],
    base.subjects,
  );
  expect(broken.hard.some((item) => item.includes("동작(actions)이 없습니다"))).toBe(true);
  expect(broken.hard.some((item) => item.includes("ghost가 subjects 에 선언되지"))).toBe(true);
  expect(broken.hard.some((item) => item.includes("가리키는 oil이 이 장면의 물체"))).toBe(true);
  const noScene = explainerSceneProblems([{ ...process, sceneType: "" }], base.subjects);
  expect(noScene.hard.some((item) => item.includes("장면 종류(sceneType"))).toBe(true);
  // 픽스처 자체는 통과
  expect(explainerSceneProblems(base.infoClips, base.subjects)).toEqual({ hard: [], soft: [] });
});

test("soft: explanation cuts over half of the video, callouts on an explanation-only sentence and a long ending image warn", () => {
  // Given: 실사 클립 A 의 세 컷(8초)을 I2 설명 컷으로 바꿔 설명 비중을 올린다(24/36 = 67%)
  const base = hybridScript();
  const heavy: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) => (index <= 2 ? { ...cut, veoClip: "I2" as const } : cut)),
    voiceover: base.voiceover.map((voice, index) =>
      index <= 2 ? { ...voice, chainStep: "bridge" as const } : voice,
    ),
  };
  const soft = hybridProblems(heavy).soft;
  expect(soft.some((item) => item.includes("설명 컷이 24초로 전체의 67%"))).toBe(true);
  // 설명 컷뿐인 4번째 문장(requirement)에 콜아웃
  const callout: VideoScript = {
    ...base,
    voiceover: base.voiceover.map((voice, index) =>
      index === 3
        ? {
            ...voice,
            callouts: [
              { word: "원료가", text: "원료", kind: "label" as const, anchor: "subject" as const },
            ],
          }
        : voice,
    ),
  };
  expect(
    hybridProblems(callout).soft.some(
      (item) =>
        item.includes("4번째 문장(requirement)") && item.includes("설명 컷 위라 그리지 않습니다"),
    ),
  ).toBe(true);
  expect(hybridProblems(callout).hard).toEqual([]);
  // 엔딩 승인 이미지 3초 초과
  const last = base.cuts.length - 1;
  const longEnding: VideoScript = {
    ...base,
    durationSec: base.durationSec + 2,
    cuts: base.cuts.map((cut, index) =>
      index === last ? { ...cut, endSec: cut.endSec + 2 } : cut,
    ),
  };
  expect(
    hybridProblems(longEnding).soft.some((item) => item.includes("엔딩의 승인 이미지가 4초")),
  ).toBe(true);
});

test("repair keeps explainerAnchor and the scene fields, clears label fields and does not force an ending card", () => {
  // Given: 혼합형 응답
  const response = hybridScriptResponse();
  // When
  const { script, repairs, warnings } = videoScriptFromResponse(response, ctx);
  // Then: 새 필드 보존, 이름표·graphicOrder·infoLines·explanation 없음
  expect(repairs).toEqual([]);
  expect(warnings).toEqual([]);
  expect(script.explainerAnchor).toBe(response.explainerAnchor);
  expect(script.infoClips.map((clip) => clip.sceneType)).toEqual(["process", "comparison"]);
  expect(script.infoClips[0]?.objects).toEqual(response.infoClips[0]?.objects ?? []);
  expect(script.infoClips[0]?.actions).toEqual(response.infoClips[0]?.actions ?? []);
  expect(script.infoClips[0]?.emphasis).toEqual(response.infoClips[0]?.emphasis ?? []);
  for (const clip of script.infoClips) {
    expect(clip.graphicOrder).toEqual([]);
    expect(clip.infoLines).toEqual(
      response.infoClips.find((item) => item.id === clip.id)?.infoLines ?? [],
    );
    expect(clip.motionPrompt).toBe("");
    expect(clip.explanation).toBeUndefined();
    expect(clip.plan).toEqual(
      response.infoClips.find((item) => item.id === clip.id)?.plan ?? clip.plan,
    );
  }
  // 설명 컷의 veoPrompt 는 구간 계획 문단
  const infoCut = script.cuts.find(isExplainerCut);
  expect(infoCut?.veoPrompt).toContain("early (0-3s)");
  // 승인 이미지 컷이 없어도 마지막 컷을 대표 이미지로 바꾸지 않는다(hybrid 는 immersive 와 같이 엔딩 카드 강제 해제)
  const lastSentence = response.sentences[response.sentences.length - 1];
  if (!lastSentence) throw new TypeError("fixture needs sentences");
  const withoutImage = {
    ...response,
    sentences: response.sentences.map((sentence, index) =>
      index === response.sentences.length - 1
        ? { ...sentence, cuts: sentence.cuts.filter((cut) => cut.source !== "approved_image") }
        : sentence,
    ),
  };
  const repaired = videoScriptFromResponse(withoutImage, { ...ctx, requireApprovedImage: true });
  expect(repaired.repairs.some((item) => item.includes("대표 이미지"))).toBe(false);
  expect(repaired.script.cuts.some((cut) => cut.source === "approved_image")).toBe(false);
  expect(
    classifyScriptProblems({ ...repaired.script, planning: hybridPlanning() }, expected).hard,
  ).toEqual([]);
  // 쓰지 않는 설명 장면 선언은 기존 R6 가 지운다
  const unused = {
    ...response,
    sentences: response.sentences.map((sentence) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut) =>
        cut.veoClip === "I2" ? { ...cut, veoClip: "I1" as const } : cut,
      ),
    })),
  };
  const pruned = videoScriptFromResponse(unused, ctx);
  expect(pruned.script.infoClips.map((clip) => clip.id)).toEqual(["I1"]);
  expect(pruned.repairs.some((item) => item.includes("쓰지 않는 설명 컷 선언 삭제: I2"))).toBe(
    true,
  );
  // 예전 형태의 응답(nestedScriptResponse)은 그대로 변환된다(장면 필드는 기본값)
  const legacy = videoScriptFromResponse(
    nestedScriptResponse(flatOf(longVideoScript(1, hypothesis.id, 30))),
    {
      ...ctx,
      targetSec: 30,
    },
  );
  expect(legacy.script.explainerAnchor).toBe("");
  expect(legacy.script.infoClips).toEqual([]);
});

// --- 검토 지적 수정(2026-10-07) -------------------------------------------------------------------------------
test("without a persuasion chain the beat → source rule falls back to the sentence purpose", () => {
  // Given: 사슬 없는 가설의 대본(프롬프트가 모든 문장을 bridge 로 적는다) — 픽스처 자체는 purpose 로도 통과한다
  const base = hybridScript();
  const chainless: VideoScript = {
    ...base,
    voiceover: base.voiceover.map((voice) => ({ ...voice, chainStep: "bridge" as const })),
  };
  expect(hybridProblems(chainless).hard).toEqual([]);
  // When: 후킹(hook) 문장의 컷을 설명 클립 I1 로 바꾼다
  const hookOverInfo: VideoScript = {
    ...chainless,
    cuts: chainless.cuts.map((cut, index) =>
      index === 0 ? { ...cut, veoClip: "I1" as const, phase: "early" as const } : cut,
    ),
  };
  const hard = hybridProblems(hookOverInfo).hard;
  // Then: purpose 로 판정한 실사 비트 위반이 hard 다
  expect(
    hard.some(
      (item) => item.includes("1번째 문장(purpose hook)") && item.includes("실사가 아닙니다"),
    ),
  ).toBe(true);
  // 메커니즘(mechanism) 문장은 설명 컷을 그대로 쓸 수 있다
  expect(hard.some((item) => item.includes("4번째 문장"))).toBe(false);
  // 사슬이 하나라도 있으면 bridge 문장은 제한하지 않는다(기존 동작)
  const mixed: VideoScript = {
    ...hookOverInfo,
    voiceover: hookOverInfo.voiceover.map((voice, index) =>
      index === 3 ? { ...voice, chainStep: "requirement" as const } : voice,
    ),
  };
  expect(hybridProblems(mixed).hard.some((item) => item.includes("1번째 문장"))).toBe(false);
});

test("hard: an ad card (approved_image) cannot open the video or carry a pain or outcome sentence; the CTA ending may use it", () => {
  const base = hybridScript();
  expect(isLiveSceneCut({ source: "approved_image", veoClip: "" })).toBe(false);
  expect(isLiveCut({ source: "approved_image", veoClip: "" })).toBe(true);
  // 첫 컷을 광고 카드로
  const cardFirst: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === 0
        ? { ...cut, source: "approved_image" as const, veoClip: "" as const, phase: "" as const }
        : cut,
    ),
  };
  expect(hybridProblems(cardFirst).hard.some((item) => item.includes("첫 컷은 실사여야"))).toBe(
    true,
  );
  // 결과(outcome) 문장의 정지 이미지 컷을 광고 카드로
  const outcomeIndex = base.voiceover[6]?.fromCut ?? -1;
  const cardOutcome: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === outcomeIndex
        ? { ...cut, source: "approved_image" as const, stillId: "" as const }
        : cut,
    ),
  };
  expect(
    hybridProblems(cardOutcome).hard.some(
      (item) => item.includes("7번째 문장(outcome)") && item.includes("실사가 아닙니다"),
    ),
  ).toBe(true);
  // 픽스처의 cta 엔딩 승인 이미지(2초)는 그대로 허용
  expect(hybridProblems(base).hard).toEqual([]);
});

test("hard: live prompts are also checked for 'without people' variants and the Veo motion prompt", () => {
  for (const text of [
    "a quiet kitchen without people",
    "a people-free table top",
    "unpopulated street at dawn",
    "an empty of people hallway",
    "No People, branded packaging",
  ])
    expect(LIVE_PROMPT_FORBIDDEN.test(text)).toBe(true);
  for (const text of ["two people at the table", "the product in her hand", "no cyan tones"])
    expect(LIVE_PROMPT_FORBIDDEN.test(text)).toBe(false);
  const base = hybridScript();
  const erased: VideoScript = {
    ...base,
    veoClips: base.veoClips.map((clip) =>
      clip.id === "A" ? { ...clip, prompt: `${clip.prompt} no products shown.` } : clip,
    ),
    stills: base.stills.map((still) => ({ ...still, prompt: `${still.prompt} Without people.` })),
  };
  const hard = hybridProblems(erased).hard;
  expect(
    hard.some((item) => item.includes("Veo 클립 A 동작") && item.includes("no products")),
  ).toBe(true);
  expect(
    hard.some((item) => item.includes("정지 이미지 S1") && item.includes("Without people")),
  ).toBe(true);
});

test("hard: an explainer cut that reads past its phase into the next one is rejected (one phase per cut)", () => {
  // Given: I1 의 mid 컷(2.5초)을 early 로 바꾸면 early 읽기가 3.0→5.5초로 mid 구간까지 이어진다
  const base = hybridScript();
  const firstInfo = base.cuts.findIndex(isExplainerCut);
  const overrun: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === firstInfo + 1 ? { ...cut, phase: "early" as const } : cut,
    ),
  };
  const hard = hybridProblems(overrun).hard;
  expect(
    hard.some(
      (item) =>
        item.includes(`컷 ${firstInfo + 1}(I1 클립`) &&
        item.includes("early 단계(0~3초)를 넘어 5.5초까지") &&
        item.includes("한 단계만"),
    ),
  ).toBe(true);
  // 픽스처(각 컷이 제 단계 안)는 통과
  expect(hybridProblems(base).hard).toEqual([]);
});

test("soft: planned explainer scenes are compared with the storyboard's info clips in order", () => {
  const base = hybridScript();
  const [i1, i2] = base.infoClips;
  if (!i1 || !i2) throw new TypeError("fixture needs two info clips");
  const concept = fixtureVideoPlanning().concept;
  const firstScene = concept.scenePlan?.[0];
  if (!firstScene) throw new TypeError("fixture needs a scene plan");
  const live = { ...firstScene, explanation: null };
  const planned = (clip: typeof i1) => ({
    scene: `설명 장면 ${clip.id}`,
    source: "info_clip" as const,
    reason: "메커니즘은 설명 세계로",
    explanation: null,
    explainerScene: {
      sceneType: clip.sceneType as "process" | "comparison" | "analogy",
      objects: clip.objects.map((object) => ({
        ...object,
        appearance: `${object.subjectId} model`,
      })),
      actions: [...clip.actions],
      emphasis: [...clip.emphasis],
      analogy: "",
    },
  });
  const planningOf = (scenes: ReturnType<typeof planned>[]) =>
    VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
      concept: { ...concept, scenePlan: [live, ...scenes] },
    });
  // 기획과 같으면 경고 없음
  const matching = planningOf([planned(i1), planned(i2)]);
  expect(plannedScenePlanProblems(matching, base.infoClips)).toEqual([]);
  expect(hybridProblems({ ...base, planning: matching }).soft).toEqual([]);
  // 장면 수가 다르고(1 vs 2), 색이 다르고, 동작 수가 다르면 soft
  const first = planned(i1);
  const drifted = planningOf([
    {
      ...first,
      explainerScene: {
        ...first.explainerScene,
        objects: first.explainerScene.objects.map((object) =>
          object.subjectId === "oil" ? { ...object, color: "neutral" as const } : object,
        ),
        actions: first.explainerScene.actions.slice(0, 2),
      },
    },
  ]);
  const soft = plannedScenePlanProblems(drifted, base.infoClips);
  expect(soft.some((item) => item.includes("설명 장면은 1개인데 대본의 설명 컷은 2개"))).toBe(true);
  expect(
    soft.some((item) => item.includes("설명 컷 I1의 물체·색") && item.includes("oil:neutral")),
  ).toBe(true);
  expect(soft.some((item) => item.includes("설명 컷 I1의 동작은 3개인데 기획은 2개"))).toBe(true);
  expect(hybridProblems({ ...base, planning: drifted }).soft).toEqual(expect.arrayContaining(soft));
  // 기획에 설명 장면이 없으면(예전 기획·실사만) 비교하지 않는다
  expect(plannedScenePlanProblems(hybridPlanning(), base.infoClips)).toEqual([]);
  expect(plannedScenePlanProblems(undefined, base.infoClips)).toEqual([]);
});

test("soft: the explainer anchor must name two accent colors and ban people and text; live beats must show a person; the ending must show the product", () => {
  const base = hybridScript();
  expect(explainerAnchorColorCount(HYBRID_EXPLAINER_ANCHOR)).toBe(2);
  expect(explainerAnchorColorCount("Clay-white world, golden gold accents")).toBe(1);
  const vague: VideoScript = {
    ...base,
    explainerAnchor: "Clay-white model world under daylight with one olive accent.",
  };
  const soft = hybridProblems(vague).soft;
  expect(soft.some((item) => item.includes('사람 금지("no people")'))).toBe(true);
  expect(soft.some((item) => item.includes('글자 금지("no text")'))).toBe(true);
  expect(soft.some((item) => item.includes("브랜드 강조색 2개의 이름"))).toBe(true);
  expect(hybridProblems(vague).hard).toEqual([]);
  // 고통 문장(1번째, A early)의 구도·클립 글에서 사람 낱말을 모두 지우면 경고
  const nobody: VideoScript = {
    ...base,
    veoClips: base.veoClips.map((clip) =>
      clip.id === "A"
        ? {
            ...clip,
            prompt: "Two supplement bottles on a kitchen table, morning light.",
            startImagePrompt:
              "Photo of two amber bottles on a bright kitchen table, portrait 9:16.",
            plan: {
              ...clip.plan,
              early: {
                camera: "start wide at the kitchen doorway, dolly in toward the table",
                action: "Light moves across the two bottles",
              },
            },
          }
        : clip,
    ),
    cuts: base.cuts.map((cut, index) =>
      index === 0
        ? { ...cut, screenComposition: "두 병이 놓인 식탁", goal: "두 병 중 고르기" }
        : cut,
    ),
  };
  expect(
    hybridProblems(nobody).soft.some(
      (item) => item.includes("1번째 문장(pain)") && item.includes("사람이 보이지 않습니다"),
    ),
  ).toBe(true);
  // 엔딩을 제품 없는 정지 이미지로 끝내면 경고(실사라 hard 는 아님)
  const last = base.cuts.length - 1;
  const scenery: VideoScript = {
    ...base,
    stills: [...base.stills, { id: "S2" as const, prompt: "Sunny street at morning, soft light." }],
    cuts: base.cuts.map((cut, index) =>
      index === last
        ? {
            ...cut,
            source: "still_image" as const,
            stillId: "S2" as const,
            screenComposition: "아침 거리",
            goal: "하루가 시작된다",
          }
        : cut,
    ),
  };
  const ending = hybridProblems(scenery);
  expect(ending.hard).toEqual([]);
  expect(ending.soft.some((item) => item.includes("엔딩 실사에 제품이 보이지 않습니다"))).toBe(
    true,
  );
  // 픽스처의 엔딩(B late "손에 든 병 클로즈업" + 승인 이미지)은 경고 없음
  expect(hybridProblems(base).soft).toEqual([]);
});

test("the hybrid policy shares the natural timeline timing with immersive; legacy scripts keep the tempo path", () => {
  // 검토 지적(2026-10-07): 내레이션 합성·Flow 클립 길이 검사가 immersive 등호 비교라 혼합형은 예전 타임라인 옵션을 탔다 → 한 헬퍼로 명시.
  expect(usesNaturalTiming(hybridScript())).toBe(true);
  expect(usesNaturalTiming({ planning: { visualPolicy: "immersive_explanations_v1" } })).toBe(true);
  expect(usesNaturalTiming(renderScript(1, hypothesis.id, 36))).toBe(false);
  expect(usesNaturalTiming({})).toBe(false);
});
