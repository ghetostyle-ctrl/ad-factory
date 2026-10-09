import { expect, test } from "bun:test";
import { infoTextProblems } from "../server/flow-import";
import { flowExportFor, flowTexts } from "../server/flow-instructions";
import { hybridMotionPrompt, hybridOverlayPrompt } from "../shared/flow-info-prompts";
import { explainerSceneProblems, hybridProblems } from "../shared/hybrid-script-rules";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  HybridVideoScriptResponseSchema,
  scriptDigestJson,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { providerStore } from "./provider-fixtures";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

// 2차 수정 바퀴 단위 ②(2026-10-08, 사용자 결정: 인포그래픽은 앱이 아니라 Flow INFO 이미지 안에). 앱이 하는 일은 셋뿐이다 —
// (1) 어떤 숫자·사실을 쓸지 고른다(자료에 있는 것만, infoLines), (2) 올라온 INFO 이미지의 글자를 지정 문구와 대조한다,
// (3) 설명 컷에는 콜아웃을 그리지 않는다(기존). 예전 혼합형 대본(infoLines 없음)은 글자 없음 검사·프롬프트·다이제스트가 그대로다.
const texts = flowTexts();
const hypothesis = (() => {
  const item = sourcePlanResponse("fact-1").hypotheses[0];
  if (!item) throw new TypeError("Missing test hypothesis");
  return item;
})();
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 36, hasCardSlides: false };
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true };
function hybridScript(): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), ctx);
  return VideoScriptSchema.parse({
    ...script,
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
}
function withInfoLines(script: VideoScript, id: "I1" | "I2", infoLines: string[]): VideoScript {
  return {
    ...script,
    infoClips: script.infoClips.map((clip) => (clip.id === id ? { ...clip, infoLines } : clip)),
  };
}

test("the hybrid response requires 1–4 INFO lines per explainer scene and the repair keeps them", () => {
  const response = hybridScriptResponse();
  // 응답 스키마: infoLines 없음·빈 배열·5줄·25자는 거부
  const [first, ...rest] = response.infoClips;
  if (!first) throw new TypeError("fixture clip");
  const { infoLines: _drop, ...noLines } = first;
  for (const infoClips of [
    [noLines, ...rest],
    [{ ...first, infoLines: [] }, ...rest],
    [{ ...first, infoLines: ["가", "나", "다", "라", "마"] }, ...rest],
    [{ ...first, infoLines: ["가".repeat(25)] }, ...rest],
  ])
    expect(HybridVideoScriptResponseSchema.safeParse({ ...response, infoClips }).success).toBe(
      false,
    );
  // 수리·저장은 문구를 그대로 싣는다
  const { script } = videoScriptFromResponse(response, ctx);
  expect(script.infoClips.map((clip) => clip.infoLines)).toEqual([
    ["캡슐 안은 올리브유"],
    ["겉은 같은 캡슐", "속은 다른 기름"],
  ]);
  // 저장 스키마는 예전 대본(infoLines 없음)도 읽고, 그 다이제스트에는 infoLines 키가 없다(승인·음성 기록 불변)
  const old = VideoScriptSchema.parse({
    ...script,
    infoClips: script.infoClips.map(({ infoLines: _l, ...clip }) => clip),
  });
  expect(old.infoClips.every((clip) => clip.infoLines.length === 0)).toBe(true);
  expect(scriptDigestJson(old)).not.toContain('"infoLines"');
  expect(scriptDigestJson(script)).toContain('"infoLines":["캡슐 안은 올리브유"]');
});

test("INFO lines: English is rejected, numbers must exist in the facts, and a scene without any number only warns", () => {
  const script = hybridScript();
  // 영문 → hard(장면 규칙)
  const english = withInfoLines(script, "I1", ["olive oil 100%"]);
  expect(explainerSceneProblems(english.infoClips, english.subjects).hard.join(" ")).toContain(
    "영문이 있습니다",
  );
  expect(explainerSceneProblems(script.infoClips, script.subjects).hard).toEqual([]);
  // 자료에 없는 숫자 → hard, 자료에 있는 숫자 → 통과(기존 규칙이 혼합형 infoLines 에도 적용된다)
  const facts = ["Chong Kun Dang 엑스트라 버진 1캡슐 600mg 30캡슐"];
  const invented = withInfoLines(script, "I1", ["올리브유 100%"]);
  expect(classifyScriptProblems(invented, { ...expected, facts }).hard.join(" ")).toContain(
    "제품 자료에 없는 숫자 100",
  );
  const fromFacts = withInfoLines(script, "I1", ["600밀리그램"]);
  const result = classifyScriptProblems(fromFacts, { ...expected, facts });
  expect(result.hard.filter((item) => item.includes("숫자")).length).toBe(0);
  // I2 에는 숫자가 없으므로 경고(soft)만, I1 은 숫자가 있어 경고 없음
  expect(result.soft.filter((item) => item.includes("INFO 문구에 숫자가 없습니다"))).toEqual([
    expect.stringContaining("설명 컷 I2"),
  ]);
  // 자료에 숫자가 없으면(픽스처 기본) 숫자 경고도 없다
  expect(
    classifyScriptProblems(script, { ...expected, facts: ["엑스트라 버진 올리브유"] }).soft.some(
      (item) => item.includes("INFO 문구에 숫자가 없습니다"),
    ),
  ).toBe(false);
});

test("uploaded INFO images are compared with the planned lines; arrows and rings are allowed; extra text is rejected", () => {
  const [i1] = hybridScript().infoClips;
  if (!i1) throw new TypeError("fixture clip");
  // 지정 문구가 모두 있으면 통과(띄어쓰기·문장부호 무시), 화살표·치수선·링은 인포그래픽의 일부라 허용
  expect(infoTextProblems(i1, ["캡슐 안은 올리브유"], ["arrow", "leader_line", "ring"])).toEqual(
    [],
  );
  expect(infoTextProblems(i1, ["캡슐안은올리브유"])).toEqual([]);
  // 빠진 문구·추가 문구는 거부(깨진 한글은 추가 문구로 잡힌다)
  expect(infoTextProblems(i1, ["캡슐 안은 올리브유", "Product Benefits"])).toEqual([
    expect.stringContaining("계획하지 않은 글자"),
  ]);
  expect(infoTextProblems(i1, ["캡슐 안은 올리뷰"])).toEqual([
    'INFO 이미지에서 "캡슐 안은 올리브유" 글자를 찾지 못했습니다.',
    expect.stringContaining("계획하지 않은 글자"),
  ]);
  // 예전 혼합형 설명 장면(infoLines 없음)은 평면 그래픽 모양도 거부(기존 동작)
  expect(infoTextProblems({ ...i1, infoLines: [] }, [], ["arrow"])).toEqual([
    expect.stringContaining("평면 그래픽이 있습니다: 화살표"),
  ]);
});

test("INFO and motion prompts carry the exact lines, and the Flow bundle lists them once", () => {
  const script = hybridScript();
  const [i1] = script.infoClips;
  if (!i1) throw new TypeError("fixture clip");
  const explainer = { explainerAnchor: script.explainerAnchor, subjects: script.subjects };
  const overlay = hybridOverlayPrompt(i1, explainer, texts);
  expect(overlay).toContain("1) 캡슐 안은 올리브유");
  expect(overlay).toContain("a dimension line with end ticks for a supported measurement");
  expect(overlay).not.toContain("No text, letters, numbers, labels");
  const motion = hybridMotionPrompt(i1, explainer, texts);
  expect(motion).toContain("1) 캡슐 안은 올리브유");
  expect(motion).toContain("never letter by letter or by morphing");
  expect(motion).not.toContain("No text at any moment");
  // 번들: 설명 장면 항목이 문구 대조를 설명하므로 예전 '지정 문구 방식' 항목은 넣지 않는다
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    const data = flowExportFor({ ...job, videoScripts: [script] }, 1);
    expect(data.infoClips.map((clip) => clip.infoLines)).toEqual([
      ["캡슐 안은 올리브유"],
      ["겉은 같은 캡슐", "속은 다른 기름"],
    ]);
    expect(data.checklist).toContain(texts.FLOW_INFO_CHECKLIST_EXPLAINER);
    expect(data.checklist).not.toContain(texts.FLOW_INFO_CHECKLIST_LINES);
    expect(data.checklist).not.toContain(texts.FLOW_INFO_CHECKLIST_NO_TEXT);
  } finally {
    store.close();
  }
});

// ---------- 단위 ③(2026-10-08): ③④ 비트 정지 사진 제한 · 비교 장면 early → mid ----------
type Response = ReturnType<typeof hybridScriptResponse>;
function scriptOf(mutate: (response: Response) => void): VideoScript {
  const response = hybridScriptResponse();
  mutate(response);
  const { script } = videoScriptFromResponse(response, ctx);
  return VideoScriptSchema.parse({
    ...script,
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
}
const still = (len: number, stillId: "S1" | "S2", goal: string) => ({
  len,
  source: "still_image" as const,
  screenComposition: goal,
  onScreenText: "",
  effect: "hard_cut" as const,
  veoClip: "" as const,
  stillId,
  graphicKind: "" as const,
  graphicLines: [],
  goal,
  phase: "" as const,
});

test("real-cause and requirement sentences reject two stills in a row and a still longer than the beat limit", () => {
  // 기준 픽스처(③ 실사 Veo late, ④ 설명 장면 early+mid)는 새 규칙에 걸리지 않는다
  const base = hybridProblems(hybridScript());
  expect(base.hard.filter((item) => item.includes("정지 이미지"))).toEqual([]);
  // ③ 문장 아래 정지 2컷 연속 → hard(연속), 각 컷은 2초라 길이 규칙에는 안 걸린다
  const consecutive = scriptOf((response) => {
    response.stills.push({
      id: "S2",
      prompt:
        "Photographic still of the kitchen counter with two supplement bottles, soft daylight.",
    });
    const sentence = response.sentences[2];
    if (!sentence || sentence.chainStep !== "real_cause") throw new TypeError("fixture sentence");
    sentence.cuts = [still(2, "S2", "두 병이 놓인 조리대"), still(2, "S2", "병 라벨 클로즈업")];
  });
  const problems = hybridProblems(consecutive);
  expect(problems.hard.filter((item) => item.includes("정지 이미지 연속"))).toHaveLength(1);
  expect(problems.hard.join(" ")).toContain("설명 장면(I1~I3) 또는 실사 Veo 움직임으로 바꾸세요");
  // ④ 문장 아래 정지 1컷 4초 → hard(길이)
  const long = scriptOf((response) => {
    response.stills.push({
      id: "S2",
      prompt:
        "Photographic still of the kitchen counter with two supplement bottles, soft daylight.",
    });
    const sentence = response.sentences[3];
    if (!sentence || sentence.chainStep !== "requirement") throw new TypeError("fixture sentence");
    sentence.cuts = [still(4, "S2", "두 병이 놓인 조리대")];
  });
  expect(hybridProblems(long).hard.join(" ")).toContain(
    "정지 이미지 4초입니다. 진짜 원인·해결 조건 문장 아래 정지 이미지는 한 컷 3초까지",
  );
  // 결과(outcome) 문장의 정지 2초는 ③④ 비트가 아니라 규칙 밖(픽스처 그대로 통과)
  expect(base.hard).toEqual([]);
});

test("a comparison scene must start with its early phase; the second cut should be mid; process phases keep their order", () => {
  // 비교 I2 의 첫 컷을 mid 로 바꾸면 hard, early 다음 late 면 soft
  const midFirst = scriptOf((response) => {
    const fact = response.sentences[4]?.cuts[1];
    const why = response.sentences[5]?.cuts;
    if (!fact || fact.veoClip !== "I2" || !why?.[0] || !why[1]) throw new TypeError("fixture cuts");
    fact.phase = "mid";
    why[0].phase = "early";
    why[1].phase = "late";
  });
  expect(hybridProblems(midFirst).hard.join(" ")).toContain("설명 장면 I2(비교)의 첫 컷");
  const lateSecond = scriptOf((response) => {
    const why = response.sentences[5]?.cuts;
    if (!why?.[0] || !why[1]) throw new TypeError("fixture cuts");
    why[0].phase = "late";
    why[1].phase = "mid";
  });
  const lateProblems = hybridProblems(lateSecond);
  expect(lateProblems.hard.filter((item) => item.includes("I2(비교)의 첫 컷"))).toEqual([]);
  expect(lateProblems.soft.join(" ")).toContain("설명 장면 I2(비교)의 둘째 컷");
  // 과정 I1 을 late → early 순서로 읽으면 soft
  const reversed = scriptOf((response) => {
    const req = response.sentences[3]?.cuts;
    const fact = response.sentences[4]?.cuts[0];
    if (!req?.[0] || !req[1] || !fact || fact.veoClip !== "I1") throw new TypeError("fixture cuts");
    req[0].phase = "late";
    req[1].phase = "mid";
    fact.phase = "early";
  });
  expect(hybridProblems(reversed).soft.join(" ")).toContain("설명 장면 I1(과정)의 컷이 단계 순서");
  // 우리 제품 표식: 비교 장면의 물체가 모두 중립·accent2 이고 외곽선도 없으면 soft
  const unmarked = scriptOf((response) => {
    const i2 = response.infoClips[1];
    if (!i2 || i2.sceneType !== "comparison") throw new TypeError("fixture clip");
    i2.objects = i2.objects.map((object) =>
      object.subjectId === "capsule" ? { ...object, color: "accent2" } : object,
    );
  });
  expect(hybridProblems(unmarked).soft.join(" ")).toContain(
    "우리 제품 표식(accent1 색 또는 빨간 외곽선)이 없습니다",
  );
  expect(hybridProblems(hybridScript()).soft.some((item) => item.includes("우리 제품 표식"))).toBe(
    false,
  );
});

test("hybrid responses that bind sentences to explainer phases with actionSync are repaired to null instead of failing the legacy beat rule", () => {
  // 실측(2026-10-08 작업 bde224da): 모델이 설명 컷 문장에 actionSync {clipId: "I1", beatId: "early"} 를 적어 예전 규칙이 hard 5건을 냈다
  const response = hybridScriptResponse();
  const bound = response.sentences[3];
  if (!bound || bound.chainStep !== "requirement") throw new TypeError("fixture sentence");
  bound.actionSync = { clipId: "I1", beatId: "early" };
  const { script, repairs } = videoScriptFromResponse(response, ctx);
  expect(script.voiceover[3]?.actionSync).toBeUndefined();
  expect(repairs.some((item) => item.includes("actionSync"))).toBe(true);
  const stored = VideoScriptSchema.parse({
    ...script,
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
  expect(
    classifyScriptProblems(stored, expected).hard.filter((item) => item.includes("설명 동작")),
  ).toEqual([]);
});

test("the hybrid policy is exempt from the 50% live-Veo share limit (Flow clips are paid per clip); legacy scripts keep it", () => {
  // 실측(2026-10-08 작업 bde224da 2차 다시 쓰기): 정지 사진을 6초로 줄이자 실사 Veo 컷 32초/54초가 50% 상한에 걸려 needsFix 가 됐다
  const script = hybridScript();
  const veoSec = script.cuts
    .filter((cut) => cut.source === "veo_clip" && !cut.veoClip.startsWith("I"))
    .reduce((sum, cut) => sum + cut.endSec - cut.startSec, 0);
  // 픽스처의 실사 Veo 비중을 50% 넘게 만든다(마지막 승인 이미지 컷을 B late 로)
  const heavy: VideoScript = {
    ...script,
    durationSec: 30,
    cuts: script.cuts.map((cut, index) =>
      index === script.cuts.length - 1
        ? { ...cut, source: "veo_clip" as const, veoClip: "B" as const, phase: "late" as const }
        : cut,
    ),
  };
  expect(veoSec).toBeGreaterThan(0);
  const problems = classifyScriptProblems(heavy, { ...expected, durationSec: 30 });
  expect(problems.hard.filter((item) => item.includes("Veo 클립 컷이"))).toEqual([]);
});
