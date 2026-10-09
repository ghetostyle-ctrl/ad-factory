import { expect, test } from "bun:test";
import { z } from "zod";
import { HypothesisSchema } from "../shared/creative-plan";
import { flattenSentences, splitSlowCuts, videoScriptFromResponse } from "../shared/script-repair";
import {
  classifyScriptProblems,
  isScenePlanScript,
  scenePlanProblems,
} from "../shared/script-rules";
import {
  CLIP_PHASE_RANGES_MS,
  CLIP_PHASES,
  calloutWordInText,
  clipPhaseReads,
  clipPlanMissing,
  clipPlanText,
  EMPTY_CLIP_PLAN,
  InfoClipResponseSchema,
  InfoClipSchema,
  isClipPlanEmpty,
  promptSubjectMention,
  SubjectSchema,
  scriptDigestJson,
  subjectKeyWords,
  VEO_CLIP_MS,
  VeoClipResponseSchema,
  VeoClipSchema,
  type VideoScript,
  VideoScriptResponseSchema,
  VideoScriptSchema,
} from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";
import {
  fixtureClipPlan,
  fixtureSubjects,
  flatOf,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

// 장면 계획 계약(2026-10-06, 사용자 3단계 프롬프트 R1~R8): 응답 스키마는 모두 필수, 저장 스키마는 모두 기본값,
// 예전 대본의 다이제스트는 그대로, 새 규칙은 장면 계획 대본에만 hard.
const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const expected = { number: 1, durationSec: 30, hypothesis };
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 30, hasCardSlides: false };
const base = () => longVideoScript(1, hypothesis.id, 30);
const hardOf = (script: VideoScript) => classifyScriptProblems(script, expected).hard;
const softOf = (script: VideoScript) => classifyScriptProblems(script, expected).soft;

type JsonSchemaNode = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  default?: unknown;
};
function walk(node: JsonSchemaNode, visit: (node: JsonSchemaNode) => void) {
  visit(node);
  for (const child of Object.values(node.properties ?? {})) walk(child, visit);
  if (node.items) walk(node.items, visit);
}

test("the phase ranges cover the eight-second clip in order", () => {
  expect(CLIP_PHASES).toEqual(["early", "mid", "late"]);
  expect(CLIP_PHASE_RANGES_MS).toEqual({ early: [0, 3000], mid: [3000, 5500], late: [5500, 8000] });
  expect(CLIP_PHASE_RANGES_MS.late[1]).toBe(VEO_CLIP_MS);
  expect(isClipPlanEmpty(EMPTY_CLIP_PLAN)).toBe(true);
  expect(clipPlanText(EMPTY_CLIP_PLAN)).toBe("");
  expect(clipPlanMissing(EMPTY_CLIP_PLAN)).toEqual([]);
  const partial = { ...fixtureClipPlan("A"), mid: { camera: "", action: "x" } };
  expect(clipPlanMissing(partial)).toEqual(["mid.camera"]);
  expect(clipPlanText(fixtureClipPlan("A"))).toContain("early (0-3s)");
});

test("the response schema requires every scene-plan field and declares no defaults", () => {
  const response = nestedScriptResponse(flatOf(base()));
  expect(VideoScriptResponseSchema.safeParse(response).success).toBe(true);
  const schema = z.toJSONSchema(VideoScriptResponseSchema) as JsonSchemaNode;
  expect(schema.required).toContain("subjects");
  const clip = schema.properties?.["veoClips"]?.items;
  expect(clip?.required).toEqual(["id", "startImagePrompt", "prompt", "plan"]);
  expect(clip?.properties?.["plan"]?.required).toEqual(["early", "mid", "late"]);
  expect(clip?.properties?.["plan"]?.properties?.["early"]?.required).toEqual(["camera", "action"]);
  const info = schema.properties?.["infoClips"]?.items;
  expect(info?.required).toEqual([
    "id",
    "stage",
    "cleanPrompt",
    "infoPrompt",
    "graphicOrder",
    "plan",
    "explanation",
  ]);
  const sentence = schema.properties?.["sentences"]?.items;
  expect(sentence?.required).toContain("callouts");
  expect(sentence?.properties?.["callouts"]?.items?.required).toEqual([
    "word",
    "text",
    "kind",
    "anchor",
    "targetId",
  ]);
  const cut = sentence?.properties?.["cuts"]?.items;
  expect(cut?.required).toContain("goal");
  expect(cut?.required).toContain("phase");
  walk(schema, (node) => expect("default" in node).toBe(false));
  // 응답은 goal·phase·callouts·plan·subjects 가 없으면 거부한다
  const strip = (change: (value: Record<string, unknown>) => Record<string, unknown>) =>
    VideoScriptResponseSchema.safeParse(
      change(structuredClone(response) as Record<string, unknown>),
    ).success;
  expect(
    strip((value) => {
      const { subjects: _subjects, ...rest } = value;
      return rest;
    }),
  ).toBe(false);
  expect(
    strip((value) => {
      const clips = value["veoClips"] as Record<string, unknown>[];
      const { plan: _plan, ...first } = clips[0] ?? {};
      return { ...value, veoClips: [first] };
    }),
  ).toBe(false);
  expect(
    strip((value) => {
      const sentences = value["sentences"] as Record<string, unknown>[];
      const { callouts: _callouts, ...first } = sentences[0] ?? {};
      return { ...value, sentences: [first, ...sentences.slice(1)] };
    }),
  ).toBe(false);
  expect(
    strip((value) => {
      const sentences = value["sentences"] as { cuts: Record<string, unknown>[] }[];
      const first = sentences[0];
      if (!first) throw new Error("fixture sentence missing");
      const { goal: _goal, ...cut } = first.cuts[0] ?? {};
      return { ...value, sentences: [{ ...first, cuts: [cut, ...first.cuts.slice(1)] }] };
    }),
  ).toBe(false);
  // 응답용 클립·설명 컷은 빈 계획을 받지 않고(min 1), graphicOrder 는 2~5줄
  expect(
    VeoClipResponseSchema.safeParse({
      id: "A",
      startImagePrompt: "x",
      prompt: "y",
      plan: EMPTY_CLIP_PLAN,
    }).success,
  ).toBe(false);
  expect(
    InfoClipResponseSchema.safeParse({
      id: "I1",
      stage: "mechanism",
      cleanPrompt: "c",
      infoPrompt: "i",
      graphicOrder: ["only one"],
      plan: fixtureClipPlan("I1"),
    }).success,
  ).toBe(false);
  expect(
    InfoClipResponseSchema.safeParse({
      id: "I1",
      stage: "mechanism",
      cleanPrompt: "c",
      infoPrompt: "i",
      graphicOrder: ["arrow", "ring"],
      plan: fixtureClipPlan("I1"),
      infoLines: ["글자"],
    }).success,
  ).toBe(false);
  expect(SubjectSchema.safeParse({ id: "Woman", traits: "x" }).success).toBe(false);
  expect(SubjectSchema.safeParse({ id: "woman1", traits: "navy blouse" }).success).toBe(true);
});

test("a script stored before scene plans parses with defaults and keeps its digest", () => {
  const current = VideoScriptSchema.parse(base());
  // 장면 계획 이전 JSON: goal/phase/callouts/plan/subjects 키가 없다
  const {
    subjects: _subjects,
    stills: _stills,
    infoClips: _infoClips,
    fixedTitle: _fixedTitle,
    disclaimer: _disclaimer,
    voicePersona: _voicePersona,
    // 혼합형(2026-10-07) 이전 JSON 에는 explainerAnchor 도 없다
    explainerAnchor: _explainerAnchor,
    // 카피 먼저 흐름(2026-10-08) 이전 JSON 에는 flow 도 없다
    flow: _flow,
    ...rest
  } = current;
  const legacy = {
    ...rest,
    cuts: current.cuts.map(({ goal: _goal, phase: _phase, stillId: _stillId, ...cut }) => cut),
    voiceover: current.voiceover.map(
      ({ callouts: _callouts, chainStep: _chainStep, ...voice }) => voice,
    ),
    veoClips: current.veoClips.map(({ plan: _plan, ...clip }) => clip),
  };
  const parsed = VideoScriptSchema.parse(legacy);
  expect(parsed.subjects).toEqual([]);
  expect(parsed.cuts.every((cut) => cut.goal === "" && cut.phase === "")).toBe(true);
  expect(parsed.voiceover.every((voice) => voice.callouts.length === 0)).toBe(true);
  expect(parsed.veoClips.every((clip) => isClipPlanEmpty(clip.plan))).toBe(true);
  expect(scriptDigestJson(parsed)).toBe(JSON.stringify(legacy));
  expect(isScenePlanScript(parsed)).toBe(false);
  // 다시 저장했다가 읽어도 같다(빈 계획이 든 저장본도 읽힌다)
  expect(VideoScriptSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  // 예전 설명 컷(infoLines·motionPrompt)은 그대로 읽히고 새 필드는 기본값
  const info = InfoClipSchema.parse({
    id: "I1",
    stage: "mechanism",
    cleanPrompt: "c",
    infoPrompt: "i",
    infoLines: ["1캡슐 600mg"],
    motionPrompt: "m",
  });
  expect(info).toMatchObject({ graphicOrder: [], plan: EMPTY_CLIP_PLAN });
  expect(VeoClipSchema.parse({ id: "A", startImagePrompt: "s", prompt: "p" }).plan).toEqual(
    EMPTY_CLIP_PLAN,
  );
  // 새 필드가 채워지면 다이제스트가 바뀐다
  expect(scriptDigestJson(current)).not.toBe(scriptDigestJson(parsed));
  expect(scriptDigestJson(current)).toContain('"plan"');
  expect(scriptDigestJson(current)).toContain('"subjects"');
});

test("a cut longer than five seconds is rejected only in scene-plan scripts", () => {
  const script = base();
  // 컷 2(3~5초)·3(5~6초)·4(6~8초)·5(8~9초)를 한 컷 6초로 합친다
  const merged: VideoScript = {
    ...script,
    cuts: script.cuts.flatMap((cut, index) =>
      index === 2 ? [{ ...cut, endSec: 9 }] : index >= 3 && index <= 5 ? [] : [cut],
    ),
    voiceover: script.voiceover.map((voice) => ({ ...voice, fromCut: -1, toCut: -1 })),
  };
  expect(scenePlanProblems(merged).hard).toContainEqual(
    expect.stringContaining("컷 2 길이 6초 — 5초 이하로 나누세요"),
  );
  // 같은 컷 구성이라도 장면 계획 흔적이 없는 예전 대본은 건너뛴다
  const legacy: VideoScript = {
    ...merged,
    subjects: [],
    cuts: merged.cuts.map((cut) => ({ ...cut, goal: "", phase: "" })),
    voiceover: merged.voiceover.map((voice) => ({ ...voice, callouts: [] })),
    veoClips: merged.veoClips.map((clip) => ({ ...clip, plan: EMPTY_CLIP_PLAN })),
  };
  expect(isScenePlanScript(legacy)).toBe(false);
  expect(scenePlanProblems(legacy).hard).toEqual([]);
  // 정확히 5초는 허용
  const five: VideoScript = {
    ...script,
    cuts: script.cuts.flatMap((cut, index) =>
      index === 2 ? [{ ...cut, endSec: 8 }] : index === 3 || index === 4 ? [] : [cut],
    ),
  };
  expect(five.cuts[2]?.endSec).toBe(8);
  expect(scenePlanProblems(five).hard.filter((item) => item.includes("5초 이하로"))).toEqual([]);
});

test("Veo cuts need a phase, other sources must not have one, and legacy scripts are exempt", () => {
  const script = base();
  const noPhase: VideoScript = {
    ...script,
    cuts: script.cuts.map((cut, index) => (index === 0 ? { ...cut, phase: "" } : cut)),
  };
  expect(hardOf(noPhase)).toContainEqual(
    expect.stringContaining("컷 0(클립 A)에 클립 구간(phase)이 없습니다"),
  );
  const strayPhase: VideoScript = {
    ...script,
    cuts: script.cuts.map((cut, index) => (index === 2 ? { ...cut, phase: "late" } : cut)),
  };
  expect(hardOf(strayPhase)).toContainEqual(
    expect.stringContaining("컷 2은 Veo 클립 컷이 아닌데 클립 구간(phase late)"),
  );
  // 예전 대본(phase 전부 ""·계획 없음·콜아웃 없음·subjects 없음·goal 없음)은 phase 필수 규칙을 건너뛴다
  const legacy: VideoScript = {
    ...script,
    subjects: [],
    cuts: script.cuts.map((cut) => ({ ...cut, goal: "", phase: "" })),
    voiceover: script.voiceover.map((voice) => ({ ...voice, callouts: [] })),
    veoClips: script.veoClips.map((clip) => ({ ...clip, plan: EMPTY_CLIP_PLAN })),
  };
  expect(hardOf(legacy)).toEqual([]);
  // 장면 계획 대본인데 클립 계획이 통째로 비면 경고, 일부만 비면 거부
  const unplanned: VideoScript = {
    ...script,
    veoClips: script.veoClips.map((clip) => ({ ...clip, plan: EMPTY_CLIP_PLAN })),
  };
  expect(softOf(unplanned)).toContainEqual(expect.stringContaining("Veo 클립 A에 구간 계획(plan"));
  const partial: VideoScript = {
    ...script,
    veoClips: script.veoClips.map((clip) => ({
      ...clip,
      plan: { ...clip.plan, late: { camera: "", action: "" } },
    })),
  };
  expect(hardOf(partial)).toContainEqual(
    expect.stringContaining(
      "Veo 클립 A의 구간 계획(plan)이 불완전합니다(late.camera, late.action 비어 있음)",
    ),
  );
});

test("phase reads continue inside a phase, warn past its end and reject past the clip end", () => {
  const cuts = [
    { source: "veo_clip", veoClip: "A", phase: "early", startSec: 0, endSec: 2 },
    { source: "still_image", veoClip: "", phase: "", startSec: 2, endSec: 3 },
    { source: "veo_clip", veoClip: "A", phase: "early", startSec: 3, endSec: 4.5 },
    { source: "veo_clip", veoClip: "A", phase: "late", startSec: 4.5, endSec: 6.5 },
    { source: "veo_clip", veoClip: "A", phase: "late", startSec: 6.5, endSec: 8 },
  ];
  expect(clipPhaseReads(cuts)).toEqual([
    { index: 0, clipId: "A", phase: "early", offsetMs: 0, endMs: 2000, phaseEndMs: 3000 },
    { index: 2, clipId: "A", phase: "early", offsetMs: 2000, endMs: 3500, phaseEndMs: 3000 },
    { index: 3, clipId: "A", phase: "late", offsetMs: 5500, endMs: 7500, phaseEndMs: 8000 },
    { index: 4, clipId: "A", phase: "late", offsetMs: 7500, endMs: 9000, phaseEndMs: 8000 },
  ]);
  const script = base();
  // 컷 1(2~3초, mid 1초)을 3초 컷으로 늘리면 mid 구간(2.5초)을 넘어 6초까지 이어 읽는다(경고, 클립 끝 8초 안)
  const spill: VideoScript = {
    ...script,
    cuts: script.cuts.flatMap((cut, index) =>
      index === 1 ? [{ ...cut, endSec: 5 }] : index === 2 ? [] : [cut],
    ),
    voiceover: script.voiceover.map((voice) => ({ ...voice, fromCut: -1, toCut: -1 })),
  };
  expect(scenePlanProblems(spill).soft).toContainEqual(
    expect.stringContaining("컷 1이 Veo 클립 A의 mid 구간(3~5.5초)을 넘어 6초까지 이어 읽습니다"),
  );
  expect(scenePlanProblems(spill).hard.filter((item) => item.includes("클립 끝"))).toEqual([]);
  // late 구간에 2초 + 1초 + … 를 쌓아 8초를 넘기면 거부(총 사용은 8초 이하라 새 규칙이 적는다)
  const overflow: VideoScript = {
    ...script,
    cuts: script.cuts.map((cut, index) =>
      index <= 1
        ? { ...cut, phase: "late" as const }
        : index === 2
          ? { ...cut, source: "veo_clip" as const, veoClip: "A" as const, phase: "late" as const }
          : cut,
    ),
  };
  expect(hardOf(overflow)).toContainEqual(
    expect.stringContaining("Veo 클립 A의 late 구간 컷 2이 클립 끝(8초)을 넘어"),
  );
  expect(hardOf(overflow).filter((item) => item.includes("8초뿐"))).toEqual([]);
  // 같은 클립의 컷이 모두 같은 구간이면 경고
  const samePhase: VideoScript = {
    ...script,
    cuts: script.cuts.map((cut, index) =>
      index === 1 ? { ...cut, phase: "early" as const } : cut,
    ),
  };
  expect(softOf(samePhase)).toContainEqual(
    expect.stringContaining("Veo 클립 A의 컷 0·1이 모두 early 구간만 씁니다"),
  );
  expect(softOf(script).filter((item) => item.includes("구간만 씁니다"))).toEqual([]);
});

test("callouts must name a spoken word in Korean and only speak numbers the sentence says", () => {
  expect(calloutWordInText("600밀리그램이면", "하루 600밀리그램이면 충분해요.")).toBe(true);
  expect(calloutWordInText("충분해요", "하루 600밀리그램이면 충분해요.")).toBe(true);
  expect(calloutWordInText("600", "하루 600밀리그램이면 충분해요.")).toBe(false);
  const script = base();
  const voice = script.voiceover[1];
  if (!voice) throw new Error("fixture sentence missing");
  const withCallouts = (
    text: string,
    callouts: VideoScript["voiceover"][number]["callouts"],
  ): VideoScript => ({
    ...script,
    voiceover: script.voiceover.map((item, index) =>
      index === 1 ? { ...item, text, callouts } : item,
    ),
  });
  const good = withCallouts("하루 600밀리그램이면 충분해요.", [
    { word: "600밀리그램이면", text: "600밀리그램", kind: "label", anchor: "subject" },
    { word: "충분해요.", text: "하루 한 번", kind: "check", anchor: "bottom" },
  ]);
  expect(hardOf(good).filter((item) => item.includes("콜아웃"))).toEqual([]);
  expect(
    hardOf(
      withCallouts("하루 600밀리그램이면 충분해요.", [
        { word: "밀리그램", text: "600밀리그램", kind: "label", anchor: "subject" },
      ]),
    ),
  ).toContainEqual(expect.stringContaining('word "밀리그램"가 문장'));
  expect(
    hardOf(
      withCallouts("하루 600밀리그램이면 충분해요.", [
        { word: "충분해요.", text: "600mg", kind: "label", anchor: "subject" },
      ]),
    ),
  ).toContainEqual(expect.stringContaining("콜아웃 글자에 영문이 있습니다"));
  expect(
    hardOf(
      withCallouts("600밀리그램이면 한 달이에요", [
        { word: "한", text: "30캡슐", kind: "ring", anchor: "right" },
      ]),
    ),
  ).toContainEqual(expect.stringContaining("콜아웃 숫자 30를 이 문장이 말하지 않습니다"));
  // 픽스처의 마지막 문장 콜아웃은 통과한다
  expect(script.voiceover.at(-1)?.callouts.length).toBeGreaterThan(0);
  expect(hardOf(script)).toEqual([]);
});

test("snap zooms adjacent or two in three cuts are warnings", () => {
  const script = base();
  const effects = (indexes: number[]): VideoScript => ({
    ...script,
    cuts: script.cuts.map((cut, index) => ({
      ...cut,
      effect: indexes.includes(index) ? "zoom_punch" : "hard_cut",
    })),
  });
  expect(softOf(effects([4, 5]))).toContainEqual(
    expect.stringContaining("스냅 줌(zoom_punch)이 컷 4·5에 연달아 있습니다"),
  );
  expect(softOf(effects([4, 6]))).toContainEqual(
    expect.stringContaining("스냅 줌(zoom_punch)이 컷 4과 6에 있습니다(연속 3컷에 2개)"),
  );
  expect(softOf(effects([4, 7])).filter((item) => item.includes("스냅 줌"))).toEqual([]);
  expect(hardOf(effects([4, 5])).filter((item) => item.includes("스냅 줌"))).toEqual([]);
});

test("subjects make image prompts carry trait words, and name-only references warn", () => {
  expect(subjectKeyWords("woman in her 30s, navy blouse, tied-back hair")).toEqual([
    "woman",
    "navy",
    "blouse",
    "tied-back",
    "hair",
  ]);
  const woman = fixtureSubjects[0];
  if (!woman) throw new Error("fixture subject missing");
  expect(promptSubjectMention("The same woman as before", woman)).toEqual({
    id: true,
    traits: true,
  });
  expect(promptSubjectMention("A navy blouse on a chair", woman)).toEqual({
    id: false,
    traits: true,
  });
  expect(promptSubjectMention("A bottle on a table", woman)).toEqual({ id: false, traits: false });
  const script = base();
  expect(softOf(script).filter((item) => item.includes("프롬프트"))).toEqual([]);
  const nameOnly: VideoScript = {
    ...script,
    subjects: [{ id: "hero", traits: "silver thermos, matte finish, red lid" }],
    veoClips: script.veoClips.map((clip) => ({
      ...clip,
      startImagePrompt: "Photo of hero on the table, same as the previous scene.",
    })),
  };
  expect(softOf(nameOnly)).toContainEqual(
    expect.stringContaining("Veo 클립 A 시작 이미지 프롬프트가 대상 hero를 이름으로만 가리킵니다"),
  );
  const none: VideoScript = {
    ...script,
    stills: [{ id: "S1", prompt: "An empty street at dawn." }],
    cuts: script.cuts.map((cut, index) =>
      index === 2 ? { ...cut, source: "still_image", stillId: "S1" } : cut,
    ),
  };
  expect(softOf(none)).toContainEqual(
    expect.stringContaining(
      "정지 이미지 S1 프롬프트에 선언한 대상(woman, bottle)의 traits 낱말이 하나도 없습니다",
    ),
  );
  expect(hardOf(none).filter((item) => item.includes("프롬프트"))).toEqual([]);
  // 대상을 선언하지 않은 대본은 검사하지 않는다
  expect(softOf({ ...none, subjects: [] }).filter((item) => item.includes("프롬프트"))).toEqual([]);
});

test("flattening keeps goal, phase, callouts, plan, graphicOrder and subjects, and splitSlowCuts keeps them too", () => {
  const stored = base();
  const response = nestedScriptResponse(flatOf(stored));
  const infoResponse = {
    explanation: null,
    id: "I1" as const,
    stage: "mechanism" as const,
    cleanPrompt: "Close-up of the amber bottle on the kitchen table",
    infoPrompt: "A glowing ring around the capsule, an arrow toward the label",
    graphicOrder: ["A ring grows around the capsule", "An arrow slides toward the label"],
    plan: fixtureClipPlan("I1"),
  };
  const flat = flattenSentences({ ...response, infoClips: [infoResponse] }, ctx);
  expect(flat.subjects).toEqual([...fixtureSubjects]);
  expect(flat.cuts.map((cut) => cut.goal)).toEqual(stored.cuts.map((cut) => cut.goal));
  expect(flat.cuts.map((cut) => cut.phase)).toEqual(stored.cuts.map((cut) => cut.phase));
  expect(flat.voiceover.map((voice) => voice.callouts)).toEqual(
    stored.voiceover.map((voice) => voice.callouts),
  );
  expect(flat.veoClips[0]?.plan).toEqual(fixtureClipPlan("A"));
  const { explanation: _explanation, ...storedInfo } = infoResponse;
  expect(flat.infoClips?.[0]).toEqual({
    ...storedInfo,
    infoLines: [],
    motionPrompt: "",
    sceneType: "",
    objects: [],
    actions: [],
    emphasis: [],
  });
  const { script } = videoScriptFromResponse(response, ctx);
  expect(script.subjects).toEqual([...fixtureSubjects]);
  expect(script.cuts.map((cut) => [cut.goal, cut.phase])).toEqual(
    stored.cuts.map((cut) => [cut.goal, cut.phase]),
  );
  expect(script.voiceover.at(-1)?.callouts).toEqual(stored.voiceover.at(-1)?.callouts ?? []);
  expect(script.veoClips[0]?.plan).toEqual(fixtureClipPlan("A"));
  expect(hardOf(script)).toEqual([]);
  // 호환 진입점은 컷을 나누지 않으며 goal·phase 를 그대로 둔다
  const split = splitSlowCuts(script);
  expect(split.cuts.map((cut) => [cut.goal, cut.phase])).toEqual(
    script.cuts.map((cut) => [cut.goal, cut.phase]),
  );
  expect(split.veoClips).toEqual(script.veoClips);
});

test("a stray phase on a non-Veo cut is repaired, and an info clip without any graphic order is rejected", () => {
  const response = nestedScriptResponse(flatOf(base()));
  const stray = {
    ...response,
    sentences: response.sentences.map((sentence, index) =>
      index === 1
        ? {
            ...sentence,
            cuts: sentence.cuts.map((cut, k) =>
              k === 0 ? { ...cut, phase: "mid" as const } : cut,
            ),
          }
        : sentence,
    ),
  };
  const repaired = videoScriptFromResponse(stray, ctx);
  expect(repaired.repairs).toContainEqual(expect.stringContaining("클립 구간(phase mid) 삭제"));
  expect(repaired.script.cuts[2]?.phase).toBe("");
  const stored = base();
  const emptyOrder: VideoScript = {
    ...stored,
    infoClips: [
      {
        id: "I1",
        stage: "mechanism",
        cleanPrompt: "c",
        infoPrompt: "i",
        infoLines: [],
        motionPrompt: "",
        sceneType: "",
        objects: [],
        actions: [],
        emphasis: [],
        graphicOrder: [],
        plan: fixtureClipPlan("I1"),
      },
    ],
    cuts: stored.cuts.map((cut, index) =>
      index === 1 ? { ...cut, veoClip: "I1" as const, phase: "late" as const } : cut,
    ),
  };
  expect(hardOf(emptyOrder)).toContainEqual(
    expect.stringContaining("설명 컷 I1에 그래픽이 생기는 순서(graphicOrder"),
  );
  // 예전 설명 컷(infoLines 가 글자 역할)은 graphicOrder 가 없어도 받는다
  const legacyInfo: VideoScript = {
    ...emptyOrder,
    infoClips: emptyOrder.infoClips.map((clip) => ({
      ...clip,
      infoLines: ["1캡슐 600mg"],
      motionPrompt: "m",
      plan: EMPTY_CLIP_PLAN,
    })),
  };
  expect(hardOf(legacyInfo).filter((item) => item.includes("graphicOrder"))).toEqual([]);
});

test.each([
  {
    spoken: "오일 원료로 엑스트라 버진 올리브유 백 퍼센트를 담았거든요.",
    label: "100퍼센트",
    accepted: true,
  },
  { spoken: "원재료는 백퍼센트예요.", label: "100퍼센트", accepted: true },
  { spoken: "백 퍼센트의 오일이에요.", label: "100퍼센트", accepted: true },
  { spoken: "100퍼센트를 담았어요.", label: "백 퍼센트", accepted: true },
  { spoken: "올리브유 백 퍼센트를 담았어요.", label: "600밀리그램", accepted: false },
  { spoken: "올리브유 백 퍼센트를 담았어요.", label: "1퍼센트", accepted: false },
  { spoken: "올리브유를 담았어요.", label: "백 퍼센트", accepted: false },
  { spoken: "이백 퍼센트예요.", label: "100퍼센트", accepted: false },
  { spoken: "백오 퍼센트예요.", label: "100퍼센트", accepted: false },
  { spoken: "천백퍼센트예요.", label: "100퍼센트", accepted: false },
  { spoken: "천 백 퍼센트예요.", label: "100퍼센트", accepted: false },
  { spoken: "백 점 오 퍼센트예요.", label: "100퍼센트", accepted: false },
])(
  "spoken percentage $spoken matches only its equivalent callout $label",
  ({ spoken, label, accepted }) => {
    // Given: keep the callout anchor valid, isolating the number-equivalence rule.
    const script = base();
    const word = spoken.split(" ").at(-1);
    if (!word) throw new Error("fixture anchor missing");
    const changed: VideoScript = {
      ...script,
      voiceover: script.voiceover.map((voice, index) =>
        index === 1
          ? {
              ...voice,
              text: spoken,
              callouts: [{ word, text: label, kind: "label", anchor: "subject" }],
            }
          : voice,
      ),
    };
    // When
    const problems = scenePlanProblems(changed).hard.filter((problem) =>
      problem.includes("콜아웃 숫자"),
    );
    // Then
    expect(problems.length === 0).toBe(accepted);
  },
);
