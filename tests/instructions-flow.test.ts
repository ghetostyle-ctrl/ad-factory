import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import {
  clipPromptFor,
  FLOW_SECTION_SPECS,
  flowExportFor,
  flowTexts,
} from "../server/flow-instructions";
import {
  defaultInstructionsRoot,
  INSTRUCTION_SECTIONS,
  InstructionsLoader,
  loadInstructions,
  THRESHOLDS_FILE,
  WIRED_INSTRUCTION_FILES,
} from "../server/instructions";
import { sceneImagePrompt } from "../server/scene-image-references";
import { sourceImagePrompt } from "../server/source-image-style";
import { startImagePrompt } from "../server/start-image-production";
import { stillPrompt } from "../server/still-production";
import { guardCopyEdit } from "../shared/copy-polish";
import { FlowExportPreviewSchema, flowChecklist, infoOverlayPrompt } from "../shared/flow-mode";
import { FLOW_TEXT_KEYS } from "../shared/flow-texts";
import { narrationCaptions } from "../shared/narration-captions";
import { silenceTrimPlan, timelineDefaults } from "../shared/render-timeline";
import { classifyScriptProblems, scenePlanProblems, scriptFeedback } from "../shared/script-rules";
import {
  DEFAULT_THRESHOLDS,
  resetThresholds,
  thresholds,
  withThresholds,
} from "../shared/thresholds";
import { InfoClipSchema, VideoScriptSchema } from "../shared/video-script";
import { providerStore } from "./provider-fixtures";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { fixtureClipPlan } from "./video-script-fixture";

// Flow·이미지 프롬프트와 임계값(사용자 결정 2026-10-07): 문장은 instructions/flow.md, 숫자는 instructions/thresholds.json.
// (1) flow.md 절 ↔ FLOW_TEXT_KEYS 가 같고, 파일을 고치면 다음 호출부터 프롬프트가 바뀐다(재시작 없음, 임시 root).
// (2) 임계값은 shared/thresholds.ts 에 주입돼 규칙 검사·타임라인·자막이 읽는다(COPY_BEAT_MAX_CHARS 30 → 35자 문장 거부).
// (3) 화면은 서버가 조립한 Flow 번들을 GET /api/jobs/:id/videos/:n/flow-export 로 받는다.
const roots: string[] = [];
afterEach(() => {
  resetThresholds();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// 저장소의 instructions/ 전체를 임시 폴더로 복사한다(전체 로더가 8개 파일을 모두 요구한다).
function copiedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-instructions-flow-"));
  roots.push(root);
  cpSync(defaultInstructionsRoot(), root, { recursive: true });
  return root;
}
let tick = 0;
function rewrite(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text, "utf8");
  tick += 2;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(join(root, name), when, when);
}
function editThreshold(root: string, name: string, value: number): void {
  const parsed = JSON.parse(readFileSync(join(root, THRESHOLDS_FILE), "utf8")) as Record<
    string,
    { value: number }
  >;
  rewrite(root, THRESHOLDS_FILE, JSON.stringify({ ...parsed, [name]: { ...parsed[name], value } }));
}
const graphicOrderClip = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Close-up of a capsule cut in half on a wooden table",
  infoPrompt: "A thick callout line from the oil droplet to an empty rounded panel",
  graphicOrder: ["A glowing ring settles on the oil droplet", "A thick callout line grows"],
  plan: fixtureClipPlan("I1"),
});
const planned = sourcePlanResponse("fact-1").hypotheses[1];
if (!planned) throw new Error("fixture hypothesis");
const hypothesis = { ...planned, cardSlides: [] };
const origin = `http://127.0.0.1:${env.PORT}`;

test("flow.md is wired: its sections equal FLOW_TEXT_KEYS, the default loader reads it, and every text is non-empty", () => {
  const registry = INSTRUCTION_SECTIONS.filter((item) => item.file === "flow.md").map(
    (item) => item.key,
  );
  expect([...registry].sort()).toEqual([...FLOW_TEXT_KEYS].sort());
  expect(FLOW_SECTION_SPECS.map((spec) => spec.key).sort()).toEqual([...registry].sort());
  expect(WIRED_INSTRUCTION_FILES).toContain("flow.md");
  const snapshot = loadInstructions();
  expect(snapshot.files.some((file) => file.name === "flow.md")).toBe(true);
  const texts = flowTexts(snapshot);
  for (const key of FLOW_TEXT_KEYS) expect(texts[key].trim().length, key).toBeGreaterThan(0);
  // 로드 때 치환되는 토큰(임계값·{{@KEY}})은 남지 않고, 호출 시점 토큰만 남는다
  expect(texts.HYBRID_MOTION_TEXT).toContain(texts.EXPLAINER_TEXT_RULE);
  expect(texts.INFO_OVERLAY_BAND).toContain("between 20% and 65%");
  expect(texts.INFO_OVERLAY_BAND).toContain("bottom 35% free");
  expect(texts.IMMERSIVE_BAND).toContain("middle 20–65%");
  expect(texts.FLOW_CHECKLIST).toContain("{{model}}");
  expect(flowChecklist("Veo 3.1 - Lite", texts)).toHaveLength(8);
  expect(flowChecklist("Veo 3.1 - Lite", texts)[1]).toContain(
    "Veo 3.1 - Lite(내보낸 suggestedModel)",
  );
  // 기본 로더가 앱 임계값을 주입한다(저장소 값 = 기본값)
  expect(thresholds()).toEqual(DEFAULT_THRESHOLDS);
});

test("editing flow.md or thresholds.json changes the next prompt without a restart; a broken edit keeps the last good text", () => {
  const root = copiedRoot();
  const loader = new InstructionsLoader({ root });
  const script = renderScript(1, "concept-0", 36);
  const clip = script.veoClips[0];
  const still = script.stills[0];
  if (!clip || !still) throw new Error("render fixture clip or still missing");
  const before = flowTexts(loader.load());
  expect(startImagePrompt(script, clip, before).endsWith(before.CLEAN_KEYFRAME_TAIL)).toBe(true);
  // 절 본문 수정 → 다음 load 부터 시작·정지 이미지·설명 컷 CLEAN 프롬프트의 꼬리가 바뀐다
  const flowMd = readFileSync(join(root, "flow.md"), "utf8");
  rewrite(
    root,
    "flow.md",
    flowMd.replace(before.CLEAN_KEYFRAME_TAIL, "NEW TAIL: no text anywhere in the image."),
  );
  editThreshold(root, "INFO_GRAPHIC_BAND_TOP", 25);
  const after = flowTexts(loader.load());
  expect(after.CLEAN_KEYFRAME_TAIL).toBe("NEW TAIL: no text anywhere in the image.");
  expect(startImagePrompt(script, clip, after)).toEndWith(
    "\nNEW TAIL: no text anywhere in the image.",
  );
  expect(stillPrompt(script, still, after)).toEndWith("\nNEW TAIL: no text anywhere in the image.");
  expect(startImagePrompt(script, clip, after)).not.toBe(startImagePrompt(script, clip, before));
  // 임계값 토큰은 로드 때 치환된다(띠 위 경계 20 → 25, 아래 여백은 그대로 35)
  expect(infoOverlayPrompt(graphicOrderClip, after)).toContain("between 25% and 65%");
  expect(infoOverlayPrompt(graphicOrderClip, after)).toContain(
    "Keep the top 25% and the bottom 35% free",
  );
  expect(after.IMMERSIVE_BAND).toContain("middle 25–65%");
  // 다른 절·서버 이미지 문장은 그대로 쓰인다
  expect(sceneImagePrompt("Base.", 2, after)).toBe(
    `Base.\n${after.SCENE_IMAGE_REFERENCE_1} ${after.SCENE_IMAGE_REFERENCE_2}`,
  );
  expect(sceneImagePrompt("Base.", 1, after)).toBe(
    `Base.\n${after.SCENE_IMAGE_REFERENCE_1} ${after.SCENE_IMAGE_REFERENCE_NONE}`,
  );
  expect(sceneImagePrompt("Base.", 0, after)).toBe("Base.");
  const immersiveScript = VideoScriptSchema.parse({
    ...script,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
  });
  expect(sourceImagePrompt({ videoScripts: [immersiveScript] }, "concept-0", "Card.", after)).toBe(
    `Card.\n${after.IMMERSIVE_PALETTE}\n${after.SOURCE_IMAGE_IMMERSIVE_NOTE}`,
  );
  expect(clipPromptFor(clip, { liveAction: true }, after)).toEndWith(` ${after.HYBRID_LIVE_TAIL}`);
  // 절 하나를 지우면 마지막 성공본(NEW TAIL)이 그대로 쓰이고 경고가 남는다
  rewrite(
    root,
    "flow.md",
    readFileSync(join(root, "flow.md"), "utf8").replace("## CLIP_PLAN_TAIL", "## RENAMED"),
  );
  const broken = loader.load();
  expect(broken.warnings[0]).toContain("CLIP_PLAN_TAIL 이 없습니다");
  expect(flowTexts(broken).CLEAN_KEYFRAME_TAIL).toBe("NEW TAIL: no text anywhere in the image.");
  expect(flowTexts(broken).CLIP_PLAN_TAIL).toBe(before.CLIP_PLAN_TAIL);
});

test("thresholds from the file drive the rule checks: COPY_BEAT_MAX_CHARS 30 rejects a 35-character sentence (reset restores 40)", () => {
  const root = copiedRoot();
  editThreshold(root, "COPY_BEAT_MAX_CHARS", 30);
  editThreshold(root, "COPY_BEAT_TARGET_CHARS", 20);
  const script = renderScript(1, hypothesis.id, 36);
  const first = script.voiceover[0];
  if (!first) throw new Error("fixture voiceover missing");
  const long = "가".repeat(35);
  const edited = VideoScriptSchema.parse({
    ...script,
    voiceover: [{ ...first, text: long }, ...script.voiceover.slice(1)],
    cuts: script.cuts.map((cut, index) =>
      index === first.fromCut ? { ...cut, narration: long } : cut,
    ),
  });
  const expected = { number: 1, durationSec: 36, hypothesis, hasProjectClips: true };
  const beat = (hard: readonly string[]) => hard.filter((item) => item.includes("한 호흡("));
  // 기본값 40 자: 35 자 문장은 거부되지 않는다
  expect(beat(classifyScriptProblems(edited, expected).hard)).toEqual([]);
  // 로더가 임시 root 의 값을 주입(apply) → 같은 문장이 hard 로 거부된다
  const loader = new InstructionsLoader({ root, apply: true });
  loader.load();
  expect(thresholds().COPY_BEAT_MAX_CHARS).toBe(30);
  expect(thresholds().COPY_BEAT_TARGET_CHARS).toBe(20);
  const rejected = beat(classifyScriptProblems(edited, expected).hard);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toContain("35자입니다");
  expect(rejected[0]).toContain("한 호흡(30자 이내)");
  // 범위 밖으로 고치면(COPY_BEAT_MAX_CHARS 5 < 20 하한) 마지막 성공본 값(30)이 유지된다
  editThreshold(root, "COPY_BEAT_MAX_CHARS", 5);
  expect(loader.load().warnings[0]).toContain("허용 범위");
  expect(thresholds().COPY_BEAT_MAX_CHARS).toBe(30);
  // 되돌리면 기본값으로 검사한다
  resetThresholds();
  expect(beat(classifyScriptProblems(edited, expected).hard)).toEqual([]);
});

test("other injected thresholds change their rules too: cut length, feedback cap, caption lead, timeline defaults, copy-change warning", () => {
  const script = renderScript(1, hypothesis.id, 36);
  // CUT_MAX_SEC: 장면 계획 대본의 2초 컷은 기본(5초)에서 통과, 1초 상한에서는 거부
  const cutRule = (hard: readonly string[]) =>
    hard.filter((item) => item.includes("이하로 나누세요"));
  expect(cutRule(scenePlanProblems(script).hard)).toEqual([]);
  expect(
    withThresholds({ CUT_MAX_SEC: 1 }, () => cutRule(scenePlanProblems(script).hard)).length,
  ).toBeGreaterThan(0);
  // VERIFY_FEEDBACK_MAX: 2 로 줄이면 세 번째 위반부터 "(외 N건 더 있음)"
  const problems = ["a", "b", "c", "d"];
  expect(scriptFeedback(problems)).not.toContain("외 ");
  expect(withThresholds({ VERIFY_FEEDBACK_MAX: 2 }, () => scriptFeedback(problems))).toBe(
    "영상 대본 규칙 위반: a / b / (외 2건 더 있음)",
  );
  // CAPTION_LEAD_MS: 자막이 말보다 앞서는 시간
  const voice = {
    index: 0,
    text: "하루 한 알이면 충분해요",
    artifactName: "",
    tempo: 1,
    startMs: 1000,
    durationMs: 1500,
    words: [],
  };
  expect(narrationCaptions([voice])[0]?.startMs).toBe(800);
  expect(withThresholds({ CAPTION_LEAD_MS: 0 }, () => narrationCaptions([voice])[0]?.startMs)).toBe(
    1000,
  );
  // 타임라인 기본값·무음 상한
  expect(timelineDefaults()).toMatchObject({
    gapMs: 150,
    slackMs: 300,
    maxSpreadMs: 500,
    maxExtendMs: 3000,
  });
  expect(
    withThresholds(
      { VOICE_GAP_SEC: 0.2, TIMELINE_SLACK_MS: 100, TIMELINE_MAX_EXTEND_MS: 500 },
      () => timelineDefaults(),
    ),
  ).toMatchObject({ gapMs: 200, slackMs: 100, maxExtendMs: 500, maxTempo: 1.3 });
  expect(silenceTrimPlan(script, new Map(), 150, 300).trim).toHaveLength(script.cuts.length);
  // COPY_CHANGE_WARNING_RATE: 0 이면 어떤 변경도 경고
  const draft = {
    copy: { lines: [{ text: "하루 한 알이면 충분해요", screenText: "하루 한 알" }] },
  };
  const editedCopy = {
    lines: [{ text: "하루 한 알이면 충분하죠", screenText: "하루 한 알" }],
    review: { status: "revised" as const, summary: "요약", edits: [] },
  };
  type Draft = Parameters<typeof guardCopyEdit>[0];
  type Edited = Parameters<typeof guardCopyEdit>[1];
  expect(guardCopyEdit(draft as Draft, editedCopy as Edited).review.summary).toBe("요약");
  expect(
    withThresholds(
      { COPY_CHANGE_WARNING_RATE: 0 },
      () => guardCopyEdit(draft as Draft, editedCopy as Edited).review.summary,
    ),
  ).toContain("바뀌었습니다");
});

test("GET /api/jobs/:id/videos/:n/flow-export returns the server-assembled bundle the panel shows; a missing script is 404", async () => {
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    store.change(job.id, (draft) => {
      draft.videoScripts = [renderScript(1, "concept-0", 36)];
    });
    const app = createApp(store);
    const response = await app.request(`${origin}/api/jobs/${job.id}/videos/1/flow-export`);
    expect(response.status).toBe(200);
    // 시작 이미지가 아직 없는 작업이라 startImageArtifact 가 비어 있다(미리 보기 스키마).
    const data = FlowExportPreviewSchema.parse(await response.json());
    expect(data).toEqual(flowExportFor(store.get(job.id), 1));
    expect(data.clips[0]?.prompt).toContain(flowTexts().CLIP_PLAN_TAIL);
    expect(data.checklist).toHaveLength(8);
    const missing = await app.request(`${origin}/api/jobs/${job.id}/videos/2/flow-export`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("flow_script");
  } finally {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});
