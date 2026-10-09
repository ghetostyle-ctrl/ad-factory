import type { CreativePlan } from "../shared/creative-plan";
import { videoOfferAllowed } from "../shared/script-rules";
import { minSentenceSec, VEO_CLIP_SEC } from "../shared/video-script";
import { copyRhythmInstruction } from "./copy-instructions";
import { hybridScriptRules } from "./hybrid-script-instructions";
import { immersiveScriptRules } from "./immersive-script-instructions";
import {
  fillSection,
  type InstructionsSnapshot,
  loadInstructions,
  sectionJson,
  sectionOf,
} from "./instructions";

// 대본 생성 프롬프트. 문구는 instructions/script.md(공통)·hybrid.md·immersive.md·examples.md 의 절이고, 여기서는 정책(legacy·immersive·
// hybrid)에 따라 절을 고르고 호출 시점 값({{seconds}}, {{maxCutSec}} 등)을 채워 같은 순서로 잇는다. 숫자 임계값은 로더가 thresholds.json
// 으로 치환했다. JSON SHAPE 줄(응답 칸 이름)은 스키마와 묶여 있어 코드에 남는다.
// 분리 전(b3ef40a) 출력과 바이트 단위로 같아야 한다 — tests/golden/instructions-script-*.txt.

// 레퍼런스의 편집 구조 예시 3개(examples.md). 중괄호 자리는 현재 작업의 사실 자료로 채워야 한다고 프롬프트가 같이 적는다.
export function scriptReferenceExamples(
  snapshot: InstructionsSnapshot = loadInstructions(),
): unknown {
  return sectionJson(snapshot, "SCRIPT_REFERENCE_EXAMPLES");
}

export function videoScriptInstructions(
  input: {
    readonly seconds: number;
    readonly hypothesis: CreativePlan["hypotheses"][number];
    readonly hasClips: boolean;
    // 설명 컷(CLEAN→INFO 전환, I1~I3)은 Flow 모드에서만 만든다.
    readonly infoClips?: boolean;
    readonly immersive?: boolean;
    // 혼합형(hybrid_explainer_v1, 2026-10-07): 실사 비트 + 설명 세계. immersive 와 동시에 참이면 hybrid 가 우선한다.
    readonly hybrid?: boolean;
    readonly feedback?: string;
  },
  // 호출부가 같은 스냅샷으로 산출물에 해시를 남길 수 있게 받는다. 생략하면 지금 파일을 읽는다.
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  const { seconds, hypothesis, hasClips, feedback } = input;
  const hybrid = input.hybrid ?? false;
  const immersive = !hybrid && (input.immersive ?? false);
  const text = (key: string) => sectionOf(snapshot, key);
  const { thresholds } = snapshot;
  const maxCutSec = immersive ? VEO_CLIP_SEC : thresholds.CUT_MAX_SEC;
  // PACING 한 줄 = 머리(목표·한도) + 비트 분리 + 말 속도 + (legacy·hybrid 만) 환산표 + 꼬리. immersive 는 환산표 자리가 빈 문자열이라
  // 공백이 두 칸이 된다(예전 출력과 같다).
  const table = [10, 20, thresholds.COPY_BEAT_TARGET_CHARS, 30, thresholds.COPY_BEAT_MAX_CHARS]
    .map((chars) => `${chars}자 ≈ ${minSentenceSec(chars)}초 이상`)
    .join(", ");
  const pacing = [
    text("SCRIPT_PACING_HEAD"),
    immersive ? text("IMMERSIVE_PACING_BEATS") : text("SCRIPT_PACING_BEATS_DEFAULT"),
    immersive ? text("IMMERSIVE_PACING_SPEECH") : text("SCRIPT_PACING_SPEECH_DEFAULT"),
    immersive ? "" : fillSection(text("SCRIPT_PACING_CAPACITY"), { table }),
    text("SCRIPT_PACING_TAIL"),
  ].join(" ");
  // 설명 컷(2026-10-06 R4): INFO 이미지에는 글자가 없다(글자는 앱이 콜아웃으로 그린다). 혼합형은 장면 필드만 받는 별도 절이다.
  const infoRule = input.infoClips
    ? hybrid
      ? text("HYBRID_INFO_RULE")
      : text("SCRIPT_INFO_CLIPS_LEGACY")
    : text("SCRIPT_INFO_CLIPS_NONE");
  // 설득 사슬(사용자 결정 2026-10-06): 영상 1개 = 고통 1개 = 메시지 1개. 문장마다 chainStep 을 적고 코드가 순서·칸·사슬 밖 사실을 검사한다.
  const chainRule = hypothesis.chain ? text("SCRIPT_CHAIN_RULE") : text("SCRIPT_NO_CHAIN_RULE");
  const offerRule = videoOfferAllowed(hypothesis)
    ? text("SCRIPT_OFFER_ALLOWED")
    : text("SCRIPT_OFFER_NONE");
  // 혼합형은 글자 패널을 쓰지 않는다(숫자·목록은 말하고 자막으로만). 다른 정책의 그래픽 절은 그대로다.
  const graphicsRule = hybrid ? text("HYBRID_GRAPHICS_RULE") : text("SCRIPT_GRAPHICS_DEFAULT");
  const contract = hybrid
    ? hybridScriptRules(snapshot)
    : immersive
      ? immersiveScriptRules(snapshot)
      : "";
  // 응답 칸 이름(스키마와 묶임, 코드 고정) + 예시 안내(script.md SCRIPT_SHAPE_EXAMPLE_NOTE) + 장면 계획 예시 문장(examples.md):
  // 콜아웃 word 는 문장의 어절 그대로, text 의 숫자는 문장이 말하고 그 숫자가 컷 화면(자막)에 보인다.
  const shape = `JSON SHAPE: {title, fixedTitle, disclaimer, voicePersona, openLoop, payoffSec, styleAnchor, ${hybrid ? "explainerAnchor, " : ""}subjects[{id, traits}], veoClips[{id, startImagePrompt, prompt, plan{early{camera, action}, mid{…}, late{…}}}], stills[{id, prompt}], ${hybrid ? "infoClips[{id, stage, cleanPrompt, infoPrompt, infoLines[], plan, sceneType, objects[{subjectId, color}], actions[], emphasis[{kind, target, afterAction}]}]" : "infoClips[{id, stage, explanation, cleanPrompt, infoPrompt, graphicOrder[], plan}]"}, sentences[{purpose, chainStep, text, actionSync, callouts[{word, text, kind, anchor, targetId}], cuts[{len, source, screenComposition, onScreenText, effect, veoClip, stillId, graphicKind, graphicLines, goal, phase}]}], flowPrompt, editInstructions}. ${text("SCRIPT_SHAPE_EXAMPLE_NOTE")} ${JSON.stringify(sectionJson(snapshot, "SCENE_PLAN_EXAMPLE_SENTENCE"))}`;
  return [
    fillSection(text("SCRIPT_OPENING"), { seconds }),
    text("SCRIPT_SHAPE"),
    pacing,
    fillSection(text("SCRIPT_SCENES"), {
      maxCutSec,
      explainerCutNote: hybrid ? ` ${text("HYBRID_SCENES_EXPLAINER_NOTE")}` : "",
    }),
    fillSection(text("SCRIPT_SUBJECTS"), {
      hybridSubjectsNote: hybrid ? ` ${text("HYBRID_SUBJECTS_NOTE")}` : "",
    }),
    fillSection(text("SCRIPT_CLEAN_KEYFRAMES"), {
      cleanBaseClause: hybrid
        ? text("HYBRID_CLEAN_BASE_CLAUSE")
        : text("SCRIPT_CLEAN_BASE_DEFAULT"),
    }),
    text("SCRIPT_CLIP_PLAN"),
    text("SCRIPT_CONTINUITY"),
    text("SCRIPT_MATCH_KEY_CONTENT"),
    fillSection(text("SCRIPT_STRUCTURE"), {
      structureHybridNote: hybrid ? text("HYBRID_STRUCTURE_NOTE") : "",
    }),
    chainRule,
    copyRhythmInstruction(immersive, snapshot),
    offerRule,
    text("SCRIPT_VOICE"),
    text("SCRIPT_CAPTIONS"),
    fillSection(text("SCRIPT_CALLOUTS"), {
      calloutsHybridNote: hybrid ? ` ${text("HYBRID_CALLOUTS_NOTE")}` : "",
    }),
    text("SCRIPT_SNAP_ZOOM"),
    text("SCRIPT_LAYOUT"),
    fillSection(text("SCRIPT_SOURCES"), {
      approvedImageRule: hybrid
        ? text("HYBRID_SOURCES_APPROVED_IMAGE")
        : immersive
          ? text("IMMERSIVE_SOURCES_APPROVED_IMAGE")
          : text("SCRIPT_SOURCES_APPROVED_IMAGE_LEGACY"),
      projectClipRule: hasClips
        ? text("SCRIPT_SOURCES_PROJECT_CLIP_YES")
        : text("SCRIPT_SOURCES_PROJECT_CLIP_NO"),
    }),
    text("SCRIPT_VEO"),
    fillSection(text("SCRIPT_CUT_PHASE"), {
      cutPhasePolicyNote: hybrid
        ? text("HYBRID_CUT_PHASE_NOTE")
        : text("SCRIPT_CUT_PHASE_DEFAULT_NOTE"),
    }),
    text("SCRIPT_STILLS"),
    graphicsRule,
    infoRule,
    contract,
    text("SCRIPT_FIELD_HYGIENE"),
    shape,
    text("SCRIPT_REFERENCE_NOTE"),
    JSON.stringify(scriptReferenceExamples(snapshot)),
    `${text("SCRIPT_CLOSING")}${feedback ? `\n${fillSection(text("SCRIPT_FEEDBACK_PREFIX"), { feedback })}` : ""}`,
  ].join("\n");
}
