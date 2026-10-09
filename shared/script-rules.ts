import { EXPLANATORY_TAIL } from "./copy-polish";
import type { CreativePlan, PersuasionChain } from "./creative-plan";
import { explanationScriptProblems } from "./explanation-script-rules";
import { hybridProblems } from "./hybrid-script-rules";
import { immersiveClipReadProblems, immersiveExplanationProblems } from "./immersive-script-rules";
import {
  addsProductDetail,
  CHAIN_ORDER,
  CHAIN_STEP_LABELS,
  chainDigitGroups,
  digitGroups,
  type ScriptChainStep,
  sharesKeyWord,
} from "./persuasion-chain";
import { sceneProblemsV2 } from "./script-rules-v2";
import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";
import {
  alignmentProblems,
  CLIP_PHASE_RANGES_MS,
  calloutWordInText,
  clipPhaseReads,
  clipPlanMissing,
  hypothesisFactTexts,
  INFO_CLIPS_MAX,
  isClipPlanEmpty,
  isExplainerScene,
  isHybrid,
  isInfoClipId,
  maxSentenceSec,
  narrationProblems,
  promptSubjectMention,
  STILL_SHOTS_MAX,
  spokenDigitGroups,
  VEO_CLIP_MS,
  VEO_CLIP_SEC,
  VEO_SHOTS_MAX,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
  type VideoScript,
  videoPolicyOf,
  voiceCutRange,
} from "./video-script";

// 영상 대본 규칙을 hard(거부·다시 생성)와 soft(경고로 받아들임)로 나눈다(2026-10-04).
// 실전 gpt-5-mini 가 3회 모두 거부된 뒤 멈춘 원인 중 하나는 '모든 규칙이 거부'였기 때문이다. 이제 품질을 미세하게 좌우하는
// 발화량·자막·목표 길이 차이는 경고로 남기고 사용자·AI 검토가 본다. 컷 속도와 이야기 순서는 강제하지 않는다.
// 서버 verifyLongVideoScript(거부 래퍼)·VideoScriptService(view/edit/approve)·화면 ScriptEditor 가 같은 함수를 쓴다.
export type ScriptProblems = { readonly hard: string[]; readonly soft: string[] };
export type ScriptExpectation = {
  readonly number: number;
  // 목표 길이(초). 실제 길이(컷 합계)는 30~60초까지 받고 목표와 다른 것은 경고만 남긴다.
  readonly durationSec: number;
  readonly hypothesis: CreativePlan["hypotheses"][number];
  // 업로드된 촬영본이 있어야 project_clip 컷을 쓸 수 있다.
  readonly hasProjectClips?: boolean;
  // 제품 낱말 대조에 쓸 사실 글(자료 본문). 없으면 가설의 인용·신호만 쓴다.
  readonly facts?: readonly string[];
  // 설명 컷(I1~I3)은 Flow 에서 첫·마지막 프레임으로 만들므로 Flow 모드에서만 쓴다. 지정하지 않으면 허용.
  readonly infoClipsAllowed?: boolean;
  // 설득 사슬(광고안 chain)과 타겟 조각의 욕망·고통 글. 사슬 칸이 적힌 대본(chainStep)에만 사슬 규칙을 적용한다.
  readonly chain?: PersuasionChain;
  readonly desireTexts?: readonly string[];
};
// 다음 생성에 전달하는 규칙 위반 수 상한(기본값; 검사는 thresholds() 의 지금 값). 말과 그림 규칙이 더해져 종류가 두 배가 됐으므로 8개로는 어긋남이 잘려 나갔다.
export const VERIFY_FEEDBACK_MAX = DEFAULT_THRESHOLDS.VERIFY_FEEDBACK_MAX;
// 모델에 돌려주는 피드백 문자열: hard(말·그림 → 낱말 순) 뒤에 soft 를 붙이고 상한에서 자른다.
export function scriptFeedback(hard: readonly string[], soft: readonly string[] = []): string {
  const problems = [...hard, ...soft];
  const max = thresholds().VERIFY_FEEDBACK_MAX;
  return `영상 대본 규칙 위반: ${problems.slice(0, max).join(" / ")}${
    problems.length > max ? ` / (외 ${problems.length - max}건 더 있음)` : ""
  }`;
}
// 오퍼 장면은 오퍼 자료가 있는 BOFU 광고안에서만 쓴다(프롬프트와 검사가 같은 판단을 쓴다).
export function videoOfferAllowed(hypothesis: CreativePlan["hypotheses"][number]): boolean {
  return (
    hypothesis.decisionRole === "final_decision" &&
    !!hypothesis.signals &&
    hypothesis.signals.offer.type !== "none"
  );
}
const lineLength = (text: string) => [...text].length;
// 컷 창은 발화 시간과 다르다. 짧은 말 뒤 동작·장면을 볼 여유(임계값 SCENE_HOLD_SEC)를 경고에만 인정한다.
const cutDurationMs = (cut: VideoScript["cuts"][number]) =>
  Math.round(cut.endSec * 1000) - Math.round(cut.startSec * 1000);

// 장면 계획 대본(2026-10-06) 판별: 컷 goal/phase, 클립·설명 컷 plan, 설명 컷 graphicOrder, 문장 callouts, subjects 중 하나라도
// 적혀 있으면 새 대본이다. 전부 기본값인 예전 대본은 새 hard 규칙(veo 컷 phase 필수·컷 5초 상한)을 건너뛴다
// (저장된 실전 대본의 편집·승인을 막지 않기 위해).
export function isScenePlanScript(
  script: Pick<VideoScript, "cuts" | "veoClips" | "infoClips" | "voiceover" | "subjects">,
): boolean {
  return (
    script.cuts.some((cut) => cut.phase !== "" || cut.goal !== "") ||
    script.veoClips.some((clip) => !isClipPlanEmpty(clip.plan)) ||
    script.infoClips.some((clip) => !isClipPlanEmpty(clip.plan) || clip.graphicOrder.length > 0) ||
    script.voiceover.some((voice) => voice.callouts.length > 0) ||
    script.subjects.length > 0
  );
}

// 장면 계획 규칙(R1·R2·R5~R8). classifyScriptProblems 가 부른다. 예전 대본에는 콜아웃·phase 가 없어 대부분 자연히 건너뛴다.
export function scenePlanProblems(script: VideoScript): ScriptProblems {
  const hard: string[] = [
    ...immersiveClipReadProblems(script),
    ...explanationScriptProblems(script),
  ];
  const soft: string[] = [];
  const scenePlan = isScenePlanScript(script);
  const immersive = script.planning?.visualPolicy === "immersive_explanations_v1";
  const maxCutSec = immersive ? VEO_CLIP_SEC : thresholds().CUT_MAX_SEC;
  const LATIN = /[A-Za-z]/;
  // R1 컷 길이 상한, R6 컷의 클립 구간 필수(veo_clip 컷만).
  script.cuts.forEach((cut, index) => {
    const seconds = cutDurationMs(cut) / 1000;
    if (scenePlan && seconds > maxCutSec)
      hard.push(
        `컷 ${index} 길이 ${seconds}초 — ${maxCutSec}초 이하로 나누세요(시각 정보가 바뀌는 지점에서 끊고, 한 문장이 여러 컷에 걸쳐도 됩니다).`,
      );
    if (scenePlan && cut.source === "veo_clip" && cut.phase === "")
      hard.push(
        `컷 ${index}(클립 ${cut.veoClip})에 클립 구간(phase)이 없습니다 — early(0~3초)·mid(3~5.5초)·late(5.5~8초) 중 하나를 적으세요.`,
      );
    if (cut.source !== "veo_clip" && cut.phase !== "")
      hard.push(
        `컷 ${index}은 Veo 클립 컷이 아닌데 클립 구간(phase ${cut.phase})이 있습니다(다른 소스는 빈 문자열).`,
      );
  });
  // R8 스냅 줌: 연속 3컷에 1개 이하, 인접 금지.
  script.cuts.forEach((cut, index) => {
    if (cut.effect !== "zoom_punch") return;
    if (script.cuts[index - 1]?.effect === "zoom_punch")
      soft.push(
        `스냅 줌(zoom_punch)이 컷 ${index - 1}·${index}에 연달아 있습니다. 연속 3컷에 1개 이하로, 붙여 쓰지 마세요.`,
      );
    else if (script.cuts[index - 2]?.effect === "zoom_punch")
      soft.push(
        `스냅 줌(zoom_punch)이 컷 ${index - 2}과 ${index}에 있습니다(연속 3컷에 2개). 연속 3컷에 1개 이하로 쓰세요.`,
      );
  });
  // R7 콜아웃: word 는 문장의 어절, text 는 한글·숫자, text 의 숫자는 그 문장이 말한다.
  script.voiceover.forEach((voice, index) => {
    const spoken = spokenDigitGroups(voice.text);
    voice.callouts.forEach((callout, k) => {
      const where = `${index + 1}번째 문장 콜아웃 ${k + 1}("${callout.text}")`;
      if (!calloutWordInText(callout.word, voice.text))
        hard.push(
          `${where}: word "${callout.word}"가 문장 "${voice.text}"의 어절(공백 기준)에 없습니다. 문장에 그대로 있는 어절을 적으세요.`,
        );
      if (LATIN.test(callout.text))
        hard.push(
          `${where}: 콜아웃 글자에 영문이 있습니다 — 한글·숫자로 적고 단위는 한글(밀리그램·퍼센트)로 쓰세요.`,
        );
      for (const digits of spokenDigitGroups(callout.text))
        if (!spoken.has(digits))
          hard.push(
            `${where}: 콜아웃 숫자 ${digits}를 이 문장이 말하지 않습니다. 문장에 그 숫자를 넣거나 콜아웃에서 빼세요.`,
          );
    });
  });
  // R5 구간 계획: 세 구간 중 일부만 채운 계획은 거부, 장면 계획 대본인데 계획이 통째로 없으면 경고.
  const clips = [
    ...script.veoClips.map((clip) => ({ kind: "Veo 클립", clip })),
    ...script.infoClips.map((clip) => ({ kind: "설명 컷", clip })),
  ];
  for (const { kind, clip } of clips) {
    const missing = clipPlanMissing(clip.plan);
    if (missing.length > 0)
      hard.push(
        `${kind} ${clip.id}의 구간 계획(plan)이 불완전합니다(${missing.join(", ")} 비어 있음). early·mid·late 모두 camera 와 action 을 적으세요.`,
      );
    else if (scenePlan && isClipPlanEmpty(clip.plan))
      soft.push(
        `${kind} ${clip.id}에 구간 계획(plan: early·mid·late 의 camera·action)이 없습니다. 같은 3D 공간에서 카메라가 이어서 움직이는 8초를 계획하세요.`,
      );
  }
  // R4 설명 컷: 그래픽이 생기는 순서(graphicOrder)가 없으면 거부(예전 대본은 infoLines 가 그 역할을 했으므로 둘 다 비었을 때만).
  // 혼합형 설명 장면(sceneType 있음)은 그래픽 대신 동작 순서(actions)를 쓰므로 hybrid 규칙이 본다.
  for (const clip of script.infoClips)
    if (clip.graphicOrder.length === 0 && clip.infoLines.length === 0 && !isExplainerScene(clip))
      hard.push(
        `설명 컷 ${clip.id}에 그래픽이 생기는 순서(graphicOrder, 영어 2~5줄)가 없습니다. CLEAN 사진에서 어떤 그래픽이 어떤 순서로 나타나는지 적으세요.`,
      );
  // R6 구간 읽기: 구간보다 긴 컷은 이웃 구간으로 이어 읽고(경고), 클립 끝을 넘으면 거부. 한 클립의 컷이 모두 같은 구간이면 경고.
  const reads = clipPhaseReads(script.cuts);
  for (const { kind, clip } of clips) {
    const own = reads.filter((read) => read.clipId === clip.id);
    // 총 사용 시간이 이미 8초를 넘으면 기존 8초 규칙(classifyScriptProblems)이 거부하므로 여기서는 겹쳐 적지 않는다.
    const usedMs = script.cuts
      .filter((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    for (const read of own) {
      const [phaseStart] = CLIP_PHASE_RANGES_MS[read.phase];
      if (read.endMs > VEO_CLIP_MS) {
        if (usedMs > VEO_CLIP_MS) continue;
        hard.push(
          `${kind} ${clip.id}의 ${read.phase} 구간 컷 ${read.index}이 클립 끝(${VEO_CLIP_SEC}초)을 넘어 ${read.endMs / 1000}초까지 읽습니다. 컷을 줄이거나 앞 구간으로 옮기세요.`,
        );
      } else if (!immersive && read.endMs > read.phaseEndMs)
        soft.push(
          `컷 ${read.index}이 ${kind} ${clip.id}의 ${read.phase} 구간(${phaseStart / 1000}~${read.phaseEndMs / 1000}초)을 넘어 ${read.endMs / 1000}초까지 이어 읽습니다. 구간 끝의 멈춘 구도가 컷 안에 들어오니 컷을 줄이거나 다음 구간 컷으로 나누세요.`,
        );
    }
    if (!immersive && own.length >= 2 && new Set(own.map((read) => read.phase)).size === 1)
      soft.push(
        `${kind} ${clip.id}의 컷 ${own.map((read) => read.index).join("·")}이 모두 ${own[0]?.phase} 구간만 씁니다. 다른 구간(early·mid·late)도 써서 화면이 바뀌게 하세요.`,
      );
  }
  // R2 대상 ID: 선언했으면 모든 이미지 프롬프트가 등장 대상의 traits 낱말을 자체 포함해야 한다(이름만으로 가리키면 경고).
  if (script.subjects.length > 0) {
    const prompts = [
      ...script.veoClips.map((clip) => ({
        label: `Veo 클립 ${clip.id} 시작 이미지`,
        text: clip.startImagePrompt,
      })),
      ...script.infoClips.map((clip) => ({
        label: `설명 컷 ${clip.id} CLEAN 사진`,
        text: clip.cleanPrompt,
      })),
      ...script.stills.map((still) => ({ label: `정지 이미지 ${still.id}`, text: still.prompt })),
    ];
    for (const prompt of prompts) {
      let mentioned = 0;
      for (const subject of script.subjects) {
        const mention = promptSubjectMention(prompt.text, subject);
        if (mention.id || mention.traits) mentioned++;
        if (mention.id && !mention.traits)
          soft.push(
            `${prompt.label} 프롬프트가 대상 ${subject.id}를 이름으로만 가리킵니다. 외형(traits "${subject.traits}")의 낱말을 프롬프트에 직접 적으세요("같은 인물"처럼 앞 장면 참조만으로는 일관성이 지켜지지 않습니다).`,
          );
      }
      if (mentioned === 0)
        soft.push(
          `${prompt.label} 프롬프트에 선언한 대상(${script.subjects.map((subject) => subject.id).join(", ")})의 traits 낱말이 하나도 없습니다. 등장하는 대상의 외형을 프롬프트 안에 적으세요.`,
        );
    }
  }
  return { hard, soft };
}

// 설득 사슬 대본 규칙(사용자 결정 2026-10-06). 문장마다 적힌 chainStep 으로 검사한다. 예전 대본(chainStep 전부 "")은 건너뛴다.
const META_PHRASES =
  /먼저,?\s|마지막으로|확인해\s?볼게요|살펴볼게요|알아볼게요|보여\s?드릴게요|정리해\s?볼게요/u;
const CTA_FORBIDDEN = /확인|표기|라벨|상세\s?페이지|상세에서/u;
const REASON_CONNECTORS = /(라서|니까|이니까|담아서|때문|거든요|덕분|담았|들어\s?있)/u;
const REQUIREMENT_FORMS = /(려면|야\s?해요|야\s?돼요|야\s?합니다|어야|아야|해야)/u;
export function chainProblems(
  script: VideoScript,
  expected: Pick<ScriptExpectation, "chain" | "desireTexts" | "hypothesis">,
): ScriptProblems {
  const hard: string[] = [];
  const soft: string[] = [];
  // 광고안에 사슬이 없거나(예전 기획) 대본에 칸이 적히지 않았으면(예전 대본) 검사하지 않는다.
  if (!expected.chain || script.voiceover.every((voice) => voice.chainStep === ""))
    return { hard, soft };
  const label = (step: string) => CHAIN_STEP_LABELS[step as ScriptChainStep] ?? step;
  const at = (index: number, voice: VideoScript["voiceover"][number]) =>
    `${index + 1}번째 문장(${label(voice.chainStep)}) "${voice.text}"`;
  const steps = script.voiceover
    .map((voice, index) => ({ voice, index, step: voice.chainStep }))
    .filter(
      (
        item,
      ): item is {
        voice: VideoScript["voiceover"][number];
        index: number;
        step: ScriptChainStep;
      } => item.step !== "" && item.step !== "bridge",
    );
  // 1. 순서: pain → … → outcome → cta. 같은 칸이 여러 문장이어도 된다.
  let last = -1;
  for (const item of steps) {
    const position = CHAIN_ORDER.indexOf(item.step);
    if (position < last)
      hard.push(
        `${at(item.index, item.voice)}이 사슬 순서를 거슬렀습니다. 순서는 고통 → 믿는 원인 → 진짜 원인 → 해결 조건 → 우리 상품의 사실 → 가능한 이유 → 결과 → 행동입니다.`,
      );
    last = Math.max(last, position);
  }
  // 2. 필수 칸(믿는 원인만 생략 가능).
  const present = new Set(steps.map((item) => item.step));
  for (const step of CHAIN_ORDER)
    if (step !== "believed_cause" && !present.has(step))
      hard.push(`사슬의 ${label(step)} 문장이 없습니다. 모든 칸을 한 문장 이상 말해야 합니다.`);
  // 3. 첫 사슬 문장은 고통, 마지막은 행동.
  if (steps[0] && steps[0].step !== "pain")
    hard.push(`첫 문장은 고통(①)이어야 합니다. 지금은 ${label(steps[0].step)}입니다.`);
  const lastStep = steps.at(-1);
  if (lastStep && lastStep.step !== "cta") hard.push("마지막 문장은 행동이어야 합니다.");
  // 4. ⑤ 바로 뒤에 ⑥: 이유가 사실에서 떨어지면 안 된다.
  const factIndexes = steps
    .filter((item) => item.step === "product_fact")
    .map((item) => item.index);
  const reasonIndexes = steps
    .filter((item) => item.step === "reason_why")
    .map((item) => item.index);
  const lastFact = factIndexes.at(-1);
  const firstReason = reasonIndexes[0];
  if (lastFact !== undefined && firstReason !== undefined && firstReason !== lastFact + 1)
    hard.push(
      "가능한 이유(⑥) 문장은 우리 상품의 사실(⑤) 바로 다음 문장이어야 합니다(왜냐하면 자리).",
    );
  for (const item of steps) {
    const text = item.voice.text;
    // 5. 설명서·진행 멘트 금지.
    if (META_PHRASES.test(text))
      hard.push(
        `${at(item.index, item.voice)}에 진행·설명서 멘트가 있습니다. 고객에게 말하듯 쓰세요.`,
      );
    if (item.step === "cta") {
      // 6. 행동 문장: 검증 낱말·숫자 금지, 동사는 결정 단계에 맞춘다.
      if (CTA_FORBIDDEN.test(text))
        hard.push(
          `${at(item.index, item.voice)}: 행동 문장에 확인·표기·라벨·상세페이지를 쓰지 않습니다. 검증은 ⑥ 컷의 화면이 합니다. 결정 단계에 맞는 동사 하나로 끝내세요(처음 알게 하는 영상은 알아보기, 비교 단계는 비교해 보기, 구매 단계는 지금 받기).`,
        );
      if (/\d/.test(text))
        hard.push(`${at(item.index, item.voice)}: 행동 문장에는 숫자를 넣지 않습니다.`);
    }
    if (item.step === "reason_why" && !REASON_CONNECTORS.test(text))
      soft.push(
        `${at(item.index, item.voice)}: 가능한 이유(⑥)는 ⑤ 다음의 짧은 문장에서 "~거든요/~담았어요/~라서요"처럼 이유를 말하세요.`,
      );
    if (item.step === "requirement" && !REQUIREMENT_FORMS.test(text))
      soft.push(
        `${at(item.index, item.voice)}: 해결 조건(④)은 "~하려면 ~해야 해요"처럼 조건문으로 쓰세요.`,
      );
    // 8. 결과·변화는 고객이 말한 욕망·고통의 낱말을 되받는다.
    if (
      item.step === "outcome" &&
      expected.desireTexts &&
      expected.desireTexts.length > 0 &&
      !expected.desireTexts.some((reference) => sharesKeyWord(text, reference))
    )
      hard.push(
        `${at(item.index, item.voice)}: 결과·변화 문장이 고객이 말한 욕망·고통의 낱말을 되받지 않습니다. 지어낸 감정 대신 고객의 말이 이루어진 모습을 쓰세요.`,
      );
  }
  // 6b. ⑥은 ⑤를 되풀이하지 않는다: ⑤ 문장에 없는 제품 고유 세부(숫자·함량·원재료·공정·제조사)가 하나 이상.
  const factText = steps
    .filter((item) => item.step === "product_fact")
    .map((item) => item.voice.text)
    .join(" ");
  const reasonText = steps
    .filter((item) => item.step === "reason_why")
    .map((item) => item.voice.text)
    .join(" ");
  if (reasonText && !addsProductDetail(reasonText, factText))
    hard.push(
      "가능한 이유(⑥) 문장이 우리 상품의 사실(⑤)을 되풀이합니다. ⑥에는 ⑤에 없는 제품 고유 세부(한 알의 함량·원재료 100%·냉압착·제조사 같은 사슬 안의 숫자·낱말)를 말하세요.",
    );
  // 7. 사슬 밖 사실 금지(연결 문장 포함): 내레이션의 숫자는 사슬 칸 글에 있는 것만.
  if (expected.chain) {
    const allowed = chainDigitGroups(expected.chain);
    script.voiceover.forEach((voice, index) => {
      if (voice.chainStep === "") return;
      for (const value of digitGroups(voice.text))
        if (!allowed.has(value))
          hard.push(
            `${at(index, voice)}에 사슬 밖 숫자 ${value}가 있습니다. 이 영상의 메시지는 하나입니다. 사슬에 없는 사실은 다른 영상에서 쓰세요.`,
          );
    });
  }
  // 9. 원인과 해결(③~⑥)이 전체 글자 수의 절반 이상.
  const total = script.voiceover.reduce((sum, voice) => sum + [...voice.text].length, 0);
  const core = steps
    .filter((item) =>
      ["real_cause", "requirement", "product_fact", "reason_why"].includes(item.step),
    )
    .reduce((sum, item) => sum + [...item.voice.text].length, 0);
  if (total > 0 && core < total / 2)
    soft.push(
      `원인과 해결(③~⑥)이 내레이션의 ${Math.round((core / total) * 100)}%입니다. 고통보다 해결 과정을 길게(절반 이상) 말하세요.`,
    );
  return { hard, soft };
}

export function classifyScriptProblems(
  script: VideoScript,
  expected: ScriptExpectation,
): ScriptProblems {
  // 카피 먼저 흐름(2026-10-08): 새 대본은 규칙 20개(script-rules-v2)만 본다. 예전 흐름("")은 아래 규칙 그대로(픽스처·옛 정책용).
  if (script.flow === "copy_first") return sceneProblemsV2(script, expected);
  const { hypothesis } = expected;
  // 숫자 임계값은 호출 때 읽는다(서버·화면이 instructions/thresholds.json 값을 주입한다).
  const limits = thresholds();
  const hard: string[] = [];
  const soft: string[] = [];
  const fail = (message: string) => {
    if (!hard.includes(message)) hard.push(message);
  };
  const warn = (message: string) => {
    if (!soft.includes(message)) soft.push(message);
  };
  if (script.number !== expected.number || script.hypothesisId !== hypothesis.id)
    fail(`number는 ${expected.number}, hypothesisId는 ${hypothesis.id}여야 합니다.`);
  // 길이: 컷 합계가 30~60초면 받는다. 목표와 다른 것은 경고.
  const [shortest, longest] = [VIDEO_MIN_SEC, VIDEO_MAX_SEC];
  const durationTarget = script.planning?.durationSec ?? expected.durationSec;
  if (script.durationSec < shortest || script.durationSec > longest)
    fail(
      `길이 ${script.durationSec}초는 허용 범위 ${shortest}~${longest}초 밖입니다(목표 ${expected.durationSec}초). 문장을 더하거나 빼세요.`,
    );
  else if (script.durationSec !== durationTarget)
    warn(`목표 ${durationTarget}초, 실제 ${script.durationSec}초입니다.`);
  // 컷 시간 연속성·마지막 컷 = durationSec: 중첩 응답에서는 구조상 성립(내부 단언).
  let end = 0;
  for (const cut of script.cuts) {
    if (cut.startSec !== end || cut.endSec <= cut.startSec) {
      fail(`컷 시간이 이어지지 않습니다(${end}초 다음 컷이 ${cut.startSec}~${cut.endSec}초).`);
      break;
    }
    end = cut.endSec;
  }
  if (end !== script.durationSec)
    fail(`마지막 컷이 ${end}초에 끝납니다. 0초부터 ${script.durationSec}초까지 채워야 합니다.`);
  // 대표 이미지 컷은 예전 정책만 요구한다(immersive 는 2026-10-06, hybrid 는 2026-10-07 부터 엔딩 카드를 강제하지 않는다).
  if (
    videoPolicyOf(script) === "legacy" &&
    !script.cuts.some((cut) => cut.source === "approved_image")
  )
    fail("대표 이미지(approved_image) 컷이 하나 이상 필요합니다.");
  for (const cut of script.cuts) {
    const lines = cut.onScreenText ? cut.onScreenText.split("\n") : [];
    if (
      lines.length > 1 ||
      lines.some((item) => lineLength(item.trim()) > limits.CAPTION_LINE_MAX_CHARS)
    )
      warn(
        `자막은 1줄, 한 줄 ${limits.CAPTION_LINE_MAX_CHARS}자 이내여야 합니다(${cut.startSec}초).`,
      );
    if ((cut.source === "veo_clip") !== cut.veoClip.length > 0)
      fail("Veo 클립 컷만 선언한 클립(veoClips 의 id)을 가리켜야 합니다.");
    if (
      cut.source === "veo_clip" &&
      !script.veoClips.some((clip) => clip.id === cut.veoClip) &&
      !script.infoClips.some((clip) => clip.id === cut.veoClip)
    )
      fail(`${cut.startSec}초 컷이 선언하지 않은 클립 ${cut.veoClip}을 가리킵니다.`);
    if ((cut.source === "still_image") !== cut.stillId.length > 0)
      fail(
        "정지 이미지 컷만 선언한 정지 이미지(stills 의 id)를 가리켜야 합니다(다른 소스는 빈 문자열).",
      );
    if (cut.source === "still_image" && !script.stills.some((still) => still.id === cut.stillId))
      fail(`${cut.startSec}초 컷이 선언하지 않은 정지 이미지 ${cut.stillId}을 가리킵니다.`);
    if ((cut.source === "motion_graphic") !== cut.graphicKind.length > 0)
      fail("모션그래픽 컷만 graphicKind 를 정합니다(다른 소스는 빈 문자열).");
    if (cut.source === "motion_graphic" && cut.graphicLines.length === 0)
      fail(
        `${cut.startSec}초 모션그래픽 컷에 보여줄 글줄(graphicLines)이 없습니다(자막도 없어 채우지 못했습니다).`,
      );
    if (cut.source !== "motion_graphic" && cut.graphicLines.length > 0)
      fail(`${cut.startSec}초 컷은 모션그래픽이 아닌데 graphicLines 가 있습니다.`);
    if (cut.source === "card_slide" && hypothesis.cardSlides.length === 0)
      fail("카드뉴스가 없는 광고안에서 카드 장면을 쓸 수 없습니다.");
    if (cut.source === "project_clip" && !expected.hasProjectClips)
      fail("업로드된 촬영본이 없어 project_clip 을 쓸 수 없습니다.");
  }
  for (let index = 2; index < script.cuts.length; index++) {
    const effects = script.cuts.slice(index - 2, index + 1).map((cut) => cut.effect);
    if (effects[0] !== "hard_cut" && effects.every((effect) => effect === effects[0]))
      warn(`같은 효과(${effects[0]})가 3번 연속입니다(${script.cuts[index]?.startSec}초).`);
  }
  if (!script.openLoop) warn("후킹에서 던질 궁금증(openLoop)이 없습니다.");
  if (script.payoffSec >= script.durationSec)
    warn("궁금증의 답(payoffSec)은 영상 시간 안에 있어야 합니다.");
  const naturalPace = script.planning?.visualPolicy === "immersive_explanations_v1";
  const minChars = Math.ceil(
    script.durationSec * (naturalPace ? 6 : limits.NARRATION_MIN_CHARS_PER_SEC),
  );
  const maxChars = Math.floor(script.durationSec * limits.NARRATION_MAX_CHARS_PER_SEC);
  if (script.voiceover.length === 0) fail("음성 트랙(voiceover)이 없습니다.");
  // 컷에 묶인 대본(fromCut ≥ 0)은 말 없는 구간·문장 길이를 alignmentProblems 가 컷 기준으로 검사한다.
  // 아래 시간 기준 검사(3초 공백·창 글자 수 +6)는 컷 범위가 없던 예전 대본에만 적용한다.
  const bound = script.voiceover.some((voice) => voice.fromCut >= 0);
  let voiceEnd = 0;
  for (const voice of script.voiceover) {
    const window = voice.endSec - voice.startSec;
    if (voice.startSec < voiceEnd || window <= 0 || voice.endSec > script.durationSec) {
      fail(`음성 문장 시간이 겹치거나 범위를 벗어납니다(${voice.startSec}~${voice.endSec}초).`);
      break;
    }
    if (!bound) {
      if (voice.startSec - voiceEnd > 3)
        warn(`${voiceEnd}~${voice.startSec}초에 말이 3초 넘게 비어 있습니다.`);
      const limit = Math.floor(window * limits.NARRATION_MAX_CHARS_PER_SEC) + 6;
      if (lineLength(voice.text) > limit)
        warn(
          `${voice.startSec}~${voice.endSec}초 문장이 ${lineLength(voice.text)}자로 깁니다(${limit}자 이하로 줄이거나 시간을 늘리세요).`,
        );
    }
    voiceEnd = voice.endSec;
  }
  if (!bound && script.voiceover.length > 0 && script.durationSec - voiceEnd > 3)
    warn(`${voiceEnd}초 이후 말이 3초 넘게 비어 있습니다.`);
  // 말과 그림 일치(컷에 묶인 문장): 범위·순서·말한 숫자. 낱말 규칙보다 먼저 모은다.
  if (bound) {
    for (const problem of alignmentProblems(script, [
      ...hypothesisFactTexts(hypothesis),
      ...(expected.facts ?? []),
    ]))
      fail(problem);
    for (const problem of alignmentProblems(
      script,
      [...hypothesisFactTexts(hypothesis), ...(expected.facts ?? [])],
      "soft",
    ))
      warn(problem);
    // 발화 추정 + 장면 여유를 넘는 빈 구간만 경고한다. 컷·음성 시간과 실제 합성 검사는 그대로다.
    script.voiceover.forEach((voice, index) => {
      const range = voice.fromCut >= 0 ? voiceCutRange(voice, script.cuts) : null;
      const first = range ? script.cuts[range[0]] : undefined;
      const lastCut = range ? script.cuts[range[1]] : undefined;
      if (!first || !lastCut) return;
      const seconds = lastCut.endSec - first.startSec;
      const chars = lineLength(voice.text);
      const speechSec = naturalPace ? chars / 6 : maxSentenceSec(chars);
      if (seconds > speechSec + limits.SCENE_HOLD_SEC)
        warn(
          `${index + 1}번째 문장 "${voice.text}"(${chars}자)이 ${seconds}초에 걸쳐 비는 시간이 깁니다(발화 추정 ${Math.round(speechSec * 10) / 10}초 + 장면 여유 ${limits.SCENE_HOLD_SEC}초). 문장 내용을 늘리기 전에 동작·장면에 필요한 여유인지 검토하세요.`,
        );
    });
  }
  for (const problem of narrationProblems(script.voiceover, script.voicePersona)) fail(problem);
  const chain = chainProblems(script, expected);
  for (const problem of chain.hard) fail(problem);
  for (const problem of chain.soft) warn(problem);
  for (const problem of immersiveExplanationProblems(script, expected.infoClipsAllowed))
    fail(problem);
  const scene = scenePlanProblems(script);
  for (const problem of scene.hard) fail(problem);
  for (const problem of scene.soft) warn(problem);
  // 혼합형(2026-10-07): 비트별 소스·설명 장면·실사 프롬프트·엔딩. 혼합형이 아니면 빈 결과.
  const hybrid = hybridProblems(script);
  for (const problem of hybrid.hard) fail(problem);
  for (const problem of hybrid.soft) warn(problem);
  // 카피 리듬(2026-10-06): 한 문장 = 한 호흡. COPY_BEAT_MAX_CHARS(기본 40) 넘으면 거부, COPY_BEAT_TARGET_CHARS(기본 26) 넘으면 경고, 설명 꼬리는 경고.
  script.voiceover.forEach((voice, index) => {
    const chars = lineLength(voice.text);
    if (chars > limits.COPY_BEAT_MAX_CHARS)
      fail(
        `${index + 1}번째 문장 "${voice.text}"이 ${chars}자입니다. 한 문장은 한 호흡(${limits.COPY_BEAT_MAX_CHARS}자 이내)이어야 합니다. 상황·반전·감정을 따로 끊으세요.`,
      );
    else if (!naturalPace && chars > limits.COPY_BEAT_TARGET_CHARS)
      warn(
        `${index + 1}번째 문장 "${voice.text}"이 ${chars}자라 호흡이 깁니다(${limits.COPY_BEAT_TARGET_CHARS}자 안이 목표). 두 문장으로 끊으세요.`,
      );
    if (EXPLANATORY_TAIL.test(voice.text))
      warn(
        `${index + 1}번째 문장 "${voice.text}"의 끝이 설명 꼬리입니다. "~예요/~죠/~세요"로 짧게 끝내세요.`,
      );
  });
  const narration = script.cuts.reduce((sum, cut) => sum + lineLength(cut.narration), 0);
  // 모든 문장이 컷에 묶였으면 위의 문장별 빈 구간 검사가 총량 하한을 대신한다.
  // 영상 전체를 발화 시간으로 계산하면 자연스러운 장면 여유마다 긴 문장을 요구하게 된다.
  if (
    (script.voiceover.some((voice) => voice.fromCut < 0) && narration < minChars) ||
    narration > maxChars
  )
    warn(
      `내레이션 총량이 ${narration}자입니다. ${script.durationSec}초 분량은 ${minChars}~${maxChars}자입니다.`,
    );
  if (!videoOfferAllowed(hypothesis) && script.cuts.some((cut) => cut.purpose === "offer"))
    fail("오퍼 장면은 오퍼 자료가 있는 BOFU 광고안에서만 씁니다(이 광고안은 offer 금지).");
  if (script.veoClips.length > VEO_SHOTS_MAX)
    fail(
      `Veo 클립은 영상 1편에 ${VEO_SHOTS_MAX}개까지입니다. 움직임이 설득력인 실사 컷에만 쓰고 나머지는 정지 이미지로 바꾸세요.`,
    );
  if (script.stills.length > STILL_SHOTS_MAX)
    fail(`정지 이미지는 영상 1편에 ${STILL_SHOTS_MAX}장까지입니다.`);
  if (script.infoClips.length > INFO_CLIPS_MAX)
    fail(`설명 컷은 영상 1편에 ${INFO_CLIPS_MAX}개까지입니다.`);
  if (script.infoClips.length > 0 && expected.infoClipsAllowed === false)
    fail(
      "설명 컷(I1~I3)은 Google Flow 모드에서만 만들 수 있습니다. 정지 이미지나 모션그래픽으로 바꾸세요.",
    );
  if (script.veoClips.some((clip) => isInfoClipId(clip.id)))
    fail("veoClips 에는 A~D 만 선언하고 설명 컷은 infoClips 에 선언하세요.");
  const factNumbers = new Set(
    (expected.facts ?? [])
      .join(" ")
      .match(/\d+(?:[.,]\d+)*/g)
      ?.map((value) => value.replaceAll(",", "")),
  );
  for (const clip of script.infoClips) {
    const usedMs = script.cuts
      .filter((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    if (usedMs === 0) warn(`선언한 설명 컷 ${clip.id}를 쓰는 컷이 없습니다.`);
    if (usedMs > VEO_CLIP_SEC * 1000)
      fail(
        `설명 컷 ${clip.id}에서 ${usedMs / 1000}초를 씁니다. 한 클립은 ${VEO_CLIP_SEC}초뿐입니다.`,
      );
    if (expected.facts)
      for (const value of clip.infoLines.join(" ").match(/\d+(?:[.,]\d+)*/g) ?? [])
        if (!factNumbers.has(value.replaceAll(",", "")))
          fail(
            `설명 컷 ${clip.id}의 글자에 제품 자료에 없는 숫자 ${value}가 있습니다. 숫자는 자료 그대로만 쓰세요.`,
          );
    // 혼합형 설명 장면(2026-10-08): 자료에 숫자가 있는데 INFO 문구에 숫자가 하나도 없으면 경고(인포그래픽은 숫자로 보여 준다).
    if (
      expected.facts &&
      isExplainerScene(clip) &&
      clip.infoLines.length > 0 &&
      factNumbers.size > 0 &&
      !clip.infoLines.some((text) => /\d/u.test(text))
    )
      warn(
        `설명 컷 ${clip.id}의 INFO 문구에 숫자가 없습니다. 자료에 있는 숫자(비율·용량)를 하나는 인포그래픽으로 보여 주세요.`,
      );
  }
  for (const [kind, ids] of [
    ["Veo 클립", script.veoClips.map((clip) => clip.id)],
    ["설명 컷", script.infoClips.map((clip) => clip.id)],
    ["정지 이미지", script.stills.map((still) => still.id)],
  ] as const)
    if (new Set(ids).size !== ids.length) fail(`${kind} ID가 중복 선언됐습니다.`);
  if ((script.veoClips.length > 0 || script.stills.length > 0) && !script.styleAnchor)
    fail("시작 이미지·정지 이미지들이 공유할 시각 기준(styleAnchor)이 없습니다.");
  // 클립 하나는 8초뿐이다. 그보다 많이 잘라 쓰면 같은 화면이 반복된다(같은 원본의 총 사용 시간).
  for (const clip of script.veoClips) {
    const usedMs = script.cuts
      .filter((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    if (usedMs === 0) warn(`선언한 Veo 클립 ${clip.id}를 쓰는 컷이 없습니다.`);
    if (usedMs > VEO_CLIP_SEC * 1000)
      fail(
        `Veo 클립 ${clip.id}에서 ${usedMs / 1000}초를 잘라 씁니다. 한 클립은 ${VEO_CLIP_SEC}초뿐이니 장면이 바뀌면 새 클립을 선언하거나, 그 위의 문장을 줄이세요.`,
      );
  }
  for (const still of script.stills) {
    const usedMs = script.cuts
      .filter((cut) => cut.source === "still_image" && cut.stillId === still.id)
      .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
    if (usedMs === 0) warn(`선언한 정지 이미지 ${still.id}를 쓰는 컷이 없습니다.`);
    if (usedMs > limits.STILL_MAX_SEC * 1000)
      warn(
        `정지 이미지 ${still.id}을 총 ${usedMs / 1000}초 사용합니다. 정지 화면의 유지 시간과 반복 노출을 기획 검토에 참고하세요.`,
      );
  }
  // 설명 컷(I1~I3)은 실사 움직임 예산(50%)에 넣지 않는다.
  // 혼합형(2026-10-08 실측 bde224da): Flow 클립은 초가 아니라 클립 단위로 과금되고 사용자는 정지 사진(어제 49%)보다 실사 움직임을
  // 원하므로 실사 Veo 50% 상한을 두지 않는다 — 정지 합계·③④ 정지·설명 비중은 hybrid 규칙이 본다. 예전·immersive 대본은 그대로.
  const veoMs = script.cuts
    .filter((cut) => cut.source === "veo_clip" && !isInfoClipId(cut.veoClip))
    .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
  if (!isHybrid(script) && veoMs > Math.round(script.durationSec * 1000) * limits.VEO_MAX_RATIO)
    fail(
      `Veo 클립 컷이 ${veoMs / 1000}초로 전체의 ${Math.round(limits.VEO_MAX_RATIO * 100)}%를 넘습니다. 움직임이 필요 없는 분위기·상황·장소 컷은 정지 이미지(still_image)로 바꾸세요.`,
    );
  const graphicMs = script.cuts
    .filter((cut) => cut.source === "motion_graphic")
    .reduce((sum, cut) => sum + cutDurationMs(cut), 0);
  const usesStructuredExplanation =
    naturalPace &&
    script.infoClips.some(
      (clip) =>
        clip.explanation &&
        script.cuts.some((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id),
    );
  if (
    !usesStructuredExplanation &&
    graphicMs > Math.round(script.durationSec * 1000) * limits.MOTION_GRAPHIC_MAX_RATIO
  )
    fail(
      `모션그래픽이 ${graphicMs / 1000}초로 전체의 ${Math.round(limits.MOTION_GRAPHIC_MAX_RATIO * 100)}%를 넘습니다. 실사 장면(Veo 클립) 또는 정지 이미지로 바꾸세요.`,
    );
  return { hard, soft };
}
