import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { automationServices } from "../server/automation-services";
import { env } from "../server/config";
import {
  FlowImport,
  infoTextCharCount,
  infoTextProblems,
  missingInfoLines,
  normalizeInfoRead,
  readableTextBlocks,
} from "../server/flow-import";
import { flowExportFor, flowTexts } from "../server/flow-instructions";
import { Pipeline } from "../server/pipeline";
import {
  FLOW_URL,
  type FlowExport,
  FlowExportSchema,
  flowExportMarkdown,
  hybridCleanPrompt,
  hybridMotionPrompt,
  hybridOverlayPrompt,
  infoCleanPrompt,
  infoClipExpectsText,
  infoMotionPrompt,
  infoOverlayPrompt,
  pendingFlowClips,
} from "../shared/flow-mode";
import { assignClipOffsets } from "../shared/render-timeline";
import { videoScriptFromResponse } from "../shared/script-repair";
import { classifyScriptProblems } from "../shared/script-rules";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  clipPlanText,
  emptyClipPlan,
  type InfoClip,
  scriptDigestJson,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { providerStore } from "./provider-fixtures";
import { renderScript, tinyClip, tinyStill } from "./render-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import {
  fixtureClipPlan,
  flatOf,
  HYBRID_EXPLAINER_ANCHOR,
  HYBRID_STYLE_ANCHOR,
  hybridScriptResponse,
  nestedScriptResponse,
} from "./video-script-fixture";

// 고정 문장은 instructions/flow.md 에서 읽는다(서버 로더). 테스트는 같은 글로 순수 조립 함수를 부르고 번들은 서버 wrapper 로 만든다.
const texts = flowTexts();
const {
  CLEAN_KEYFRAME_TAIL,
  HYBRID_LIVE_TAIL,
  EXPLAINER_WORLD,
  EXPLAINER_TEXT_RULE,
  FLOW_INFO_CHECKLIST_EXPLAINER: INFO_CHECKLIST_EXPLAINER,
  FLOW_HYBRID_EYE_CHECK: HYBRID_EYE_CHECK,
} = texts;
const buildFlowExport = (job: Parameters<typeof flowExportFor>[0], number: number) =>
  flowExportFor(job, number, texts);

const planned = sourcePlanResponse("fact-1").hypotheses[1];
if (!planned) throw new Error("fixture hypothesis");
const fixtureHypothesis = { ...planned, cardSlides: [] };
// 설명 컷(CLEAN → INFO 전환, I1~I3): 대본 선언·규칙·타임라인·Flow 내보내기·이미지 글자 확인·클립 업로드 순서.
// 예전 설명 컷(2026-10-05): INFO 에 지정 문구(infoLines)를 넣고 앱이 대조한다.
const info = {
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Close-up of a capsule cut in half on a wooden table",
  infoPrompt: "Arrow from the oil to a label",
  infoLines: ["엑스트라 버진 올리브유", "1캡슐 600mg"],
  motionPrompt: "Slow push-in while the labels appear",
} as const;
// 새 설명 컷(2026-10-06, R4·R5): INFO 에 글자가 없고 graphicOrder·plan 을 적는다(infoLines·motionPrompt 는 저장 기본값).
const infoNew = {
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Close-up of a capsule cut in half on a wooden table",
  infoPrompt:
    "A thick callout line from the oil droplet to an empty rounded panel floating on the right",
  infoLines: [],
  motionPrompt: "",
  graphicOrder: [
    "A glowing ring settles on the oil droplet",
    "A thick callout line grows from the ring to the right",
    "A translucent rounded panel fades in at the end of the line",
  ],
  plan: fixtureClipPlan("I1"),
} as const;
type InfoDef = typeof info | typeof infoNew;

function infoScript(
  number = 1,
  hypothesisId = "concept-1",
  durationSec = 36,
  def: InfoDef = info,
): VideoScript {
  const script = renderScript(number, hypothesisId, durationSec);
  const veoPrompt = "plan" in def ? clipPlanText(def.plan) : def.motionPrompt;
  return VideoScriptSchema.parse({
    ...script,
    veoClips: script.veoClips.filter((clip) => clip.id !== "C"),
    infoClips: [def],
    cuts: script.cuts.map((cut) =>
      cut.veoClip === "C" ? { ...cut, veoClip: "I1", veoPrompt } : cut,
    ),
  });
}
function clipOf(def: InfoDef): InfoClip {
  const clip = infoScript(1, "concept-1", 36, def).infoClips[0];
  if (!clip) throw new Error("fixture info clip");
  return clip;
}
const flowPolicy = {
  mode: "creative",
  imageCount: 1,
  videoCount: 1,
  scriptApproval: "auto",
  clipMode: "flow",
} as const;

test("scripts saved before explanation cuts keep their digest", () => {
  const script = renderScript(1, "concept-1", 36);
  const reparsed = VideoScriptSchema.parse(JSON.parse(JSON.stringify(script)));
  expect(reparsed.infoClips).toEqual([]);
  expect(scriptDigestJson(reparsed)).not.toContain("infoClips");
});

test("explanation cuts are Flow-only, at most three, and copy numbers from the facts", () => {
  const script = infoScript();
  const base = { number: 1, durationSec: 36, hypothesis: fixtureHypothesis, hasProjectClips: true };
  const facts = ["Chong Kun Dang 엑스트라 버진 1캡슐 600mg 30캡슐"];
  const ok = classifyScriptProblems(script, { ...base, facts, infoClipsAllowed: true }).hard;
  expect(ok.filter((item) => item.includes("설명 컷"))).toEqual([]);
  expect(
    classifyScriptProblems(script, { ...base, facts, infoClipsAllowed: false }).hard.join(" "),
  ).toContain("Google Flow 모드에서만");
  const wrongNumber = {
    ...script,
    infoClips: script.infoClips.map((clip) => ({ ...clip, infoLines: ["1캡슐 700mg"] })),
  };
  expect(
    classifyScriptProblems(wrongNumber as VideoScript, { ...base, facts }).hard.join(" "),
  ).toContain("자료에 없는 숫자 700");
  const undeclared = { ...script, infoClips: [] };
  expect(classifyScriptProblems(undeclared as VideoScript, base).hard.join(" ")).toContain(
    "선언하지 않은 클립 I1",
  );
});

test("explanation cuts do not count against the live-action Veo budget", () => {
  const script = infoScript();
  const allInfo = {
    ...script,
    cuts: script.cuts.map((cut) => (cut.source === "veo_clip" ? { ...cut, veoClip: "I1" } : cut)),
  } as VideoScript;
  const hard = classifyScriptProblems(allInfo, {
    number: 1,
    durationSec: 36,
    hypothesis: fixtureHypothesis,
    hasProjectClips: true,
  }).hard.join(" ");
  expect(hard).not.toContain("전체의 50%");
});

test("repair keeps used explanation cuts and drops unused ones", () => {
  // 응답용 설명 컷(2026-10-06): infoLines·motionPrompt 대신 graphicOrder·plan. 저장본의 motionPrompt 는 비고 veoPrompt 는 plan 글이 된다.
  const infoResponse = {
    explanation: null,
    id: info.id,
    stage: info.stage,
    cleanPrompt: info.cleanPrompt,
    infoPrompt: info.infoPrompt,
    graphicOrder: [
      "An arrow grows from the oil toward the capsule",
      "A glowing ring settles on it",
    ],
    plan: fixtureClipPlan("I1"),
  };
  const response = {
    ...nestedScriptResponse(flatOf(renderScript(1, "concept-1", 36))),
    infoClips: [infoResponse, { ...infoResponse, id: "I2" as const }],
  };
  const firstCut = response.sentences[5]?.cuts[0];
  if (firstCut) Object.assign(firstCut, { source: "veo_clip", veoClip: "I1", stillId: "" });
  const repaired = videoScriptFromResponse(response, {
    number: 1,
    hypothesisId: "concept-1",
    targetSec: 36,
    hasCardSlides: true,
  });
  expect(repaired.script.infoClips.map((clip) => clip.id)).toEqual(["I1"]);
  expect(repaired.repairs.join(" ")).toContain("쓰지 않는 설명 컷 선언 삭제: I2");
  expect(repaired.script.infoClips[0]).toMatchObject({ infoLines: [], motionPrompt: "" });
  expect(repaired.script.cuts.find((cut) => cut.veoClip === "I1")?.veoPrompt).toBe(
    clipPlanText(infoResponse.plan),
  );
});

test("an explanation cut reads the end of its clip, where the infographic has appeared", () => {
  const offsets = assignClipOffsets([
    { index: 0, source: "veo_clip", veoClip: "I1", startMs: 0, endMs: 3000 },
    { index: 1, source: "veo_clip", veoClip: "A", startMs: 3000, endMs: 5000 },
  ]);
  expect(offsets.get(0)).toEqual({ clipId: "I1", offsetMs: 5000, padMs: 0 });
  expect(offsets.get(1)).toEqual({ clipId: "A", offsetMs: 0, padMs: 0 });
});

test("text check ignores spacing and punctuation but catches a wrong number", () => {
  expect(missingInfoLines(info.infoLines, ["엑스트라  버진 올리브유!", "1 캡슐 · 600mg"])).toEqual(
    [],
  );
  expect(missingInfoLines(info.infoLines, ["엑스트라 버진 올리브유", "1캡슐 60mg"])).toEqual([
    "1캡슐 600mg",
  ]);
});

test("the clean prompt keeps the reference instruction and ends with the clean-keyframe tail", () => {
  // R3: 글자·화살표·수치·라벨·아이콘·강조 링 없이, 뒤에 그래픽이 놓일 빈 공간을 남긴다
  const prompt = infoCleanPrompt(clipOf(infoNew), "Anchor style.", texts);
  expect(prompt.startsWith("Anchor style. Close-up of a capsule")).toBe(true);
  expect(prompt).toContain("attached reference photo");
  expect(prompt.endsWith(CLEAN_KEYFRAME_TAIL)).toBe(true);
  expect(infoCleanPrompt(clipOf(info), "", texts)).toContain(CLEAN_KEYFRAME_TAIL);
});

test("the INFO prompt forbids all text, lists the graphic order in the middle band with 2-3 accents; legacy clips keep the numbered lines", () => {
  const fresh = clipOf(infoNew);
  expect(infoClipExpectsText(fresh)).toBe(false);
  const prompt = infoOverlayPrompt(fresh, texts);
  expect(prompt).toContain(infoNew.infoPrompt);
  expect(prompt).toContain("ABSOLUTELY NO TEXT");
  expect(prompt).toContain("no letters, words, numbers, digits, labels, captions, logos");
  expect(prompt).toContain("The app draws all text and numbers later");
  for (const [index, line] of infoNew.graphicOrder.entries())
    expect(prompt).toContain(`${index + 1}) ${line}`);
  expect(prompt.indexOf("1) A glowing ring")).toBeLessThan(prompt.indexOf("2) A thick callout"));
  expect(prompt).toContain("big, bold and instantly readable");
  expect(prompt).toContain("glowing edges, bright outlines and translucent fills");
  expect(prompt).toContain("correct perspective");
  expect(prompt).toContain("never cover a face or the product");
  expect(prompt).toContain(
    "Keep the photo, framing, camera angle, lighting, person and product exactly the same",
  );
  expect(prompt).toContain("between 20% and 65% of the height from the top");
  expect(prompt).toContain("Keep the top 20% and the bottom 35% free");
  expect(prompt).toContain("two or three accent colors that fit the brand tone");
  expect(prompt).toContain("no neon overload");
  expect(prompt).toContain("Do not add any element that is not described above");
  expect(prompt).not.toContain("exactly these text lines");
  // 예전 설명 컷: 지정 문구를 번호로 적는 예전 프롬프트 그대로
  const legacy = clipOf(info);
  expect(infoClipExpectsText(legacy)).toBe(true);
  const old = infoOverlayPrompt(legacy, texts);
  expect(old).toContain("1) 엑스트라 버진 올리브유");
  expect(old).toContain("2) 1캡슐 600mg");
  expect(old).toContain("exactly these text lines");
  expect(old).toContain("between 20% and 65%");
  expect(old).not.toContain("ABSOLUTELY NO TEXT");
});

test("the motion prompt carries the three phases, the graphic order, no text ever and no plain fade; legacy clips keep their motionPrompt", () => {
  const prompt = infoMotionPrompt(clipOf(infoNew), texts);
  const plan = infoNew.plan;
  expect(prompt).toContain("Start exactly on the first frame (the clean photo)");
  expect(prompt).toContain("end exactly on the last frame");
  expect(prompt).toContain(`0–3s: ${plan.early.camera}. Scene: ${plan.early.action}.`);
  expect(prompt).toContain(`3–5.5s: ${plan.mid.camera}. Scene: ${plan.mid.action}.`);
  expect(prompt).toContain(`5.5–8s: ${plan.late.camera}. Scene: ${plan.late.action}.`);
  expect(prompt).toContain("1) A glowing ring settles on the oil droplet");
  expect(prompt).toContain("3) A translucent rounded panel");
  expect(prompt.indexOf("1) A glowing")).toBeLessThan(prompt.indexOf("2) A thick"));
  expect(prompt).toContain("same 3D space: no cuts");
  expect(prompt).toContain("about 0.4 seconds");
  expect(prompt).toContain("Not a plain cross-fade and not a static zoom");
  expect(prompt).toContain("No text at any moment");
  expect(prompt).toContain("not even in the last frame");
  expect(prompt).toContain("Eight seconds, 9:16");
  // 예전 설명 컷: 저장된 motionPrompt + 예전 문장(마지막 프레임 라벨만 허용)
  const old = infoMotionPrompt(clipOf(info), texts);
  expect(old.startsWith(info.motionPrompt)).toBe(true);
  expect(old).toContain("the only text that may ever appear is the exact labels");
  expect(old).not.toContain("0–3s:");
});

test("INFO text check: a new clip is rejected on two or more readable characters, accepted when none; legacy clips compare the lines", () => {
  const fresh = clipOf(infoNew);
  expect(infoTextProblems(fresh, [])).toEqual([]);
  expect(infoTextProblems(fresh, ["", "   ", "→ ○ ✓ —"])).toEqual([]);
  // 한 글자는 링·화살표를 글자로 잘못 읽은 오탐일 수 있어 통과
  expect(infoTextProblems(fresh, ["O"])).toEqual([]);
  expect(infoTextProblems(fresh, ["가"])).toEqual([]);
  // 두 글자부터(한글·로마자·숫자) 거부, 메시지는 읽힌 덩어리를 그대로 보인다
  expect(infoTextProblems(fresh, ["600mg"])).toEqual(['INFO 이미지에 글자가 있습니다: "600mg"']);
  expect(infoTextProblems(fresh, ["12"])).toHaveLength(1);
  expect(infoTextProblems(fresh, ["엑스트라  버진", "→", "label"])).toEqual([
    'INFO 이미지에 글자가 있습니다: "엑스트라 버진" / "label"',
  ]);
  expect(infoTextProblems(fresh, ["a", "b"])).toHaveLength(1);
  const many = infoTextProblems(
    fresh,
    Array.from({ length: 10 }, (_, i) => `word${i}`),
  );
  expect(many[0]).toContain('"word7"');
  expect(many[0]).toContain("(외 2건)");
  expect(readableTextBlocks(["  a   b ", "→", "a b", ""])).toEqual(["a b"]);
  expect(infoTextCharCount(["ab", "가", "→1"])).toBe(4);
  // 예전 설명 컷: 지정 문구 대조 그대로
  const legacy = clipOf(info);
  expect(infoTextProblems(legacy, ["엑스트라 버진 올리브유", "1캡슐 60mg"])).toEqual([
    'INFO 이미지에서 "1캡슐 600mg" 글자를 찾지 못했습니다.',
  ]);
  expect(infoTextProblems(legacy, [...info.infoLines])).toEqual([]);
});

test("the bundle says INFO must have no text and is checked automatically; legacy bundles keep the exact lines", () => {
  const base = {
    id: "I1" as const,
    stage: "mechanism",
    cleanPrompt: "clean",
    infoPrompt: "info",
    motionPrompt: "motion",
    cleanFile: "flow-1-I1-clean.png",
    infoFile: "flow-1-I1-info.png",
    outputFile: "flow-1-I1.mp4",
    suggestedModel: "Veo 3.1 - Lite" as const,
    imageImportCommands: [
      "bun run flow import-image j 1 I1 clean <CLEAN>",
      "bun run flow import-image j 1 I1 info <INFO>",
    ],
    importCommand: "bun run flow import j 1 I1 <mp4>",
    // 혼합형 장면 필드(2026-10-07)는 예전·immersive 번들에서 기본값이다
    sceneType: "" as const,
    objects: [],
    actions: [],
    emphasis: [],
  };
  const bundle = (clip: FlowExport["infoClips"][number]): FlowExport => ({
    version: 1,
    jobId: "j",
    number: 1,
    title: "t",
    flowUrl: FLOW_URL,
    checklist: ["x"],
    clips: [],
    infoClips: [clip],
  });
  const fresh = flowExportMarkdown(
    bundle({ ...base, graphicOrder: [...infoNew.graphicOrder], plan: infoNew.plan, infoLines: [] }),
  );
  expect(fresh).toContain("## 설명 컷 I1 (mechanism)");
  // be958ae 가 문구를 "(이 컷의 프롬프트 기준)"으로 바꿨다(설명 설계 컷은 라벨을 넣으므로 "앱이 그린다"가 모든 컷에 맞지 않는다)
  expect(fresh).toContain("INFO 에는 글자·숫자·라벨이 없어야 한다(이 컷의 프롬프트 기준)");
  expect(fresh).toContain("앱이 글자 유무를 자동 검사해 읽히는 글자가 있으면 거부한다");
  expect(fresh).toContain("CLEAN 에는 글자·화살표·라벨·강조 링이 없어야 한다");
  expect(fresh).toContain(
    "그래픽 순서: 1) A glowing ring settles on the oil droplet 2) A thick callout",
  );
  expect(fresh).not.toContain("넣을 문구");
  const legacy = flowExportMarkdown(
    bundle({ ...base, graphicOrder: [], plan: emptyClipPlan(), infoLines: [...info.infoLines] }),
  );
  expect(legacy).toContain("넣을 문구(정확히): 엑스트라 버진 올리브유 / 1캡슐 600mg");
  expect(legacy).toContain("글자가 지정 문구와 같은지 화면에서 확인한다");
  expect(legacy).toContain("지정 문구와 자동 대조");
  expect(legacy).not.toContain("그래픽 순서");
});

// --- 혼합형(hybrid_explainer_v1, 2026-10-07): 설명 세계 프롬프트(H5·REF R1~R3·R7·R9)·번들·글자 검사 ---------------------
// 설명 장면은 실사 기준(styleAnchor)·참조 사진 없이 설명 세계 기준(explainerAnchor)만 쓴다. 글자는 앱 자막 한 줄뿐이라
// INFO 글자 검사는 "읽히는 글자 없음" 방식이고, 사람 유무는 눈으로 본다.
function hybridScript(): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: "concept-1",
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
function hybridClips(script = hybridScript()) {
  const [i1, i2] = script.infoClips;
  if (!i1 || !i2) throw new Error("fixture hybrid info clips");
  return {
    i1,
    i2,
    explainer: { explainerAnchor: script.explainerAnchor, subjects: script.subjects },
  };
}
const PEOPLE_RULE = "No people, hands, faces or characters anywhere";
const TEXT_RULE_HEAD =
  "No text, letters, numbers, labels, name tags, leader lines, arrows, rings, icons";

test("hybrid CLEAN prompt: explainer anchor + objects with their colors, no live-action anchor or reference photo, no text, no people", () => {
  const { i1, i2, explainer } = hybridClips();
  // 라우팅: 장면이 있는 설명 컷은 immersive 플래그·styleAnchor 와 무관하게 설명 세계 프롬프트다
  const prompt = infoCleanPrompt(i1, HYBRID_STYLE_ANCHOR, texts, { explainer });
  expect(prompt).toBe(hybridCleanPrompt(i1, explainer, texts));
  expect(infoCleanPrompt(i1, HYBRID_STYLE_ANCHOR, texts, { immersive: true, explainer })).toBe(
    prompt,
  );
  expect(prompt.startsWith(HYBRID_EXPLAINER_ANCHOR)).toBe(true);
  expect(prompt).toContain(i1.cleanPrompt);
  expect(prompt).not.toContain(HYBRID_STYLE_ANCHOR);
  expect(prompt).not.toContain("attached reference photo");
  expect(prompt).not.toContain(CLEAN_KEYFRAME_TAIL);
  // 물체는 subjects 의 외형과 선언한 색으로(ID 는 참조용 글자가 아님)
  expect(prompt).toContain(
    "1) capsule — clay-white translucent capsule shell, rounded ends — in the first brand accent color",
  );
  expect(prompt).toContain(
    "2) oil — golden olive oil volume, smooth glossy surface — in the second brand accent color",
  );
  expect(prompt).toContain("never visible text");
  expect(prompt).toContain("before any action happens");
  expect(prompt).toContain("negative space");
  expect(prompt).toContain(EXPLAINER_WORLD);
  expect(prompt).toContain("Clay-white 3D model world");
  expect(prompt).toContain(PEOPLE_RULE);
  expect(prompt).toContain(TEXT_RULE_HEAD);
  expect(prompt).toContain("Vertical 9:16.");
  // color_code 강조의 대상(I2 의 capsule)은 CLEAN 에서 아직 중립이고 다른 물체는 선언한 색 그대로
  const comparison = hybridCleanPrompt(i2, explainer, texts);
  expect(comparison).toContain(
    "1) capsule — clay-white translucent capsule shell, rounded ends — in neutral clay-white",
  );
  expect(comparison).toContain("2) bottle — ");
  expect(comparison).not.toContain(
    "capsule — clay-white translucent capsule shell, rounded ends — in the first",
  );
  // 설명 세계 기준이 없어도 프롬프트는 만들어진다(기준은 대본 규칙이 hard 로 요구한다)
  expect(infoCleanPrompt(i1, HYBRID_STYLE_ANCHOR, texts)).toContain(TEXT_RULE_HEAD);
});

test("hybrid INFO prompt: same CLEAN camera, consistent final state, readable emphasis and conditional text", () => {
  const { i1, i2, explainer } = hybridClips();
  const prompt = infoOverlayPrompt(i1, texts, { explainer });
  expect(prompt).toBe(hybridOverlayPrompt(i1, explainer, texts));
  expect(prompt).toContain("Use the attached CLEAN image as the same 3D scene");
  expect(prompt).toContain("preserve object identity, materials, camera framing and light");
  expect(prompt).toContain(i1.infoPrompt);
  // 2026-10-08: INFO 문구(infoLines)가 있으면 튜토리얼식 인포그래픽 지시 + 정확한 문구, 글자 금지·평면 금지 문장은 빠진다
  expect(prompt).toContain(
    "a bold arrow for direction, a dimension line with end ticks for a supported measurement",
  );
  expect(prompt).toContain("between 20% and 65% of frame height");
  expect(prompt).toContain(
    "write exactly these text lines, each exactly once, in Korean exactly as given with the same digits and symbols, and no other letters, words or numbers anywhere: 1) 캡슐 안은 올리브유",
  );
  expect(prompt).not.toContain(EXPLAINER_TEXT_RULE);
  expect(prompt).not.toContain("Keep the original composition and camera of CLEAN");
  const notext = hybridOverlayPrompt({ ...i1, infoLines: [] }, explainer, texts);
  expect(notext).toContain("Keep the original composition and camera of CLEAN");
  expect(notext).toContain("Emphasis is never a flat graphic");
  expect(notext).toContain(EXPLAINER_TEXT_RULE);
  expect(notext).not.toContain("a dimension line with end ticks for a supported measurement");
  expect(prompt).toContain(
    "Show the final state reached after these actions, in order; the described INFO state and the last action must agree: 1) The capsule shell splits open along its seam 2) Golden olive oil pours into the open shell 3) The oil level rises until the shell is full",
  );
  expect(prompt).toContain(
    "1) after action 1, a bold, clearly visible outline traces the silhouette or relevant boundary of capsule (clay-white translucent capsule shell, rounded ends) without hiding its structure",
  );
  expect(prompt).toContain(
    "2) after action 2, a clearly visible glowing line or arrow follows the surface or travel path of oil (golden olive oil volume, smooth glossy surface)",
  );
  expect(prompt).toContain("each attached to an object in the scene");
  expect(prompt).toContain(PEOPLE_RULE);
  // 예전 글자 없는 INFO 의 문구(ABSOLUTELY)와 immersive 의 라벨 문구는 없다
  expect(prompt).not.toContain("ABSOLUTELY NO TEXT");
  expect(prompt).not.toContain("<explanation-plan>");
  // color_code → 대상을 제 강조색으로 물들임(비교 장면)
  const comparison = hybridOverlayPrompt(i2, explainer, texts);
  expect(comparison).toContain(
    "1) after action 1, capsule (clay-white translucent capsule shell, rounded ends) takes on the first brand accent color so it reads apart from the other objects by color alone",
  );
  // ghost_object → 반투명 비유 물체. 강조는 동작 순서로 정렬된다
  const ghost = {
    ...i1,
    emphasis: [
      { kind: "ghost_object" as const, target: "oil", afterAction: 2 },
      { kind: "outline" as const, target: "capsule", afterAction: 0 },
    ],
  };
  const sorted = hybridOverlayPrompt(ghost, explainer, texts);
  expect(sorted).toContain("1) after action 1, a bold, clearly visible outline");
  expect(sorted).toContain(
    "2) after action 3, a translucent ghost object appears beside oil (golden olive oil volume, smooth glossy surface) as a physical analogy",
  );
  expect(sorted.indexOf("1) after action 1")).toBeLessThan(sorted.indexOf("2) after action 3"));
  // 강조가 없으면 CLEAN 과의 차이는 끝난 동작뿐
  expect(hybridOverlayPrompt({ ...i1, emphasis: [] }, explainer, texts)).toContain(
    "No emphasis marks: the only difference from CLEAN is the finished actions.",
  );
});

test("hybrid motion prompt: CLEAN → INFO, one timetable, ordered actions and graphics, spatial camera and conditional text", () => {
  const { i1, explainer } = hybridClips();
  const prompt = infoMotionPrompt(i1, texts, { explainer });
  expect(prompt).toBe(hybridMotionPrompt(i1, explainer, texts));
  const plan = i1.plan;
  expect(
    prompt.startsWith(
      "Start exactly on the first attached CLEAN frame and end exactly on the second attached INFO frame.",
    ),
  ).toBe(true);
  expect(prompt).toContain(`0–3s: ${plan.early.camera}. Scene: ${plan.early.action}.`);
  expect(prompt).toContain(`3–5.5s: ${plan.mid.camera}. Scene: ${plan.mid.action}.`);
  expect(prompt).toContain(`5.5–8s: ${plan.late.camera}. Scene: ${plan.late.action}.`);
  expect(prompt).toContain(
    "The objects perform these actions in order, aligned with the phase plan; each reaches its stated result before the next begins and the final object state matches INFO: 1) The capsule shell splits open along its seam 2) Golden olive oil pours into the open shell 3) The oil level rises until the shell is full",
  );
  expect(prompt).toContain(
    "Emphasis appears in this order and then stays: 1) after action 1, a bold, clearly visible outline traces the silhouette or relevant boundary of capsule",
  );
  expect(prompt).toContain("2) after action 2, a clearly visible glowing line");
  expect(prompt.indexOf("The objects perform these actions")).toBeLessThan(
    prompt.indexOf("Emphasis appears in this order"),
  );
  expect(prompt).toContain(
    "Follow the planned start position, target, spatial route and final viewpoint through real 3D depth",
  );
  expect(prompt).toContain(
    "finish in exactly the supplied INFO composition after the planned actions",
  );
  expect(prompt).toContain(
    "settle or slow down when the target, complete label and its boundary need to be read",
  );
  expect(prompt).toContain("No plain cross-fade, static image zoom or slideshow");
  expect(prompt).toContain("no cuts or jump to another scene");
  expect(prompt).toContain(PEOPLE_RULE);
  expect(prompt).toContain("do not pop every graphic in together at a fixed second");
  expect(prompt).toContain("in Korean exactly as given: 1) 캡슐 안은 올리브유. No other letters");
  expect(prompt).not.toContain(
    `No text at any moment, not even in the last frame: ${TEXT_RULE_HEAD}`,
  );
  expect(hybridMotionPrompt({ ...i1, infoLines: [] }, explainer, texts)).toContain(
    `No text at any moment, not even in the last frame: ${TEXT_RULE_HEAD}`,
  );
  expect(prompt).toContain("Eight seconds, 9:16. No speech, dialogue or lip sync.");
  // 예전·immersive 문구는 없다
  expect(prompt).not.toContain("the clean photo");
  expect(prompt).not.toContain("<explanation-plan>");
  expect(prompt).not.toContain("Preserve the final INFO image's exact infographic labels");
  // 강조가 없으면 그 사실을 적고, 계획이 비면 구간 문단을 생략한다
  const bare = hybridMotionPrompt({ ...i1, emphasis: [], plan: emptyClipPlan() }, explainer, texts);
  expect(bare).toContain("No emphasis marks appear.");
  expect(bare).not.toContain("0–3s:");
});

test("hybrid INFO images with infoLines compare the text; older text-free explainer scenes keep the no-text check", () => {
  // 2026-10-08(사용자 결정): 인포그래픽은 Flow INFO 이미지 안에 — 앱은 글자를 지정 문구와 대조한다(빠짐·추가 거부, 화살표·링은 허용)
  const { i1 } = hybridClips();
  expect(infoClipExpectsText(i1)).toBe(true);
  expect(infoTextProblems(i1, ["캡슐 안은 올리브유"])).toEqual([]);
  expect(infoTextProblems(i1, ["캡슐안은", "올리브유"], ["arrow", "ring", "leader_line"])).toEqual(
    [],
  );
  expect(infoTextProblems(i1, [])).toEqual([
    'INFO 이미지에서 "캡슐 안은 올리브유" 글자를 찾지 못했습니다.',
  ]);
  expect(infoTextProblems(i1, ["캡슐 안은 올리브유", "600mg"])).toEqual([
    expect.stringContaining("계획하지 않은 글자가 있습니다"),
  ]);
  // 예전 혼합형 설명 장면(infoLines 없음, 6e736cd8 등)은 읽히는 글자가 있으면 거부
  const old = { ...i1, infoLines: [] };
  expect(infoClipExpectsText(old)).toBe(false);
  expect(infoTextProblems(old, [])).toEqual([]);
  expect(infoTextProblems(old, ["○", "→"])).toEqual([]);
  expect(infoTextProblems(old, ["600mg"])).toEqual(['INFO 이미지에 글자가 있습니다: "600mg"']);
  expect(infoTextProblems(old, ["캡슐", "oil"])).toHaveLength(1);
});

test("hybrid INFO images also reject flat graphic marks (arrows, leader lines, boxes) while older text-free INFO keeps its rings and arrows", () => {
  // Given: 비전 판독이 글자 없이 화살표·지시선·수치 박스를 봤다(검토 지적 2026-10-07: 글자 전사만으로는 이름표 포스터를 못 거른다)
  const i1 = { ...hybridClips().i1, infoLines: [] };
  const problems = infoTextProblems(i1, [], ["arrow", "leader_line", "value_box", "arrow"]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("INFO 이미지에 평면 그래픽이 있습니다: 화살표, 지시선, 수치 박스");
  expect(problems[0]).toContain("네 가지뿐");
  // 글자와 모양이 함께 있으면 둘 다 적는다
  expect(infoTextProblems(i1, ["600mg"], ["name_tag"])).toEqual([
    'INFO 이미지에 글자가 있습니다: "600mg"',
    expect.stringContaining("이름표"),
  ]);
  // 예전 글자 없는 INFO(링·화살표가 설계)는 모양을 보지 않는다
  expect(
    infoTextProblems({ infoLines: [], graphicOrder: ["ring", "arrow"] }, [], ["ring", "arrow"]),
  ).toEqual([]);
  expect(infoTextProblems({ ...i1, sceneType: "" }, [], ["arrow"])).toEqual([]);
  // 판독기는 글줄 배열(예전 테스트 주입)과 {lines, marks} 둘 다 돌려줄 수 있다
  expect(normalizeInfoRead(["a"])).toEqual({ lines: ["a"], marks: [] });
  expect(normalizeInfoRead({ lines: [], marks: ["ring"] })).toEqual({ lines: [], marks: ["ring"] });
});

test("hybrid INFO and motion prompts carry the explainer anchor so the two brand accents are defined", () => {
  // 검토 지적(2026-10-07): CLEAN 에서 color_code 대상은 중립이라 첨부 이미지에 강조색이 없고, 강조 문구는 "first brand accent color" 자리표시자뿐이었다.
  const { i1, i2, explainer } = hybridClips();
  for (const prompt of [
    hybridOverlayPrompt(i1, explainer, texts),
    hybridMotionPrompt(i2, explainer, texts),
  ]) {
    expect(prompt).toContain(HYBRID_EXPLAINER_ANCHOR);
    expect(prompt).toContain("two brand accent colors");
    expect(prompt).not.toContain(HYBRID_STYLE_ANCHOR);
  }
  // 기준이 없으면 그 줄은 빠진다(대본 규칙이 explainerAnchor 를 hard 로 요구한다)
  const bare = { explainerAnchor: "", subjects: explainer.subjects };
  expect(hybridOverlayPrompt(i1, bare, texts)).not.toContain("two brand accent colors (the first");
});

test("the hybrid bundle: live clips get the live-action tail, explainer scenes carry scene fields, the checklist adds the eye check, and the markdown describes each scene", async () => {
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    const script = hybridScript();
    const data = buildFlowExport({ ...job, videoScripts: [script] }, 1);
    // 같은 데이터가 스키마를 통과하고 다시 읽어도 같다(시작 이미지가 아직 없는 작업이라 산출물 이름만 채운다)
    const filled = {
      ...data,
      clips: data.clips.map((clip) => ({
        ...clip,
        startImageArtifact: `start-1-${clip.id}-1.png`,
      })),
    };
    expect(FlowExportSchema.parse(JSON.parse(JSON.stringify(filled)))).toEqual(filled);
    expect(data.visualPolicy).toBe("hybrid_explainer_v1");
    // 실사 클립 A·B: 기존 프롬프트 + 실사 꼬리(H3)
    expect(data.clips.map((clip) => clip.id)).toEqual(["A", "B"]);
    for (const clip of data.clips) {
      expect(clip.prompt).toContain("0–3s:");
      expect(clip.prompt).toContain("Start exactly from the supplied image");
      expect(clip.prompt.endsWith(HYBRID_LIVE_TAIL)).toBe(true);
    }
    // 설명 장면 I1·I2: 장면 필드가 실리고 이름표·graphicOrder 는 비어 있다
    const [i1, i2] = data.infoClips;
    expect(i1).toMatchObject({
      id: "I1",
      stage: "mechanism",
      sceneType: "process",
      infoLines: ["캡슐 안은 올리브유"],
      graphicOrder: [],
      actions: [
        "The capsule shell splits open along its seam",
        "Golden olive oil pours into the open shell",
        "The oil level rises until the shell is full",
      ],
      emphasis: [
        { kind: "outline", target: "capsule", afterAction: 0 },
        { kind: "glow_line", target: "oil", afterAction: 1 },
      ],
    });
    expect(i1?.objects).toEqual([
      {
        subjectId: "capsule",
        color: "accent1",
        traits: "clay-white translucent capsule shell, rounded ends",
      },
      {
        subjectId: "oil",
        color: "accent2",
        traits: "golden olive oil volume, smooth glossy surface",
      },
    ]);
    expect(i1?.explanation).toBeUndefined();
    expect(i1?.cleanPrompt.startsWith(HYBRID_EXPLAINER_ANCHOR)).toBe(true);
    expect(i1?.infoPrompt).toContain("a bold, clearly visible outline");
    expect(i1?.motionPrompt).toContain("end exactly on the second attached INFO frame");
    expect(i2).toMatchObject({ id: "I2", sceneType: "comparison" });
    expect(i2?.objects.map((object) => object.subjectId)).toEqual(["capsule", "bottle"]);
    // 체크리스트: 설명 장면 항목 + 눈으로 확인(사람) 항목, 예전 글자 없는 INFO 문구는 없음
    expect(data.checklist).toContain(INFO_CHECKLIST_EXPLAINER);
    expect(data.checklist).toContain(HYBRID_EYE_CHECK);
    expect(data.checklist.join(" ")).not.toContain("글자는 앱이 콜아웃으로 그린다");
    expect(data.checklist.join(" ")).not.toContain("지정 문구 방식");
    // 번들 md
    const markdown = flowExportMarkdown(data);
    expect(markdown).toContain(
      "혼합형(hybrid_explainer_v1): 실사 클립(A~D)에는 사람과 상황이 보여야 하고",
    );
    expect(markdown).toContain("## 설명 장면 I1 (mechanism · 과정)");
    expect(markdown).toContain("## 설명 장면 I2 (criteria · 비교)");
    expect(markdown).toContain("실사 시작 이미지(flow-start-*.png)는 첨부하지 않는다");
    expect(markdown).toContain(
      "강조(색 구분·빨간 외곽선·흰 발광선·반투명 비유)와 인포그래픽(굵은 화살표·치수선·강조 링·한글 라벨·숫자)을 완성한 이미지",
    );
    expect(markdown).toContain("넣을 문구(정확히): 캡슐 안은 올리브유");
    expect(markdown).toContain("넣을 문구(정확히): 겉은 같은 캡슐 / 속은 다른 기름");
    expect(markdown).toContain("사람 유무는 눈으로 확인한다");
    expect(markdown).toContain(
      "물체: capsule(강조색 1: clay-white translucent capsule shell, rounded ends) / oil(강조색 2: golden olive oil volume, smooth glossy surface)",
    );
    expect(markdown).toContain(
      "동작 순서: 1) The capsule shell splits open along its seam 2) Golden olive oil",
    );
    expect(markdown).toContain(
      "강조: 빨간 외곽선 → capsule (동작 1 뒤) / 흰 발광선 → oil (동작 2 뒤)",
    );
    expect(markdown).toContain("강조: 색 구분 → capsule (동작 1 뒤)");
    expect(markdown).toContain(i1?.cleanPrompt ?? "?");
    expect(markdown).toContain(i1?.motionPrompt ?? "?");
    expect(markdown).not.toContain("\n그래픽 순서:");
    expect(markdown).not.toContain("## 설명 컷 I1");
    // 예전 내보내기(장면 필드·정책 없음)도 기본값으로 읽힌다
    const older = FlowExportSchema.parse({
      ...filled,
      visualPolicy: undefined,
      infoClips: filled.infoClips.map(
        ({ sceneType: _s, objects: _o, actions: _a, emphasis: _e, ...rest }) => rest,
      ),
    });
    expect(older.visualPolicy).toBeUndefined();
    expect(older.infoClips[0]).toMatchObject({
      sceneType: "",
      objects: [],
      actions: [],
      emphasis: [],
    });
    // 예전·immersive 대본의 번들은 그대로다(정책 없음·실사 꼬리 없음·눈 확인 항목 없음)
    const legacy = buildFlowExport({ ...job, videoScripts: [renderScript(1, "concept-1", 36)] }, 1);
    expect("visualPolicy" in legacy).toBe(false);
    expect(legacy.clips.every((clip) => !clip.prompt.includes(HYBRID_LIVE_TAIL))).toBe(true);
    expect(legacy.checklist).not.toContain(HYBRID_EYE_CHECK);
    const immersive = buildFlowExport(
      {
        ...job,
        videoScripts: [
          VideoScriptSchema.parse({
            ...infoScript(1, "concept-1", 36, infoNew),
            planning: VideoPlanningSchema.parse({
              ...fixtureVideoPlanning(),
              visualPolicy: "immersive_explanations_v1",
            }),
          }),
        ],
      },
      1,
    );
    expect(immersive.visualPolicy).toBe("immersive_explanations_v1");
    expect(immersive.clips.every((clip) => !clip.prompt.includes(HYBRID_LIVE_TAIL))).toBe(true);
    expect(immersive.checklist).not.toContain(HYBRID_EYE_CHECK);
    expect(immersive.infoClips[0]).toMatchObject({ sceneType: "", objects: [], actions: [] });
    expect(immersive.infoClips[0]?.infoPrompt).toContain("Use the attached CLEAN frame");
    expect(flowExportMarkdown(immersive)).toContain("## 설명 컷 I1 (mechanism)");
  } finally {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const origin = `http://127.0.0.1:${env.PORT}`;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
let media: string;
beforeEach(async () => {
  f = await renderRuntimeFixture({ script: (_job, id, n) => infoScript(n, id, 36) });
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
  media = await mkdtemp(join(tmpdir(), "info-clip-media-"));
});
afterEach(async () => {
  engine.close();
  await f.close();
  await rm(media, { recursive: true, force: true });
});

test.skipIf(!hasFfmpeg)(
  "an explanation clip is exported, waits for verified CLEAN/INFO images, then accepts its clip",
  async () => {
    const job = f.fresh();
    engine.start(job.id, flowPolicy);
    await settle(engine);
    const waiting = f.store.get(job.id);
    expect(waiting.automation?.status).toBe("waiting");
    expect(pendingFlowClips(waiting, 1)).toContain("I1");
    const exported = buildFlowExport(waiting, 1);
    // 예전 설명 컷: 지정 문구가 번들에 실리고 체크리스트는 대조 방식을 안내한다
    expect(exported.infoClips[0]?.infoLines).toEqual([...info.infoLines]);
    expect(exported.infoClips[0]?.graphicOrder).toEqual([]);
    expect(exported.infoClips[0]?.infoPrompt).toContain("1) 엑스트라 버진 올리브유");
    expect(exported.checklist.join(" ")).toContain("앱이 업로드 때 자동 대조한다");
    expect(flowExportMarkdown(exported)).toContain("설명 컷 I1");
    const app = createApp(f.store, new Pipeline(f.store), engine);
    const clip = new Uint8Array(await Bun.file(tinyClip(join(media, "i1.mp4"))).arrayBuffer());
    const png = new Uint8Array(await Bun.file(tinyStill(join(media, "c.png"))).arrayBuffer());
    const post = (path: string, body: Uint8Array<ArrayBuffer>, type: string) =>
      app.request(
        new Request(`${origin}/api/jobs/${job.id}/videos/1/${path}`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": type },
          body,
        }),
      );
    // 이미지 확인 전에는 설명 컷 영상을 받지 않는다.
    const early = await post("clips/I1", clip, "video/mp4");
    expect(early.status).toBe(409);
    expect(((await early.json()) as { code: string }).code).toBe("info_image");
    expect((await post("info/I1/clean", png, "image/png")).status).toBe(200);
    // INFO 글자 대조: 숫자가 틀리면 거부되고 기록은 미통과로 남는다.
    const wrong = new FlowImport(f.store, undefined, async () => [
      "엑스트라 버진 올리브유",
      "1캡슐 60mg",
    ]);
    await expect(
      wrong.importInfoImage({
        jobId: job.id,
        number: 1,
        clipId: "I1",
        which: "info",
        bytes: png,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: "info_text" });
    expect(f.store.get(job.id).renders[0]?.infoImages.I1?.verified).toBe(false);
    const right = new FlowImport(f.store, undefined, async () => [...info.infoLines]);
    await right.importInfoImage({
      jobId: job.id,
      number: 1,
      clipId: "I1",
      which: "info",
      bytes: png,
      signal: AbortSignal.timeout(5000),
    });
    expect(f.store.get(job.id).renders[0]?.infoImages.I1).toMatchObject({
      verified: true,
      problems: [],
    });
    const accepted = await post("clips/I1", clip, "video/mp4");
    expect(accepted.status).toBe(200);
    expect(pendingFlowClips(f.store.get(job.id), 1)).not.toContain("I1");
  },
);

test.skipIf(!hasFfmpeg)(
  "a new-format explanation clip rejects an INFO image with readable text and accepts a text-free one",
  async () => {
    // 2026-10-06 대본(graphicOrder·plan, infoLines 없음): INFO 에 글자가 있으면 400 flow_info_text, 없으면 통과
    const g = await renderRuntimeFixture({
      script: (_job, id, n) => infoScript(n, id, 36, infoNew),
    });
    try {
      const job = new AutomationEnrollment(g.store).start(g.fresh().id, flowPolicy);
      await g.production.run(job.id, new AbortController().signal);
      const exported = buildFlowExport(g.store.get(job.id), 1);
      expect(exported.infoClips[0]?.infoLines).toEqual([]);
      expect(exported.infoClips[0]?.graphicOrder).toEqual([...infoNew.graphicOrder]);
      expect(exported.infoClips[0]?.plan).toEqual(infoNew.plan);
      expect(exported.infoClips[0]?.infoPrompt).toContain("ABSOLUTELY NO TEXT");
      expect(exported.infoClips[0]?.motionPrompt).toContain("0–3s:");
      expect(exported.checklist.join(" ")).toContain("앱이 업로드 때 글자 유무를 자동 검사한다");
      const png = new Uint8Array(await Bun.file(tinyStill(join(media, "n.png"))).arrayBuffer());
      const base = {
        jobId: job.id,
        number: 1,
        clipId: "I1" as const,
        bytes: png,
        signal: AbortSignal.timeout(5000),
      };
      await new FlowImport(g.store, undefined, async () => []).importInfoImage({
        ...base,
        which: "clean",
      });
      const noisy = new FlowImport(g.store, undefined, async () => ["Product Benefits", "600mg"]);
      await expect(noisy.importInfoImage({ ...base, which: "info" })).rejects.toMatchObject({
        code: "flow_info_text",
        status: 400,
      });
      const state = g.store.get(job.id).renders[0]?.infoImages.I1;
      expect(state?.verified).toBe(false);
      expect(state?.problems.join(" ")).toContain('"Product Benefits" / "600mg"');
      expect(
        g.store.get(job.id).events.some((event) => event.message.includes("글자 확인 실패 1건")),
      ).toBe(true);
      const unicodeText = new FlowImport(g.store, undefined, async () => ["商品説明", "ラベル"]);
      await expect(unicodeText.importInfoImage({ ...base, which: "info" })).rejects.toMatchObject({
        code: "flow_info_text",
        status: 400,
      });
      // 글자 없는(그래픽만 읽힌) INFO 는 통과하고 기록이 verified 가 된다
      const clean = new FlowImport(g.store, undefined, async () => ["○", "→"]);
      const result = await clean.importInfoImage({ ...base, which: "info" });
      expect(result.problems).toEqual([]);
      expect(g.store.get(job.id).renders[0]?.infoImages.I1).toMatchObject({
        verified: true,
        problems: [],
      });
    } finally {
      await g.close();
    }
  },
);

test.skipIf(!hasFfmpeg)(
  "a hybrid INFO image with readable text is rejected with the caption-only reason; a graphics-only one is verified",
  async () => {
    // 혼합형 대본을 Flow 모드 작업에 직접 넣는다(유료 호출 0, 대본 생성 없음)
    const store = f.store;
    const job = new AutomationEnrollment(store).start(f.fresh().id, flowPolicy);
    const script = hybridScript();
    store.change(job.id, (draft) => {
      draft.videoScripts = [script];
    });
    // PNG 시그니처만 있는 바이트: imageInput 은 시그니처·크기만 본다
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const base = {
      jobId: job.id,
      number: 1,
      clipId: "I1" as const,
      bytes: png,
      signal: AbortSignal.timeout(5000),
    };
    await new FlowImport(store, undefined, async () => []).importInfoImage({
      ...base,
      which: "clean",
    });
    // 2026-10-08: INFO 문구(infoLines)가 있는 설명 장면은 글자를 지정 문구와 대조한다 — 다른 글자(영문·깨진 한글)는 거부, 같으면 verified
    const noisy = new FlowImport(store, undefined, async () => ["Capsule", "Oil"]);
    await expect(noisy.importInfoImage({ ...base, which: "info" })).rejects.toMatchObject({
      code: "info_text",
      status: 400,
      message: expect.stringContaining("INFO 이미지의 글자가 지정 문구와 다릅니다"),
    });
    expect(store.get(job.id).renders[0]?.infoImages.I1?.verified).toBe(false);
    const clean = new FlowImport(store, undefined, async () => ["캡슐 안은 올리브유"]);
    const result = await clean.importInfoImage({ ...base, which: "info" });
    expect(result.problems).toEqual([]);
    expect(store.get(job.id).renders[0]?.infoImages.I1).toMatchObject({
      verified: true,
      problems: [],
    });
  },
);
