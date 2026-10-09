import { expect, test } from "bun:test";
import { z } from "zod";
import {
  classifyScriptProblems,
  scriptFeedback,
  splitSlowCuts,
  verifyLongVideoScript,
  verifyVideoScript,
  videoScriptInstructions,
} from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import {
  CALLOUTS_MAX,
  CUT_GOAL_MAX_CHARS,
  CUT_MAX_SEC,
  FlatScriptSchema,
  fitVoiceover,
  isClipPlanEmpty,
  narrationProblems,
  normalizeSentence,
  STILL_MAX_SEC,
  STILL_SHOTS_MAX,
  scriptDigestJson,
  VEO_SHOTS_MAX,
  type VideoScript,
  VideoScriptResponseSchema,
  VideoScriptReviewIssueResponseSchema,
  VideoScriptReviewIssueSchema,
  VideoScriptReviewSchema,
  VideoScriptSchema,
  videoTargetSeconds,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import {
  fixtureClipPlan,
  fixtureSentence,
  flatOf,
  longVideoScript,
  nestedScriptResponse,
} from "./video-script-fixture";

const script = VideoScriptSchema.parse({
  number: 1,
  hypothesisId: "concept-1",
  title: "상품 사용 장면",
  durationSec: 8,
  cuts: [
    {
      startSec: 0,
      endSec: 3,
      purpose: "hook",
      screenComposition: "첫 화면",
      onScreenText: "후킹",
      narration: "",
      source: "approved_image",
    },
    {
      startSec: 3,
      endSec: 8,
      purpose: "cta",
      screenComposition: "마지막 화면",
      onScreenText: "자세히 보기",
      narration: "자세히 확인해 보세요",
      source: "veo_clip",
    },
  ],
  flowPrompt: "Animate the approved product image in portrait format.",
  editInstructions: "컷별 자막을 시간에 맞게 배치한다.",
});

test("video script accepts only the linked concept and continuous eight-second cuts", () => {
  expect(() => verifyVideoScript(script, 1, "concept-1")).not.toThrow();
  expect(() => verifyVideoScript(script, 2, "concept-1")).toThrow("번호");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) =>
          index === 0 ? { ...cut, source: "veo_clip" as const } : cut,
        ),
      },
      1,
      "concept-1",
    ),
  ).toThrow("대표 이미지");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) => (index === 1 ? { ...cut, startSec: 4 } : cut)),
      },
      1,
      "concept-1",
    ),
  ).toThrow("컷 시간");
});

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);

test("picks a stable 30 to 60 second length per job and video number", () => {
  const lengths = Array.from({ length: 40 }, (_, index) => videoTargetSeconds(`job-${index}`, 1));
  expect(lengths.every((value) => value >= 30 && value <= 60)).toBe(true);
  expect(new Set(lengths).size).toBeGreaterThan(5);
  expect(videoTargetSeconds("job-a", 2)).toBe(videoTargetSeconds("job-a", 2));
});

test("accepts a long script that follows the cut, caption and narration rules", () => {
  for (const seconds of [30, 47, 60]) {
    const long = longVideoScript(1, hypothesis.id, seconds);
    expect(() =>
      verifyLongVideoScript(long, { number: 1, durationSec: seconds, hypothesis }),
    ).not.toThrow();
  }
});

test.each([
  [
    "a length outside the target tolerance",
    (s: VideoScript): VideoScript => ({ ...s }),
    40,
    "길이",
  ],
  [
    "overlapping bound ranges after a cut was removed",
    (s: VideoScript): VideoScript => ({
      ...s,
      // 0~2초·2~3초 컷을 3초 한 컷으로 합친다.
      cuts: s.cuts.flatMap((cut, index) =>
        index === 0 ? [{ ...cut, endSec: 3 }] : index === 1 ? [] : [cut],
      ),
    }),
    30,
    "2초",
  ],
  [
    "a Veo clip reused for more than eight seconds",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) =>
        cut.source === "approved_image"
          ? { ...cut, source: "veo_clip" as const, veoClip: "A" as const, phase: "late" as const }
          : cut,
      ),
    }),
    30,
    "8초뿐",
  ],
  [
    "a cut pointing at an undeclared Veo clip",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i) => (i === 1 ? { ...cut, veoClip: "B" as const } : cut)),
    }),
    30,
    "선언하지 않은",
  ],
  [
    "a motion graphic without lines",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) =>
        cut.source === "motion_graphic" ? { ...cut, graphicLines: [] } : cut,
      ),
    }),
    30,
    "graphicLines",
  ],
  [
    "too much motion graphic",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) =>
        cut.source === "approved_image"
          ? {
              ...cut,
              source: "motion_graphic" as const,
              graphicKind: "callout" as const,
              graphicLines: ["한 알"],
            }
          : cut,
      ),
    }),
    30,
    "모션그래픽이",
  ],
  [
    "an offer on a non-BOFU concept",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i) => (i === 4 ? { ...cut, purpose: "offer" as const } : cut)),
    }),
    30,
    "오퍼",
  ],
])("rejects %s", (_name, mutate, expected, message) => {
  const broken = mutate(longVideoScript(1, hypothesis.id, 30));
  if (_name === "a length outside the target tolerance") {
    const rules = classifyScriptProblems(broken, { number: 1, durationSec: expected, hypothesis });
    expect(rules.hard).toEqual([]);
    expect(rules.soft.length).toBeGreaterThan(0);
  } else
    expect(() =>
      verifyLongVideoScript(broken, { number: 1, durationSec: expected, hypothesis }),
    ).toThrow(message);
});

test.each([
  [
    "a length inside the target tolerance but not equal",
    (s: VideoScript): VideoScript => ({ ...s }),
    33,
    "목표 33초, 실제 30초",
    true,
  ],
  [
    "a caption line over sixteen characters",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, i) =>
        i === 0 ? { ...cut, onScreenText: "열일곱글자가넘는아주긴자막한줄입니다" } : cut,
      ),
    }),
    30,
    "자막",
    true,
  ],
  [
    "too little narration in a legacy unbound script",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) => ({ ...cut, narration: "짧아요." })),
      voiceover: s.voiceover.map((voice, index) => ({
        ...voice,
        text: fixtureSentence(index, 5),
        fromCut: -1,
        toCut: -1,
        callouts: [],
      })),
    }),
    30,
    "내레이션 총량",
    true,
  ],
])("warns about %s without rejecting", (_name, mutate, expected, message, clean) => {
  const broken = mutate(longVideoScript(1, hypothesis.id, 30));
  const rules = classifyScriptProblems(broken, { number: 1, durationSec: expected, hypothesis });
  expect(rules.soft.some((item) => item.includes(message))).toBe(true);
  expect(rules.hard.some((item) => item.includes(message))).toBe(false);
  if (clean) {
    expect(rules.hard).toEqual([]);
    expect(() =>
      verifyLongVideoScript(broken, { number: 1, durationSec: expected, hypothesis }),
    ).not.toThrow();
  }
});

test("a length outside the tolerance is hard, inside is soft, and the feedback puts hard before soft", () => {
  const script = longVideoScript(1, hypothesis.id, 30);
  expect(classifyScriptProblems(script, { number: 1, durationSec: 35, hypothesis }).hard).toEqual(
    [],
  );
  expect(classifyScriptProblems(script, { number: 1, durationSec: 36, hypothesis }).hard).toEqual(
    [],
  );
  const short = { ...script, durationSec: 29 };
  expect(
    classifyScriptProblems(short, { number: 1, durationSec: 36, hypothesis }).hard.join(" "),
  ).toContain("허용 범위 30~60초");
  // hard(영문)와 soft(목표 길이) 가 함께 있으면 피드백은 hard 먼저
  const latin = withSentence(script, 2, "Hello 들어 있어요");
  let message = "";
  try {
    verifyLongVideoScript(latin, { number: 1, durationSec: 33, hypothesis });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message.indexOf("영문이 있습니다")).toBeGreaterThan(0);
  expect(message.indexOf("영문이 있습니다")).toBeLessThan(message.indexOf("목표 33초"));
  expect(scriptFeedback(["a"], ["b"])).toBe("영상 대본 규칙 위반: a / b");
});

test("preserves a five-second shot through the legacy split entrypoint", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  const merged: VideoScript = {
    ...base,
    cuts: base.cuts.flatMap((cut, index) =>
      index === 0 ? [{ ...cut, endSec: 5 }] : index < 3 ? [] : [cut],
    ),
  };
  const split = splitSlowCuts(merged);
  expect(split.cuts).toEqual(merged.cuts);
  expect(split.cuts.at(-1)?.endSec).toBe(30);
});

test("gives a long voiceover sentence more time and pushes the next one back", () => {
  const fitted = fitVoiceover(
    [
      { startSec: 0, endSec: 2, text: "가".repeat(32) },
      { startSec: 2, endSec: 4, text: "나".repeat(10) },
    ],
    30,
  );
  expect(fitted.map((voice) => [voice.startSec, voice.endSec])).toEqual([
    [0, 3],
    [3, 4],
  ]);
  // 끝에서 넘치면 앞으로 당긴다.
  const late = fitVoiceover(
    [
      { startSec: 24, endSec: 26, text: "가".repeat(12) },
      { startSec: 28, endSec: 30, text: "나".repeat(26) },
    ],
    30,
  );
  expect(late.map((voice) => [voice.startSec, voice.endSec])).toEqual([
    [24, 26],
    [27, 30],
  ]);
});

// --- AI 정지 이미지 소스와 Veo 상한 ------------------------------------------------------------
// renderScript 는 카드뉴스 컷도 쓰므로 카드뉴스가 있는 광고안(hypotheses[1])으로 검사한다.
const cardHypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[1]);
const stillScript = (seconds = 36) => renderScript(1, cardHypothesis.id, seconds);
const verifyStill = (value: VideoScript, seconds = 36) =>
  verifyLongVideoScript(value, {
    number: 1,
    durationSec: seconds,
    hypothesis: cardHypothesis,
    hasProjectClips: true,
  });

test("accepts scripts that mix Veo, still images, graphics and images at every length", () => {
  for (const seconds of [30, 36, 45, 60]) {
    const mixed = stillScript(seconds);
    expect(mixed.cuts.some((cut) => cut.source === "still_image")).toBe(true);
    expect(mixed.stills.length).toBeGreaterThan(0);
    expect(() => verifyStill(mixed, seconds)).not.toThrow();
  }
});

test.each([
  [
    "a still image cut without a still id",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) => (cut.stillId === "S1" ? { ...cut, stillId: "" as const } : cut)),
    }),
    "정지 이미지 컷만",
  ],
  [
    "a cut pointing at an undeclared still image",
    (s: VideoScript): VideoScript => ({
      ...s,
      stills: s.stills.filter((still) => still.id !== "S2"),
    }),
    "선언하지 않은 정지 이미지 S2",
  ],
  [
    "a still id on a cut that is not a still image",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut, index) => (index === 4 ? { ...cut, stillId: "S1" as const } : cut)),
    }),
    "정지 이미지 컷만",
  ],
  [
    "a still image cut that also names a Veo clip",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) => (cut.stillId === "S1" ? { ...cut, veoClip: "A" as const } : cut)),
    }),
    "Veo 클립 컷만",
  ],
  [
    "stills without a shared style anchor",
    (s: VideoScript): VideoScript => ({ ...s, styleAnchor: "" }),
    "styleAnchor",
  ],
  [
    "more Veo clips than the new limit",
    (s: VideoScript): VideoScript => ({
      ...s,
      veoClips: [
        ...s.veoClips,
        {
          id: "E",
          startImagePrompt: "Fifth start frame.",
          prompt: "Fifth motion.",
          plan: fixtureClipPlan("E"),
        },
      ],
    }),
    `Veo 클립은 영상 1편에 ${VEO_SHOTS_MAX}개까지`,
  ],
  [
    "Veo cuts that take more than half of the video",
    (s: VideoScript): VideoScript => ({
      ...s,
      cuts: s.cuts.map((cut) =>
        cut.source === "still_image"
          ? { ...cut, source: "veo_clip" as const, stillId: "" as const, veoClip: "D" as const }
          : cut,
      ),
      stills: [],
    }),
    "전체의 50%를 넘습니다",
  ],
])("rejects %s", (_name, mutate, message) => {
  expect(() => verifyStill(mutate(stillScript()))).toThrow(message);
});

test("a declared still image no cut uses is only a warning (the converter removes it before this point)", () => {
  const unused: VideoScript = {
    ...stillScript(),
    stills: [...stillScript().stills, { id: "S9", prompt: "Unused still, photographic, no text." }],
  };
  expect(() => verifyStill(unused)).not.toThrow();
  const rules = classifyScriptProblems(unused, {
    number: 1,
    durationSec: 36,
    hypothesis: cardHypothesis,
    hasProjectClips: true,
  });
  expect(rules.soft).toContain("선언한 정지 이미지 S9를 쓰는 컷이 없습니다.");
});

test("the still image limits are the documented constants", () => {
  expect(VEO_SHOTS_MAX).toBe(4);
  expect(STILL_SHOTS_MAX).toBe(14);
  expect(STILL_MAX_SEC).toBe(4);
});

// 모델 응답 형식(2026-10-04, 문장 우선·컷 중첩): 문장마다 그 아래 컷을 적고, 초·컷 번호·number/hypothesisId/durationSec 은 적지 않는다.
type JsonSchemaNode = {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  default?: unknown;
};
function walk(
  node: JsonSchemaNode,
  visit: (node: JsonSchemaNode, depth: number) => void,
  depth = 0,
) {
  visit(node, depth);
  for (const child of Object.values(node.properties ?? {})) walk(child, visit, depth + 1);
  if (node.items) walk(node.items, visit, depth + 1);
}

test("the nested script response schema is strict, shallow and rejects the fields the app derives", () => {
  const response = nestedScriptResponse(flatOf(stillScript()));
  expect(VideoScriptResponseSchema.safeParse(response).success).toBe(true);
  const withCut = (cut: Partial<Record<string, unknown>>) => ({
    ...response,
    sentences: response.sentences.map((sentence, index) =>
      index === 0
        ? {
            ...sentence,
            cuts: sentence.cuts.map((item, k) => (k === 0 ? { ...item, ...cut } : item)),
          }
        : sentence,
    ),
  });
  // 클립 E 선언·veoClip E·stillId S15·영상 길이를 넘는 len·컷 안의 startSec 은 거부
  expect(
    VideoScriptResponseSchema.safeParse({
      ...response,
      veoClips: [...response.veoClips, { id: "E", startImagePrompt: "x", prompt: "y" }],
    }).success,
  ).toBe(false);
  expect(VideoScriptResponseSchema.safeParse(withCut({ veoClip: "E" })).success).toBe(false);
  expect(VideoScriptResponseSchema.safeParse(withCut({ stillId: "S15" })).success).toBe(false);
  expect(VideoScriptResponseSchema.safeParse(withCut({ len: 61 })).success).toBe(false);
  expect(VideoScriptResponseSchema.safeParse(withCut({ startSec: 0 })).success).toBe(false);
  // 앱이 유도하는 필드(number·hypothesisId·durationSec·cuts·fromCut)는 응답에 없어야 한다(strict)
  for (const extra of [{ number: 1 }, { hypothesisId: "c" }, { durationSec: 36 }, { cuts: [] }])
    expect(VideoScriptResponseSchema.safeParse({ ...response, ...extra }).success).toBe(false);
  expect(
    VideoScriptResponseSchema.safeParse({
      ...response,
      sentences: response.sentences.map((sentence, index) =>
        index === 0 ? { ...sentence, fromCut: 0 } : sentence,
      ),
    }).success,
  ).toBe(false);
  const { stills: _stills, ...withoutStills } = response;
  expect(VideoScriptResponseSchema.safeParse(withoutStills).success).toBe(false);
  // json_schema strict: 필수 목록·additionalProperties:false·default 없음·중첩 ≤ 6단·enum 값 총합 < 100
  const schema = z.toJSONSchema(VideoScriptResponseSchema) as JsonSchemaNode;
  expect(schema.required).toEqual([
    "fixedTitle",
    "disclaimer",
    "voicePersona",
    "title",
    "openLoop",
    "payoffSec",
    "styleAnchor",
    "subjects",
    "veoClips",
    "stills",
    "infoClips",
    "sentences",
    "flowPrompt",
    "editInstructions",
  ]);
  const sentence = schema.properties?.["sentences"]?.items;
  expect(sentence?.required).toEqual([
    "purpose",
    "chainStep",
    "text",
    "callouts",
    "actionSync",
    "cuts",
  ]);
  const cut = sentence?.properties?.["cuts"]?.items;
  expect(cut?.required).toHaveLength(11);
  expect(cut?.required).toContain("len");
  expect(cut?.required).toContain("goal");
  expect(cut?.required).toContain("phase");
  let depth = 0;
  let enumValues = 0;
  walk(schema, (node, level) => {
    if (node.type === "object") expect(node.additionalProperties).toBe(false);
    expect("default" in node).toBe(false);
    if (node.type === "object" || node.type === "array") depth = Math.max(depth, level + 1);
    enumValues += node.enum?.length ?? 0;
  });
  expect(depth).toBeLessThanOrEqual(6);
  // OpenAI json_schema strict 의 enum 값 상한은 전체 1000개다. 장면 계획(phase·콜아웃 kind/anchor)이 더해져 101개이며 200 안에 둔다.
  expect(enumValues).toBeLessThan(200);
  // 평면 중간 형태(FlatScriptSchema)는 fromCut/toCut 문장을 그대로 받는다(픽스처·편집 경로용)
  const flat = flatOf(stillScript());
  expect(FlatScriptSchema.safeParse(flat).success).toBe(true);
  const flatSchema = z.toJSONSchema(FlatScriptSchema) as JsonSchemaNode;
  expect(flatSchema.properties?.["voiceover"]?.items?.required).toEqual([
    "fromCut",
    "toCut",
    "purpose",
    "text",
    "chainStep",
    "callouts",
  ]);
});

test("a script stored before still images existed still parses with empty defaults", () => {
  // 이 변경 전에 저장된 대본 JSON: stills·stillId 가 없고 Veo 클립 E(5번째)와 예전 목적(problem)이 있다.
  const old = {
    number: 1,
    hypothesisId: "concept-1",
    title: "예전 영상 대본",
    durationSec: 40,
    openLoop: "왜 매번 실패할까?",
    payoffSec: 30,
    cuts: [
      {
        startSec: 0,
        endSec: 2,
        purpose: "hook",
        screenComposition: "첫 장면",
        onScreenText: "후킹",
        narration: "안녕하세요",
        source: "veo_clip",
        effect: "zoom_punch",
        veoClip: "E",
        veoPrompt: "Motion of the fifth clip.",
        graphicKind: "",
        graphicLines: [],
      },
      {
        startSec: 2,
        endSec: 40,
        purpose: "problem",
        screenComposition: "나머지",
        onScreenText: "",
        narration: "",
        source: "approved_image",
      },
    ],
    voiceover: [{ startSec: 0, endSec: 3, text: "안녕하세요" }],
    styleAnchor: "Same woman in her 30s.",
    veoClips: ["A", "B", "C", "D", "E"].map((id) => ({
      id,
      startImagePrompt: `Start frame ${id}.`,
      prompt: `Motion ${id}.`,
    })),
    flowPrompt: "Flow",
    editInstructions: "편집",
  };
  const parsed = VideoScriptSchema.parse(old);
  expect(parsed.stills).toEqual([]);
  expect(parsed.cuts.every((cut) => cut.stillId === "")).toBe(true);
  // 컷 범위가 없던 음성 문장은 -1·"" 로 읽히고 범위는 시간에서 유도한다
  expect(parsed.voiceover[0]).toEqual({
    startSec: 0,
    endSec: 3,
    text: "안녕하세요",
    fromCut: -1,
    toCut: -1,
    purpose: "",
    chainStep: "",
    callouts: [],
  });
  // 장면 계획(2026-10-06) 이전 대본: 컷 goal/phase·클립 plan·subjects 는 기본값으로 읽힌다
  expect(parsed.cuts.every((cut) => cut.goal === "" && cut.phase === "")).toBe(true);
  expect(parsed.veoClips.every((clip) => isClipPlanEmpty(clip.plan))).toBe(true);
  expect(parsed.subjects).toEqual([]);
  expect(parsed.cuts[0]?.veoClip).toBe("E");
  expect(parsed.veoClips).toHaveLength(5);
  // 다시 저장했다가 읽어도 같다(저장 형식이 안정적이다).
  expect(VideoScriptSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  // 클립이 8개(A~H)인 예전 대본도 읽힌다.
  expect(
    VideoScriptSchema.safeParse({
      ...old,
      veoClips: ["A", "B", "C", "D", "E", "F", "G", "H"].map((id) => ({
        id,
        startImagePrompt: `S ${id}`,
        prompt: `M ${id}`,
      })),
    }).success,
  ).toBe(true);
});

// --- 나레이션 문장 규칙(2026-10-04, 첫 실전 영상의 메모체·영문·출처 낭독·반복 문제) ------------------------
const withSentence = (s: VideoScript, index: number, text: string): VideoScript => ({
  ...s,
  voiceover: s.voiceover.map((voice, i) => (i === index ? { ...voice, text } : voice)),
});
test.each([
  ["Latin letters in a sentence", "Chong Kun Dang 600mg 확인", "영문이 있습니다"],
  ["a memo-style example marker", "예: 종근당 상품명이 근거가 됩니다", "메모·출처 표기"],
  ["a full-width colon example marker", "예： 상품명 자체가 단서", "메모·출처 표기"],
  ["a source citation", "출처 표기가 있으면 단서가 됩니다", "메모·출처 표기"],
  ["a FACT marker", "FACT 하루 한 알이면 충분합니다", "메모·출처 표기"],
  ["a sourceId", "sourceId 12 참고", "메모·출처 표기"],
  ["a sentence shorter than four characters", "네.", "4자보다 짧습니다"],
  // 실전 1편(2026-10-04)에서 영문만 한글로 바꾸면 통과하던 메모체·지어낸 인물 문장
  ["a memo note ending in a bare noun", "600밀리그램, 30캡슐도 확인.", "메모체 문장"],
  ["a label note ending in 표기", "그리고 엑스트라 버진 표기.", "메모체 문장"],
  ["a fragment ending in a particle", "라벨 표기의", "메모체 문장"],
  ["a bare noun ending in 법", "원료를 우선하는 선택법.", "메모체 문장"],
  ["an invented persona with 씨", "원료를 우선하는 박씨의 선택법.", '지어낸 인물 이름("박씨")'],
  ["an invented persona with a space before 씨", "지은 씨는 매일 이걸 먹어요", "지어낸 인물 이름"],
  ["an invented persona with a job title", "김대리가 추천했어요", '지어낸 인물 이름("김대리")'],
])("rejects narration with %s", (_name, text, message) => {
  const broken = withSentence(longVideoScript(1, hypothesis.id, 30), 2, text);
  expect(() => verifyLongVideoScript(broken, { number: 1, durationSec: 30, hypothesis })).toThrow(
    message,
  );
  expect(narrationProblems(broken.voiceover).join("\n")).toContain(message);
});

test("ordinary spoken sentences with 씨-words, 로-endings and job words are not false positives", () => {
  const fine = [
    "오늘 날씨 추운데 손이 시려요.",
    "솜씨 좋은 분들도 이건 어려워요.",
    "아저씨도 아가씨도 다 같은 고민이에요.",
    "진짜로 효과가 있는 걸까요?",
    "이 대표 성분이 핵심이에요.",
    "영업부장도 놀랐어요.",
    "씨앗부터 다릅니다.",
    "방법은 간단해요!",
    "마음씨 좋은 분들께 드려요",
  ].map((text, index) => ({ startSec: index * 3, text }));
  expect(narrationProblems(fine)).toEqual([]);
});

test("rejects a sentence that nearly repeats an earlier one, not merely a shared phrase", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  const near = withSentence(
    withSentence(base, 1, "하루 한 알이면 충분해요."),
    4,
    "하루 한 알이면 충분해요, 진짜로.",
  );
  expect(narrationProblems(near.voiceover).join("\n")).toContain(
    `5번째 문장(${base.voiceover[4]?.startSec}초): 2번째 문장과 거의 같은 말을 되풀이합니다`,
  );
  // 같은 낱말을 쓰지만 다른 말은 반복이 아니다
  const different = withSentence(
    withSentence(base, 1, "라벨을 보면 바로 알 수 있어요."),
    4,
    "라벨만 보면 바로 알아요.",
  );
  expect(narrationProblems(different.voiceover)).toEqual([]);
});

test("rejects the same sentence spoken twice even when spacing and punctuation differ", () => {
  const base = longVideoScript(1, hypothesis.id, 30);
  const repeated = withSentence(
    withSentence(base, 1, "하루 한 알이면 충분해요."),
    4,
    "하루 한 알이면, 충분해요",
  );
  expect(() => verifyLongVideoScript(repeated, { number: 1, durationSec: 30, hypothesis })).toThrow(
    "같은 문장이 반복됩니다",
  );
  expect(normalizeSentence("하루 한 알이면, 충분해요!")).toBe(
    normalizeSentence("하루 한 알이면 충분해요."),
  );
  // 숫자와 한글만 있는 자연스러운 문장은 통과한다 — 2번째 문장은 "600mg" 글줄을 보이는 모션그래픽 컷(3)에 묶여 있다
  expect(base.voiceover[1]).toMatchObject({ fromCut: 2, toCut: 3 });
  expect(base.cuts[3]?.graphicLines).toEqual(["600mg"]);
  const fine = withSentence(base, 1, "600밀리그램이면 한 달이에요");
  expect(() =>
    verifyLongVideoScript(fine, { number: 1, durationSec: 30, hypothesis }),
  ).not.toThrow();
  expect(narrationProblems(fine.voiceover)).toEqual([]);
  // 화면에 없는 숫자(30)를 말하면 말과 그림 규칙이 거부한다
  expect(() =>
    verifyLongVideoScript(withSentence(base, 1, "600밀리그램 30캡슐이면 한 달이에요"), {
      number: 1,
      durationSec: 30,
      hypothesis,
    }),
  ).toThrow("숫자 30가 묶인 컷[2~3]의 화면");
});

test("every narration rule violation is reported at once with the sentence position", () => {
  const broken = withSentence(
    withSentence(longVideoScript(1, hypothesis.id, 30), 0, "Extra Virgin 예: 출처"),
    1,
    "네.",
  );
  const problems = narrationProblems(broken.voiceover);
  expect(problems.filter((item) => item.startsWith("1번째 문장(0초)"))).toHaveLength(2);
  expect(
    problems.some((item) => item.startsWith("2번째 문장(3초)") && item.includes("짧습니다")),
  ).toBe(true);
});

test("the AI script review response schema is strict and the stored form defaults", () => {
  expect(
    VideoScriptReviewSchema.safeParse({
      status: "revise",
      summary: "메모체",
      issues: [{ sentenceIndex: 0, cutIndexes: [], problem: "메모체", fix: "말 걸기" }],
    }).success,
  ).toBe(true);
  // 모델 응답은 cutIndexes 를 반드시 담고(strict), 저장본(예전 검토 기록)은 없으면 [] 로 읽는다
  expect(
    VideoScriptReviewSchema.safeParse({
      status: "revise",
      summary: "메모체",
      issues: [{ sentenceIndex: 0, problem: "메모체", fix: "말 걸기" }],
    }).success,
  ).toBe(false);
  expect(
    VideoScriptReviewIssueSchema.parse({ sentenceIndex: 1, problem: "p", fix: "f" }).cutIndexes,
  ).toEqual([]);
  const issue = z.toJSONSchema(VideoScriptReviewIssueResponseSchema) as { required?: string[] };
  expect(issue.required).toEqual(["sentenceIndex", "cutIndexes", "problem", "fix"]);
  expect(
    VideoScriptReviewSchema.safeParse({ status: "pass", summary: "좋음", issues: [], extra: 1 })
      .success,
  ).toBe(false);
  expect(
    VideoScriptReviewSchema.safeParse({ status: "maybe", summary: "x", issues: [] }).success,
  ).toBe(false);
  // json_schema strict 모드: 모든 필드가 required 이고 추가 속성이 없어야 한다
  const schema = z.toJSONSchema(VideoScriptReviewSchema) as {
    required?: string[];
    additionalProperties?: boolean;
  };
  expect(schema.required).toEqual(["status", "issues", "summary"]);
  expect(schema.additionalProperties).toBe(false);
});

test("reference rhythm preserves fractional cuts and legacy digest defaults", () => {
  const old = longVideoScript(1, hypothesis.id, 30);
  const parsed = VideoScriptSchema.parse(old);
  expect(parsed).toMatchObject({ fixedTitle: [], disclaimer: "", voicePersona: "" });
  const response = nestedScriptResponse(flatOf(old));
  const first = response.sentences[0]?.cuts[0];
  if (!first || !response.sentences[0]) throw new Error("fixture lacks first cut");
  response.sentences[0].cuts = [
    { ...first, len: 0.5 },
    { ...first, len: 2.5 },
  ];
  expect(VideoScriptResponseSchema.safeParse(response).success).toBe(true);
});

test("storytelling persona allows narrative nominal endings but not memo markers or invented people", () => {
  const lines = [{ startSec: 0, text: "매일 챙길 시간을 정해 두니까 훨씬 편해졌음." }];
  expect(narrationProblems(lines)).not.toEqual([]);
  expect(narrationProblems(lines, "storytelling")).toEqual([]);
  expect(
    narrationProblems([{ startSec: 0, text: "출처: 기록을 확인했음." }], "storytelling").length,
  ).toBeGreaterThan(0);
  expect(
    narrationProblems([{ startSec: 0, text: "김대리가 매일 챙겼음." }], "storytelling").length,
  ).toBeGreaterThan(0);
  expect(
    narrationProblems([{ startSec: 0, text: "제품의 함량 확인." }], "storytelling").length,
  ).toBeGreaterThan(0);
});

test("metadata defaults keep old script serialization stable and explicit metadata changes it", () => {
  const current = VideoScriptSchema.parse(longVideoScript(1, hypothesis.id, 30));
  const {
    fixedTitle: _title,
    disclaimer: _disclaimer,
    voicePersona: _persona,
    stills: _stills,
    infoClips: _infoClips,
    // 혼합형(2026-10-07) 이전 JSON 에는 explainerAnchor 도 없다
    explainerAnchor: _explainerAnchor,
    // 카피 먼저 흐름(2026-10-08) 이전 JSON 에는 flow 도 없다
    flow: _flow,
    ...old
  } = current;
  // 예전 저장 형식: 기본값인 필드(stillId·chainStep, 장면 계획의 빈 phase·빈 callouts)는 없었다. 값이 있는 goal·phase·plan·subjects 는 남는다.
  const withoutKeys = (record: Record<string, unknown>, drop: (key: string) => boolean) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key)));
  const legacy = {
    ...old,
    cuts: old.cuts.map((cut) =>
      withoutKeys(cut, (key) => key === "stillId" || (key === "phase" && cut.phase === "")),
    ),
    voiceover: old.voiceover.map((voice) =>
      withoutKeys(
        voice,
        (key) => key === "chainStep" || (key === "callouts" && voice.callouts.length === 0),
      ),
    ),
  };
  const saved = VideoScriptSchema.parse(legacy);
  expect(scriptDigestJson(saved)).toBe(JSON.stringify(legacy));
  expect(scriptDigestJson({ ...saved, fixedTitle: ["내 제품"] })).not.toBe(JSON.stringify(legacy));
});

// 장면 계획(2026-10-06 R1~R8) 프롬프트 문구: 새 절이 있고, 설명 컷 절은 모드에 따라 바뀌며, 예시 문장에 콜아웃이 든다.
test("the script prompt carries the scene-plan sections and the callout example", () => {
  const flow = videoScriptInstructions({
    seconds: 36,
    hypothesis,
    hasClips: false,
    infoClips: true,
  });
  for (const section of [
    "SCENES:",
    "SUBJECTS:",
    "CLEAN KEYFRAMES:",
    "CLIP PLAN:",
    "INFO CLIPS:",
    "CUT PHASE:",
    "CALLOUTS:",
    "SNAP ZOOM:",
    "JSON SHAPE:",
  ])
    expect(flow).toContain(section);
  expect(flow).toContain(`never longer than ${CUT_MAX_SEC} seconds`);
  expect(flow).toContain(`≤${CUT_GOAL_MAX_CHARS} chars`);
  expect(flow).toContain("early 0–3s, mid 3–5.5s, late 5.5–8s");
  expect(flow).toContain(`up to ${CALLOUTS_MAX} callouts`);
  expect(flow).toContain("never on adjacent cuts");
  expect(flow).toContain("graphicOrder (2–5 English lines");
  // 예시 문장: 콜아웃 word 는 문장의 어절 그대로, text 의 숫자는 문장이 말하고 컷 자막에 보인다
  expect(flow).toContain('"callouts":[{"word":"600밀리그램을","text":"600밀리그램"');
  expect(flow).toContain('"goal":"캡슐 하나에 600밀리그램이 들어 있다"');
  expect(flow).toContain('"phase":"late"');
  // 설명 컷의 글자 줄(infoLines)·움직임 글(motionPrompt)은 더 이상 받지 않는다(글자는 앱이 콜아웃으로 그린다)
  expect(flow).not.toContain("infoLines");
  expect(flow).not.toContain("motionPrompt");
  // API 모드: 설명 컷은 없지만 클립 계획·구간 규칙은 그대로
  const api = videoScriptInstructions({ seconds: 36, hypothesis, hasClips: false });
  expect(api).toContain("infoClips must be []");
  expect(api).toContain("CLIP PLAN:");
  expect(api).toContain("CUT PHASE:");
  expect(api).not.toContain("graphicOrder (2–5");
  // 피드백은 끝에 붙는다
  expect(
    videoScriptInstructions({ seconds: 36, hypothesis, hasClips: false, feedback: "컷 2 길이" }),
  ).toContain("FIX THESE PREVIOUS ISSUES: 컷 2 길이");
});

// 혼합형(hybrid_explainer_v1, 2026-10-07) 프롬프트 문구: 비트→소스 표, 두 anchor, 설명 장면 필드, 글자 없음, 콜아웃은 실사 문장만,
// 엔딩, 설명 컷 2~4초, 짧은 호흡 리듬. immersive 프롬프트는 그대로다.
test("the hybrid script prompt carries the hybrid contract and drops the label-based info clip fields", () => {
  const hybrid = videoScriptInstructions({
    seconds: 36,
    hypothesis,
    hasClips: false,
    infoClips: true,
    hybrid: true,
  });
  for (const phrase of [
    "HYBRID PRODUCTION CONTRACT",
    "BEAT → SOURCE",
    "TWO ANCHORS",
    "EXPLAINER SCENES",
    "EXPLAINER WORLD GRAMMAR",
    "INFO CLIPS (explainer scenes)",
    "motion_graphic is not available in this policy",
    "Explainer cuts (I1..I3) last 2–4 seconds",
    "callouts belong only to sentences with live-action cuts",
    "explainerAnchor, subjects[{id, traits}]",
    "infoClips[{id, stage, cleanPrompt, infoPrompt, infoLines[], plan, sceneType, objects[{subjectId, color}], actions[], emphasis[{kind, target, afterAction}]}]",
    "EXAMPLE EXPLAINER SCENE AND SENTENCE",
    '<copy-rhythm-policy id="legacy_rhythm">',
    `never longer than ${CUT_MAX_SEC} seconds`,
  ])
    expect(hybrid).toContain(phrase);
  for (const phrase of [
    "graphicOrder (2–5",
    "IMMERSIVE PRODUCTION CONTRACT",
    "infoClips[{id, stage, explanation, cleanPrompt",
    "motionPrompt",
  ])
    expect(hybrid).not.toContain(phrase);
  // immersive 프롬프트는 2026-10-06 그대로(8초 컷·natural_v1·이름표 설명 컷)
  const immersive = videoScriptInstructions({
    seconds: 36,
    hypothesis,
    hasClips: false,
    infoClips: true,
    immersive: true,
  });
  expect(immersive).toContain("IMMERSIVE PRODUCTION CONTRACT");
  expect(immersive).toContain("never longer than 8 seconds");
  expect(immersive).toContain('<copy-rhythm-policy id="natural_v1">');
  expect(immersive).toContain("graphicOrder (2–5");
  expect(immersive).not.toContain("HYBRID PRODUCTION CONTRACT");
  // 둘 다 참이면 혼합형이 우선한다
  const both = videoScriptInstructions({
    seconds: 36,
    hypothesis,
    hasClips: false,
    infoClips: true,
    immersive: true,
    hybrid: true,
  });
  expect(both).toContain("HYBRID PRODUCTION CONTRACT");
  expect(both).not.toContain("IMMERSIVE PRODUCTION CONTRACT");
});
