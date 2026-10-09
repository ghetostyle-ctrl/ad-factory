import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copyRhythmInstruction,
  koreanCopyPolishRules,
  koreanCopyRhythmRules,
  naturalCopyRhythmRules,
} from "../server/copy-instructions";
import { flowExportFor, flowTexts } from "../server/flow-instructions";
import { sceneImagePrompt } from "../server/scene-image-references";
import { videoScriptInstructions } from "../server/script-instructions";
import { sourceImagePrompt } from "../server/source-image-style";
import { startImagePrompt } from "../server/start-image-production";
import { stillPrompt } from "../server/still-production";
import { prepareVideoPlanning, videoPlanningInstructions } from "../server/video-planning";
import { reviewVideoScript } from "../server/video-scripts";
import type { CreativePlan } from "../shared/creative-plan";
import { ExplanationPlanSchema } from "../shared/explanation-plan";
import { explanationPrompt } from "../shared/explanation-prompt";
import {
  flowExportMarkdown,
  hybridCleanPrompt,
  hybridMotionPrompt,
  hybridOverlayPrompt,
  infoCleanPrompt,
  infoMotionPrompt,
  infoOverlayPrompt,
} from "../shared/flow-mode";
import { videoScriptFromResponse } from "../shared/script-repair";
import { cleanKeyframePrompt, clipPrompt } from "../shared/veo-prompt";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  emptyClipPlan,
  InfoClipSchema,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { explanationTimingScript } from "./explanation-timing-fixture";
import { providerStore } from "./provider-fixtures";
import { renderScript } from "./render-fixture";
import { planningFixture, sourceReference, sourceStrategy } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { planningHttpFixture } from "./video-planning-http-fixture";
import { fixtureClipPlan, hybridScriptResponse } from "./video-script-fixture";

// 지시 파일 분리(2026-10-07 사용자 결정)의 동작 불변 골든(D7): 분리 전 b3ef40a 코드가 만들던 프롬프트 문자열을 대표 입력으로
// 저장해 두고, 지시 파일에서 조립한 뒤에도 바이트 단위로 같은지 비교한다. 모델 호출은 없고(HTTP 픽스처), 임계값도 같은 값이어야 한다.
// 갱신은 사용자 결정으로만: `GOLDEN_UPDATE=1 bun test tests/instructions-golden.test.ts` 가 파일을 다시 쓴다.
const GOLDEN_DIR = join(import.meta.dir, "golden");
const UPDATE = process.env["GOLDEN_UPDATE"] === "1";
const DATA_MARKER = "\nDATA:\n";
// 모델 요청에서 지시 부분만: 마지막 "\nDATA:\n" 앞(DATA 는 작업 ID·시각이 섞여 결정론이 아니다).
function instructionPart(prompt: string, marker = DATA_MARKER): string {
  const offset = prompt.lastIndexOf(marker);
  if (offset < 0) throw new TypeError(`프롬프트에 ${JSON.stringify(marker)} 가 없습니다.`);
  return prompt.slice(0, offset);
}
function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `instructions-${name}.txt`);
}
function check(name: string, actual: string): void {
  const path = goldenPath(name);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  if (!existsSync(path)) throw new Error(`골든 파일이 없습니다: ${path} (GOLDEN_UPDATE=1 로 생성)`);
  // 바이트 단위 비교(개행·끝 공백 포함). 다르면 어디가 다른지 찾기 쉽게 문자열 비교로 보고한다.
  expect(actual).toBe(readFileSync(path, "utf8"));
}

type Hypothesis = CreativePlan["hypotheses"][number];
const hypothesisOf = (fixture: { readonly hypothesis: Hypothesis }) => fixture.hypothesis;
const explanation = ExplanationPlanSchema.parse({
  id: "lid_structure",
  productForm: "손에 쥘 수 있는 원통형 컵과 납작한 뚜껑",
  entities: [
    { id: "cup", name: "컵", representation: "product", appearance: "아이보리 원통형 컵" },
    { id: "lid", name: "뚜껑", representation: "component", appearance: "짙은 올리브색 뚜껑" },
  ],
  beats: [
    {
      id: "lift_lid",
      targetIds: ["cup", "lid"],
      startProgress: 0.1,
      endProgress: 0.85,
      before: "뚜껑이 컵 위에 닫혀 있다.",
      action: "뚜껑이 올라가며 맞물린 가장자리를 드러낸다.",
      after: "컵과 뚜껑의 가장자리가 같은 시점에서 보인다.",
      narrationCue: "뚜껑을 열면",
      viewerTakeaway: "어떤 부분이 서로 맞물리는지 이해한다.",
    },
  ],
  annotations: [
    {
      targetId: "lid",
      beatId: "lift_lid",
      label: "뚜껑",
      kind: "pointer",
      motionIntent: "뚜껑 가장자리의 같은 지점을 따라가며 가리킨다.",
    },
  ],
});
// immersive 설명 컷(설명 설계 있음) / 예전 R4 설명 컷(글자 없음·graphicOrder) / 예전 infoLines 컷.
const explanationClip = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  explanation,
  cleanPrompt: "An ivory cup with an olive lid on an ivory surface",
  infoPrompt: "The same lid lifted above the matching rim",
  graphicOrder: ["Lift the lid", "Hold with both rims visible"],
  plan: fixtureClipPlan("I1"),
});
const graphicOrderClip = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Close-up of a capsule cut in half on a wooden table",
  infoPrompt:
    "A thick callout line from the oil droplet to an empty rounded panel floating on the right",
  graphicOrder: [
    "A glowing ring settles on the oil droplet",
    "A thick callout line grows from the ring to the right",
    "A translucent rounded panel fades in at the end of the line",
  ],
  plan: fixtureClipPlan("I1"),
});
const infoLinesClip = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Close-up of a capsule cut in half on a wooden table",
  infoPrompt: "Arrow from the oil to a label",
  infoLines: ["엑스트라 버진 올리브유", "1캡슐 600mg"],
  motionPrompt: "Slow push-in while the labels appear",
});
function immersivePlanning() {
  return VideoPlanningSchema.parse({
    ...fixtureVideoPlanning(),
    visualPolicy: "immersive_explanations_v1",
  });
}
function hybridPlanning() {
  return VideoPlanningSchema.parse({
    ...fixtureVideoPlanning(),
    visualPolicy: "hybrid_explainer_v1",
  });
}
function hybridScript(hypothesis: Hypothesis): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 36,
    hasCardSlides: false,
  });
  return VideoScriptSchema.parse({ ...script, planning: hybridPlanning() });
}
const explainerOf = (script: VideoScript) => ({
  explainerAnchor: script.explainerAnchor,
  subjects: script.subjects,
});
const FEEDBACK =
  "영상 대본 규칙 위반: 3번째 문장 컷[4~5]의 숫자 600 이 화면에 없습니다 / 컷 7이 6초입니다";

test("script prompts (legacy/immersive/hybrid × INFO on/off × feedback) match the golden files", () => {
  const fixture = planningHttpFixture();
  try {
    const hypothesis = hypothesisOf(fixture);
    const noChain: Hypothesis = { ...hypothesis, chain: undefined };
    // 오퍼 허용 분기: 최종 결정 단계 + 오퍼 신호.
    const offer: Hypothesis = {
      ...hypothesis,
      decisionRole: "final_decision",
      signals: hypothesis.signals
        ? {
            ...hypothesis.signals,
            offer: { type: "value_bundle", statement: "1+1 as stated in the offer source" },
          }
        : undefined,
    };
    check(
      "script-legacy-api",
      videoScriptInstructions({ seconds: 36, hypothesis, hasClips: false, infoClips: false }),
    );
    check(
      "script-legacy-flow-feedback",
      videoScriptInstructions({
        seconds: 45,
        hypothesis,
        hasClips: true,
        infoClips: true,
        feedback: FEEDBACK,
      }),
    );
    check(
      "script-legacy-nochain-offer",
      videoScriptInstructions({ seconds: 30, hypothesis: offer, hasClips: false }),
    );
    check(
      "script-legacy-nochain",
      videoScriptInstructions({ seconds: 60, hypothesis: noChain, hasClips: false }),
    );
    check(
      "script-immersive-flow",
      videoScriptInstructions({
        seconds: 54,
        hypothesis,
        hasClips: false,
        infoClips: true,
        immersive: true,
      }),
    );
    check(
      "script-immersive-api-clips-feedback",
      videoScriptInstructions({
        seconds: 40,
        hypothesis,
        hasClips: true,
        infoClips: false,
        immersive: true,
        feedback: FEEDBACK,
      }),
    );
    check(
      "script-hybrid-flow",
      videoScriptInstructions({
        seconds: 36,
        hypothesis,
        hasClips: false,
        infoClips: true,
        hybrid: true,
      }),
    );
    check(
      "script-hybrid-api-feedback",
      videoScriptInstructions({
        seconds: 50,
        hypothesis,
        hasClips: true,
        infoClips: false,
        hybrid: true,
        immersive: true,
        feedback: FEEDBACK,
      }),
    );
  } finally {
    fixture.close();
  }
});

test("planning, copy-editing and review prompts match the golden files", async () => {
  check("planning-immersive", videoPlanningInstructions("immersive_explanations_v1"));
  check("planning-hybrid", videoPlanningInstructions("hybrid_explainer_v1"));
  const fixture = planningHttpFixture();
  try {
    const hypothesis = hypothesisOf(fixture);
    // 카피 교정 프롬프트는 prepareVideoPlanning 안에 인라인이라 실제 요청(HTTP 픽스처)에서 지시 부분을 떼어 낸다.
    await prepareVideoPlanning(fixture.task, fixture.connection);
    await prepareVideoPlanning(
      { ...fixture.task, visualPolicy: "immersive_explanations_v1" },
      fixture.connection,
    );
    const editing = fixture.requests.filter((item) => item.name === "video_copy_editing");
    expect(editing).toHaveLength(2);
    check("copy-editing-hybrid", instructionPart(editing[0]?.prompt ?? ""));
    check("copy-editing-immersive", instructionPart(editing[1]?.prompt ?? ""));
    // 검토 프롬프트: 정책 3종 + 설명 설계가 있는 immersive(규칙 16).
    const reviews: readonly [string, VideoScript][] = [
      ["review-legacy", renderScript(1, hypothesis.id, 36)],
      [
        "review-immersive",
        VideoScriptSchema.parse({
          ...renderScript(1, hypothesis.id, 36),
          planning: immersivePlanning(),
        }),
      ],
      [
        "review-immersive-explanation",
        VideoScriptSchema.parse({ ...explanationTimingScript(), planning: immersivePlanning() }),
      ],
      ["review-hybrid", hybridScript(hypothesis)],
    ];
    for (const [name, script] of reviews) {
      const before = fixture.requests.length;
      await reviewVideoScript(
        { job: fixture.job, hypothesis, script, signal: fixture.task.signal },
        fixture.connection,
      );
      const request = fixture.requests[before];
      expect(request?.name).toBe("video_script_review");
      check(name, instructionPart(request?.prompt ?? ""));
    }
  } finally {
    fixture.close();
  }
});

test("source planning prompts (reference structure, creative plan, critique) match the golden files", async () => {
  const fixture = planningFixture();
  try {
    fixture.library.addSource(fixture.project.id, sourceReference);
    await fixture.planner.plan(fixture.job(), sourceStrategy, new AbortController().signal);
    const named = (name: string) =>
      fixture.requests.find((item) => item.text.format.name === name)?.input ?? "";
    check(
      "source-reference-structure",
      instructionPart(named("reference_structure"), "\nREFERENCE DATA:\n"),
    );
    check("source-creative-plan", instructionPart(named("source_creative_plan")));
    check("source-plan-critique", instructionPart(named("creative_plan_critique")));
  } finally {
    fixture.close();
  }
});

test("copy rules (instructions/copy.md) match the golden files", () => {
  check("copy-polish-rules", koreanCopyPolishRules());
  check("copy-rhythm-rules", koreanCopyRhythmRules());
  check("copy-natural-rules", naturalCopyRhythmRules());
  check("copy-rhythm-legacy", copyRhythmInstruction(false));
  check("copy-rhythm-natural", copyRhythmInstruction(true));
});

test("Veo, Flow (hybrid/immersive/legacy INFO) and image prompts match the golden files", () => {
  const fixture = planningHttpFixture();
  // 고정 문장은 instructions/flow.md 에서 읽은 글(서버 로더)로 조립한다 — 분리 전 상수와 바이트 단위로 같아야 한다.
  const texts = flowTexts();
  try {
    const hypothesis = hypothesisOf(fixture);
    const plan = fixtureClipPlan("A");
    check("veo-clip-plan", clipPrompt({ prompt: "Clip A: portrait product scene.", plan }, texts));
    check(
      "veo-clip-plan-live",
      clipPrompt({ prompt: "Clip A: portrait product scene.", plan }, texts, { liveAction: true }),
    );
    check("veo-clip-legacy", clipPrompt({ prompt: "Old clip.", plan: emptyClipPlan() }, texts));
    check("veo-clip-legacy-live", clipPrompt({ prompt: "Old clip." }, texts, { liveAction: true }));
    check("clean-keyframe-tail", texts.CLEAN_KEYFRAME_TAIL);
    check(
      "clean-keyframe-prompt",
      cleanKeyframePrompt("A woman at a table. ", texts.CLEAN_KEYFRAME_TAIL),
    );
    // 혼합형 설명 세계: 과정(I1, outline·glow_line)·비교(I2, color_code) + 강조 없음·계획 없음.
    const hybrid = hybridScript(hypothesis);
    const [i1, i2] = hybrid.infoClips;
    if (!i1 || !i2) throw new Error("hybrid fixture clips missing");
    const explainer = explainerOf(hybrid);
    check("hybrid-clean-process", hybridCleanPrompt(i1, explainer, texts));
    check("hybrid-overlay-process", hybridOverlayPrompt(i1, explainer, texts));
    check("hybrid-motion-process", hybridMotionPrompt(i1, explainer, texts));
    check("hybrid-clean-comparison", hybridCleanPrompt(i2, explainer, texts));
    check("hybrid-overlay-comparison", hybridOverlayPrompt(i2, explainer, texts));
    check("hybrid-motion-comparison", hybridMotionPrompt(i2, explainer, texts));
    const ghost = {
      ...i1,
      emphasis: [
        { kind: "ghost_object" as const, target: "oil", afterAction: 2 },
        { kind: "outline" as const, target: "capsule", afterAction: 0 },
      ],
    };
    check("hybrid-overlay-ghost", hybridOverlayPrompt(ghost, explainer, texts));
    check(
      "hybrid-motion-bare",
      hybridMotionPrompt({ ...i1, emphasis: [], plan: emptyClipPlan() }, explainer, texts),
    );
    check(
      "hybrid-overlay-no-emphasis",
      hybridOverlayPrompt({ ...i1, emphasis: [] }, explainer, texts),
    );
    // 2026-10-08 호환: INFO 문구(infoLines)가 없는 예전 혼합형 설명 장면(6e736cd8 등)의 INFO·영상 프롬프트는 infoLines 도입 전과
    // 바이트 그대로다(골든 파일은 도입 직전 hybrid-overlay-process·hybrid-motion-process 를 복사한 것).
    const notext = { ...i1, infoLines: [] };
    check("hybrid-overlay-notext", hybridOverlayPrompt(notext, explainer, texts));
    check("hybrid-motion-notext", hybridMotionPrompt(notext, explainer, texts));
    // 라우팅(infoCleanPrompt 등)은 같은 문자열을 돌려줘야 한다.
    expect(infoCleanPrompt(i1, hybrid.styleAnchor, texts, { explainer })).toBe(
      hybridCleanPrompt(i1, explainer, texts),
    );
    expect(infoOverlayPrompt(i1, texts, { explainer })).toBe(
      hybridOverlayPrompt(i1, explainer, texts),
    );
    expect(infoMotionPrompt(i1, texts, { explainer })).toBe(
      hybridMotionPrompt(i1, explainer, texts),
    );
    // immersive: 설명 설계 있음(라벨 렌더) / 설명 설계 없음(immersive 플래그만).
    check(
      "immersive-clean-explanation",
      infoCleanPrompt(explanationClip, "Ivory and olive", texts),
    );
    check("immersive-overlay-explanation", infoOverlayPrompt(explanationClip, texts));
    check("immersive-motion-explanation", infoMotionPrompt(explanationClip, texts));
    check(
      "immersive-clean-plain",
      infoCleanPrompt(graphicOrderClip, "Ivory and olive", texts, { immersive: true }),
    );
    check(
      "immersive-overlay-plain",
      infoOverlayPrompt(graphicOrderClip, texts, { immersive: true }),
    );
    check("immersive-motion-plain", infoMotionPrompt(graphicOrderClip, texts, { immersive: true }));
    check("explanation-prompt", explanationPrompt(explanation, texts.EXPLANATION_CONTRACT_INTRO));
    // 예전 설명 컷: R3 CLEAN(참조 사진) / R4 INFO(글자 없음) / infoLines INFO / R5 영상 / 계획 없는 영상.
    check("legacy-info-clean", infoCleanPrompt(graphicOrderClip, "Anchor style.", texts));
    check("legacy-info-overlay", infoOverlayPrompt(graphicOrderClip, texts));
    check("legacy-info-overlay-lines", infoOverlayPrompt(infoLinesClip, texts));
    check("legacy-info-motion", infoMotionPrompt(graphicOrderClip, texts));
    check("legacy-info-motion-noplan", infoMotionPrompt(infoLinesClip, texts));
    // 이미지 프롬프트: 시작 이미지·정지 이미지·참조 설명·immersive 대표 이미지 보정.
    const script = renderScript(1, "concept-0", 36);
    const clip = script.veoClips[0];
    const still = script.stills[0];
    if (!clip || !still) throw new Error("render fixture clip or still missing");
    check("image-start", startImagePrompt(script, clip));
    check("image-still", stillPrompt(script, still));
    check("image-scene-ref-0", sceneImagePrompt("Base photographic prompt.", 0));
    check("image-scene-ref-1", sceneImagePrompt("Base photographic prompt.", 1));
    check("image-scene-ref-2", sceneImagePrompt("Base photographic prompt.", 2));
    const immersiveScript = VideoScriptSchema.parse({
      ...renderScript(1, "concept-0", 36),
      planning: immersivePlanning(),
    });
    check(
      "image-source-immersive",
      sourceImagePrompt(
        { videoScripts: [immersiveScript] },
        "concept-0",
        "Approved ad card prompt.",
      ),
    );
    expect(sourceImagePrompt({ videoScripts: [script] }, "concept-0", "Plain.")).toBe("Plain.");
  } finally {
    fixture.close();
  }
});

test("Flow export bundles (checklists and prompts.md) match the golden files", () => {
  const store = providerStore();
  const fixture = planningHttpFixture();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    const hypothesis = hypothesisOf(fixture);
    const bundles: readonly [string, VideoScript][] = [
      ["flow-bundle-legacy-info", { ...renderScript(1, "concept-1"), infoClips: [infoLinesClip] }],
      [
        "flow-bundle-legacy-graphic-order",
        { ...renderScript(1, "concept-1"), infoClips: [graphicOrderClip] },
      ],
      [
        "flow-bundle-immersive",
        VideoScriptSchema.parse({
          ...renderScript(1, "concept-1"),
          veoClips: [],
          infoClips: [explanationClip],
          planning: immersivePlanning(),
        }),
      ],
      ["flow-bundle-hybrid", hybridScript(hypothesis)],
    ];
    for (const [name, script] of bundles) {
      const exported = flowExportFor({ ...job, videoScripts: [script] }, 1, flowTexts());
      // 작업 ID 는 실행마다 다르므로 자리표시자로 바꾼다(명령줄·파일 이름에 들어간다).
      check(name, flowExportMarkdown(exported).replaceAll(job.id, "<jobId>"));
    }
  } finally {
    fixture.close();
    store.close();
  }
});
