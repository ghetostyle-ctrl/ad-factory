import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyScriptEdit } from "../shared/script-edit";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems, scenePlanProblems } from "../shared/script-rules";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  calloutWordInText,
  emptyClipPlan,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { ScriptDiagnostics } from "../src/ScriptDiagnostics";
import {
  ClipPlanDetails,
  clipPhaseLabel,
  ExplainerScene,
  ScriptFields,
  ScriptSources,
  visualPolicyLabel,
} from "../src/ScriptFields";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import {
  fixtureClipPlan,
  HYBRID_EXPLAINER_ANCHOR,
  hybridScriptResponse,
  longVideoScript,
} from "./video-script-fixture";

test("a repaired draft shows its approval reminder until approval is complete", () => {
  const output = renderToStaticMarkup(
    <ScriptDiagnostics
      review={null}
      hardProblems={[]}
      warnings={[]}
      needsFix={true}
      dirty={false}
      approvalComplete={false}
    />,
  );
  expect(output).toContain('role="status"');
});

test("an approved repaired draft no longer renders an approval reminder", () => {
  const output = renderToStaticMarkup(
    <ScriptDiagnostics
      review={null}
      hardProblems={[]}
      warnings={[]}
      needsFix={true}
      dirty={false}
      approvalComplete={true}
    />,
  );
  expect(output).toBe("");
});

// 읽기 전용 화면(승인된 대본·실행 중)과 같은 조건으로 문장·컷 목록을 그린다.
const fields = (script: VideoScript, original: VideoScript = script) =>
  renderToStaticMarkup(
    <ScriptFields
      script={script}
      original={original}
      voices={script.voiceover.map((voice) => voice.text)}
      captions={script.cuts.map((cut) => cut.onScreenText)}
      editable={false}
      busy={false}
      onVoiceChange={() => undefined}
      onCaptionChange={() => undefined}
    />,
  );

test("scene-plan fields render: callouts under the sentence, cut goals and clip phases", () => {
  const script = longVideoScript(1, "h1", 36);
  const last = script.voiceover[script.voiceover.length - 1];
  expect(last?.callouts.length ?? 0).toBeGreaterThan(0);
  const output = fields(script);
  // 콜아웃: 어절 → 문구, 종류·위치 배지
  expect(output).toContain(`${script.voiceover.length}번째 문장의 콜아웃`);
  expect(output).toContain("지금 확인");
  expect(output).toContain('<span class="badge badge-neutral">라벨</span>');
  expect(output).toContain('<span class="badge badge-neutral">대상</span>');
  expect(output).not.toContain("문장에 없는 어절");
  // 컷의 이해 목표(문장 아래 컷 줄과 컷별 섹션)
  expect(output).toContain("이해 목표: 장면 1의 핵심");
  // 클립 구간 배지: 컷 0 early, 컷 1 mid 를 한국어 라벨로
  expect(clipPhaseLabel("early")).toBe("초반 0~3초");
  expect(output).toContain('<span class="badge badge-accent">초반 0~3초</span>');
  expect(output).toContain('<span class="badge badge-accent">중반 3~5.5초</span>');
  expect(output).toContain("초반 0~3초 구간");
});

test("editing a sentence so a callout word disappears is flagged on screen and by the save rule", () => {
  const script = longVideoScript(1, "h1", 36);
  const index = script.voiceover.length - 1;
  const callout = script.voiceover[index]?.callouts[0];
  if (!callout) throw new Error("fixture has no callout");
  const text = "오늘 바로 확인해 보세요.";
  expect(calloutWordInText(callout.word, text)).toBe(false);
  const edited = applyScriptEdit(script, { voiceover: [{ index, text }], captions: [] });
  // 편집은 콜아웃을 지우지 않으므로 화면이 어절이 사라졌다고 알린다
  expect(edited.voiceover[index]?.callouts).toEqual(script.voiceover[index]?.callouts ?? []);
  const output = fields(edited, script);
  expect(output).toContain("문장에 없는 어절");
  expect(output).toContain("저장할 수 없습니다");
  // 저장 전 미리 검사(classifyScriptProblems 가 합치는 scenePlanProblems)가 같은 문제를 hard 로 잡는다
  const hard = scenePlanProblems(edited).hard;
  expect(hard.some((problem) => problem.includes("어절(공백 기준)에 없습니다"))).toBe(true);
  expect(scenePlanProblems(script).hard).toEqual([]);
});

test("source list shows subjects, clip plans and the info clip graphic order as collapsed lists", () => {
  const script = longVideoScript(2, "h1", 36);
  const withInfo: VideoScript = {
    ...script,
    infoClips: [
      {
        id: "I1",
        stage: "criteria",
        cleanPrompt:
          "Clean photo of the amber glass bottle on the kitchen table, empty space above.",
        infoPrompt: "Glowing ring around the cream label and an arrow to the white cap.",
        infoLines: [],
        motionPrompt: "",
        sceneType: "",
        objects: [],
        actions: [],
        emphasis: [],
        graphicOrder: [
          "Ring appears around the label",
          "Arrow extends to the cap",
          "Check mark settles beside the bottle",
        ],
        plan: fixtureClipPlan("I1"),
      },
    ],
  };
  const output = renderToStaticMarkup(<ScriptSources script={withInfo} />);
  expect(output).toContain("등장 대상");
  expect(output).toContain('<span class="badge badge-neutral">woman</span>');
  expect(output).toContain("navy blouse");
  expect(output).toContain("Veo 클립 A");
  expect(output).toContain("<summary>구간 계획 · 카메라와 움직임 3단계</summary>");
  expect(output).toContain("후반 5.5~8초");
  expect(output).toContain("카메라: Clip A: start wide at the kitchen doorway");
  expect(output).toContain("움직임: One capsule rolls out into her open palm");
  expect(output).toContain("봐야 할 기준");
  expect(output).toContain("<summary>그래픽이 생기는 순서 3단계</summary>");
  expect(output).toContain("<li>Arrow extends to the cap</li>");
  expect(output).toContain("카메라: Clip I1: start wide");
  expect(output).not.toContain("예전 대본");
});

test("an older script without scene-plan fields renders no callout, goal, phase or plan", () => {
  const script = longVideoScript(3, "h1", 36);
  const old: VideoScript = {
    ...script,
    subjects: [],
    veoClips: script.veoClips.map((clip) => ({ ...clip, plan: emptyClipPlan() })),
    cuts: script.cuts.map((cut) => ({ ...cut, goal: "", phase: "" as const })),
    voiceover: script.voiceover.map((voice) => ({ ...voice, callouts: [] })),
  };
  const output = fields(old) + renderToStaticMarkup(<ScriptSources script={old} />);
  expect(output).not.toContain("콜아웃");
  expect(output).not.toContain("이해 목표");
  expect(output).not.toContain("초반");
  expect(output).not.toContain("구간 계획");
  expect(output).not.toContain("등장 대상");
  expect(output).toContain("Veo 클립 A");
  expect(renderToStaticMarkup(<ClipPlanDetails plan={emptyClipPlan()} />)).toBe("");
});

// 혼합형 대본(hybrid_explainer_v1, 2026-10-07): 응답 → 수리 → 저장 스키마 → 기획 정책. hybrid-policy.test.ts 와 같은 경로.
function requiredHypothesis() {
  const hypothesis = sourcePlanResponse("fact-1").hypotheses[0];
  if (!hypothesis) throw new TypeError("Missing test hypothesis");
  return hypothesis;
}
function hybridScript(): VideoScript {
  const hypothesis = requiredHypothesis();
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 36,
    hasCardSlides: false,
  });
  return VideoScriptSchema.parse({
    ...script,
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
}

test("a hybrid script marks every cut as live or explainer and lists the explainer world read-only", () => {
  const script = hybridScript();
  const output = fields(script);
  // 문장 아래 컷 줄과 컷별 섹션에 한 번씩: 설명 컷 6개 → 12, 실사 컷 8개 → 16. 둘 다 아닌 컷은 없다.
  expect(output.match(/<span class="badge badge-accent">설명 장면<\/span>/g)).toHaveLength(12);
  expect(output.match(/<span class="badge badge-neutral">실사<\/span>/g)).toHaveLength(16);
  expect(output).not.toContain("실사·설명 아님");
  expect(output).toContain("혼합형 대본입니다");
  // 제작 소스: 설명 세계 기준, 장면 종류 배지, 물체 색, 접힌 동작·강조 목록. 이름표 방식 UI 는 없다.
  const sources = renderToStaticMarkup(<ScriptSources script={script} />);
  expect(sources).toContain("설명 세계 기준(explainerAnchor):");
  expect(sources).toContain(HYBRID_EXPLAINER_ANCHOR);
  expect(sources).toContain("설명 장면 I1 · 우리 상품이 푸는 방식:");
  expect(sources).toContain('<span class="badge badge-accent">과정</span>');
  expect(sources).toContain('<span class="badge badge-accent">비교</span>');
  expect(sources).toContain('<span class="badge badge-neutral">capsule</span>강조색 1');
  expect(sources).toContain('<span class="badge badge-neutral">oil</span>강조색 2');
  expect(sources).toContain('<span class="badge badge-neutral">bottle</span>중립(클레이·화이트)');
  expect(sources).toContain("<summary>동작 순서 3단계 · 강조 2개</summary>");
  expect(sources).toContain("<li>Golden olive oil pours into the open shell</li>");
  expect(sources).toContain("빨간 외곽선 · capsule · 1번째 동작 뒤");
  expect(sources).toContain("흰 발광선 · oil · 2번째 동작 뒤");
  expect(sources).toContain("색 구분 · capsule · 1번째 동작 뒤");
  expect(sources).not.toContain("그래픽이 생기는 순서");
  expect(sources).not.toContain("예전 대본");
  // 정책 배지 문구
  expect(visualPolicyLabel("hybrid_explainer_v1")).toBe("혼합형 · 실사 + 3D 설명");
  expect(visualPolicyLabel("immersive_explanations_v1")).toBe("입체 설명(이전 기준)");
  expect(visualPolicyLabel(undefined)).toBe("");
});

test("legacy and immersive scripts render no live/explainer badge, explainer anchor or scene block", () => {
  const script = longVideoScript(1, "h1", 36);
  const legacy = fields(script) + renderToStaticMarkup(<ScriptSources script={script} />);
  expect(legacy).not.toContain("설명 장면");
  expect(legacy).not.toContain(">실사<");
  expect(legacy).not.toContain("explainerAnchor");
  expect(legacy).not.toContain("혼합형");
  // immersive 설명 컷(sceneType "")은 그래픽 순서 목록만 보이고 장면 블록은 없다
  const plain: VideoScript["infoClips"][number] = {
    id: "I1",
    stage: "mechanism",
    cleanPrompt: "Transparent oil capsule on an ivory table, empty space around it.",
    infoPrompt: "Oil separates inside a cutaway capsule.",
    infoLines: [],
    motionPrompt: "",
    sceneType: "",
    objects: [],
    actions: [],
    emphasis: [],
    graphicOrder: ["Shell separates", "Oil volume is revealed"],
    plan: fixtureClipPlan("I1"),
  };
  const immersive: VideoScript = {
    ...script,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    infoClips: [plain],
  };
  const output = fields(immersive) + renderToStaticMarkup(<ScriptSources script={immersive} />);
  expect(output).toContain("설명 컷 I1 · 우리 상품이 푸는 방식:");
  expect(output).toContain("<summary>그래픽이 생기는 순서 2단계</summary>");
  expect(output).not.toContain("설명 장면");
  expect(output).not.toContain("동작 순서");
  expect(output).not.toContain("explainerAnchor");
  expect(renderToStaticMarkup(<ExplainerScene clip={plain} />)).toBe("");
});

test("a hybrid rule violation reaches the hard-rule banner through classifyScriptProblems", () => {
  // Given: 고통 문장(1번째)의 첫 컷을 설명 장면 I1 로 바꾼다 — 실사 비트에 설명 컷, 첫 컷 비실사
  const base = hybridScript();
  const painOverInfo: VideoScript = {
    ...base,
    cuts: base.cuts.map((cut, index) =>
      index === 0 ? { ...cut, veoClip: "I1" as const, phase: "early" as const } : cut,
    ),
  };
  const hard = classifyScriptProblems(painOverInfo, {
    number: 1,
    durationSec: 36,
    hypothesis: requiredHypothesis(),
    infoClipsAllowed: true,
  }).hard;
  expect(hard.some((problem) => problem.includes("실사가 아닙니다"))).toBe(true);
  expect(hard.some((problem) => problem.includes("첫 컷은 실사여야"))).toBe(true);
  // 기존 hard 배너가 같은 목록을 그린다(저장·승인은 ScriptEditor 가 hard 가 있으면 막는다)
  const banner = renderToStaticMarkup(
    <ScriptDiagnostics
      review={null}
      hardProblems={hard}
      warnings={[]}
      needsFix={false}
      dirty={false}
      approvalComplete={false}
    />,
  );
  expect(banner).toContain("실사가 아닙니다");
  expect(banner).toContain("첫 컷은 실사여야");
  // 컷 줄에서도 첫 컷이 설명 장면으로 보인다(문장 줄 + 컷 섹션): 설명 컷 7개 → 14
  expect(
    fields(painOverInfo).match(/<span class="badge badge-accent">설명 장면<\/span>/g),
  ).toHaveLength(14);
});
