import type { ScriptChainStep } from "./persuasion-chain";
import type { ScriptProblems } from "./script-rules";
import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";
import type { VideoPlanning } from "./video-planning";
import {
  CLIP_PHASE_RANGES_MS,
  clipPhaseReads,
  type InfoClip,
  isClipPhaseId,
  isExplainerScene,
  isHybrid,
  isInfoClipId,
  type VideoScript,
  voiceCutRange,
} from "./video-script";

// 혼합형 정책(hybrid_explainer_v1, 사용자 결정 2026-10-07) 대본 규칙. 어제 완성본(8e3aeb37)은 11컷 중 7컷이 글자만 있는
// 빈 패널이었고 사람·상황·제품이 없었다. 그래서 고통·상황·결과·행동 비트는 실사(사람 등장)로, 메커니즘·기능·비교 비트만
// 3D 설명 세계(I1~I3)로 간다. 설명 세계의 문법은 레퍼런스(신비한 건축사전)에서 가져온다: 물체가 있는 3D 장면, 글자는 자막뿐,
// 강조는 네 가지(색 구분·외곽선·발광선·반투명 비유)만, 메커니즘은 과정 애니메이션, 비교는 두 모형 나란히 색으로 구분.
// classifyScriptProblems 가 isHybrid 로 분기해 부르므로 예전·immersive 대본에는 아무 영향이 없다.
// 실사 비트: pain/believed_cause/outcome/cta 문장의 컷은 실사만. 설명 허용 비트: real_cause/requirement/product_fact/reason_why.
export const HYBRID_LIVE_ONLY_STEPS: readonly ScriptChainStep[] = [
  "pain",
  "believed_cause",
  "outcome",
  "cta",
];
export const HYBRID_EXPLAINER_STEPS: readonly ScriptChainStep[] = [
  "real_cause",
  "requirement",
  "product_fact",
  "reason_why",
];
// 설득 사슬이 없는 가설(예전 기획)에서는 프롬프트가 모든 문장을 bridge 로 적게 하므로(server/script-instructions.ts CHAIN)
// chainStep 만 보면 고통·결과 문장이 설명 컷 위에 와도 걸리지 않는다(검토 지적 2026-10-07). 대본 전체에 사슬 칸이 하나도 없으면
// 문장 purpose 로 같은 판정을 한다: 후킹·고통·이야기·혜택·행동(그리고 예전 problem·solution)은 실사만, 메커니즘·신뢰는 설명 또는 실사.
type Purpose = VideoScript["voiceover"][number]["purpose"];
export const HYBRID_LIVE_ONLY_PURPOSES: readonly Purpose[] = [
  "hook",
  "pain",
  "story",
  "offer",
  "cta",
  "problem",
  "solution",
];
export const HYBRID_EXPLAINER_PURPOSES: readonly Purpose[] = ["mechanism", "proof"];
// 실사 쪽 프롬프트(styleAnchor·시작 이미지·정지 이미지·Veo 동작)에 사람·제품·사진 금지 문구가 들어가면 실사 세계가 사라진다(H3).
// "no people" 꼴 외에 "without people"·"people-free"·"unpopulated"·"empty of people" 도 잡는다.
export const LIVE_PROMPT_FORBIDDEN =
  /\b(?:no|without|empty\s+of|free\s+of)\s+(?:any\s+)?(?:people|persons?|humans?|products?|packaging|photo(?:graph)?s?)\b|\b(?:people|person|human|product)-free\b|\bunpopulated\b/iu;
// 설명 세계 기준(explainerAnchor)에는 거꾸로 사람·글자 금지가 들어 있어야 한다(soft).
const EXPLAINER_ANCHOR_NO_PEOPLE =
  /\b(?:no|without)\s+(?:any\s+)?(?:people|persons?|humans?|hands|characters|figures)\b/iu;
const EXPLAINER_ANCHOR_NO_TEXT =
  /\b(?:no|without)\s+(?:any\s+)?(?:text|letters|words|labels|typography)\b/iu;
// 브랜드 강조색 2개(R8): explainerAnchor 가 색 이름을 둘 이상 적어야 INFO·영상 프롬프트의 "first/second brand accent color" 가 뜻을 가진다.
// 바탕(흰색·클레이)은 세지 않는다.
const COLOR_WORDS =
  /\b(olive|gold|golden|green|blue|navy|red|amber|teal|orange|yellow|purple|violet|coral|cream|ivory|brown|black|pink|crimson|emerald|mint|beige|bronze|copper|silver|gr[ae]y|turquoise|magenta|maroon|burgundy|lime|indigo|cobalt|terracotta|rust|ochre|sage|peach|salmon|charcoal)\b/giu;
export function explainerAnchorColorCount(anchor: string): number {
  const found = new Set<string>();
  for (const match of anchor.matchAll(COLOR_WORDS))
    found.add(
      (match[1] ?? "")
        .toLowerCase()
        .replace(/^golden$/u, "gold")
        .replace(/^grey$/u, "gray"),
    );
  return found.size;
}
// 실사 컷에 사람·제품이 보이는지 보는 낱말(soft). 화면 구도·목표·클립 계획의 동작·정지 이미지 프롬프트를 함께 본다.
export const PERSON_WORDS =
  /\b(?:woman|women|man|men|person|people|she|he|her|his|hand|hands|palm|fingers?|face|girl|boy|mother|father|mom|dad|customer|worker|child|kid|lady|guy|someone|herself|himself)\b|사람|여자|남자|여성|남성|손|얼굴|그녀|아이|엄마|아빠|직장인|주부|학생|고객|할머니|할아버지|가족|친구|남편|아내|부모/iu;
export const PRODUCT_WORDS =
  /\b(?:product|bottle|capsules?|package|packaging|jar|pouch|box|tube|pack|sachet|stick|ampoule|cream|oil|supplement|tablets?|pills?|hand|hands|palm)\b|제품|병|캡슐|포장|용기|박스|상자|파우치|튜브|봉지|알약|정제|스틱|앰플|크림|오일|손/iu;
// 엔딩(H8): 마지막 2~3초는 실사 + 제품. 승인 이미지를 쓰면 3초까지(기본값; 검사는 thresholds().HYBRID_ENDING_IMAGE_MAX_SEC).
export const HYBRID_ENDING_IMAGE_MAX_SEC = DEFAULT_THRESHOLDS.HYBRID_ENDING_IMAGE_MAX_SEC;
// R9 한 단계만: 설명 컷의 읽기가 자기 단계 끝을 이 값(= 조립의 보유 EXPLAINER_HOLD_MS, 한 임계값) 넘게 이어지면 거부한다.
export const EXPLAINER_PHASE_SLACK_MS = DEFAULT_THRESHOLDS.EXPLAINER_HOLD_MS;

type Cut = VideoScript["cuts"][number];
const cutSeconds = (cut: Cut) =>
  (Math.round(cut.endSec * 1000) - Math.round(cut.startSec * 1000)) / 1000;
// 설명 컷: I1~I3 를 읽는 veo_clip 컷.
export function isExplainerCut(cut: Pick<Cut, "source" | "veoClip">): boolean {
  return cut.source === "veo_clip" && isInfoClipId(cut.veoClip);
}
// 실사 컷: 사람·상황이 보이는 소스(A~H 클립·정지 이미지·촬영본) 또는 승인 제품 이미지. 카드뉴스·모션그래픽·설명 컷은 아니다.
export function isLiveCut(cut: Pick<Cut, "source" | "veoClip">): boolean {
  switch (cut.source) {
    case "veo_clip":
      return !isInfoClipId(cut.veoClip);
    case "still_image":
    case "project_clip":
    case "approved_image":
      return true;
    default:
      return false;
  }
}
// 사람·상황이 보이는 실사 컷: 승인 제품 이미지(광고 카드)는 뺀다. 첫 컷과 고통·믿는 원인·결과 문장이 요구한다(H2).
export function isLiveSceneCut(cut: Pick<Cut, "source" | "veoClip">): boolean {
  return isLiveCut(cut) && cut.source !== "approved_image";
}
const SOURCE_LABELS: Record<Cut["source"], string> = {
  approved_image: "대표 이미지",
  card_slide: "카드뉴스",
  veo_clip: "Veo 클립",
  project_clip: "촬영본",
  motion_graphic: "모션그래픽",
  still_image: "정지 이미지",
};
function cutLabel(cut: Cut, index: number): string {
  const source = cut.source === "veo_clip" ? `${cut.veoClip} 클립` : SOURCE_LABELS[cut.source];
  return `컷 ${index}(${source}, ${cut.startSec}~${cut.endSec}초)`;
}
// 컷이 보여 주는 것을 적은 글 전부: 화면 구도·목표 + (Veo 컷) 그 클립의 동작 프롬프트와 해당 단계 계획 + (정지 이미지) 프롬프트.
function cutDescription(cut: Cut, script: VideoScript): string {
  const parts = [cut.screenComposition, cut.goal];
  if (cut.source === "veo_clip") {
    const clip = script.veoClips.find((item) => item.id === cut.veoClip);
    if (clip) {
      parts.push(clip.prompt, clip.startImagePrompt);
      if (isClipPhaseId(cut.phase)) {
        const part = clip.plan[cut.phase];
        parts.push(part.camera, part.action);
      } else for (const part of Object.values(clip.plan)) parts.push(part.camera, part.action);
    }
  } else if (cut.source === "still_image")
    parts.push(script.stills.find((still) => still.id === cut.stillId)?.prompt ?? "");
  return parts.join(" ");
}

// 설명 장면 자체의 규칙(H4): 장면 종류·물체·동작·강조. 물체는 subjects 의 ID 를 쓰고 같은 ID 의 색은 영상 전체에서 고정이다.
export function explainerSceneProblems(
  infoClips: readonly InfoClip[],
  subjects: readonly { readonly id: string }[],
): ScriptProblems {
  const hard: string[] = [];
  const soft: string[] = [];
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const colorOf = new Map<string, { readonly color: string; readonly clipId: string }>();
  for (const clip of infoClips) {
    const where = `설명 장면 ${clip.id}`;
    if (!isExplainerScene(clip)) {
      hard.push(
        `${where}에 장면 종류(sceneType: process·comparison·analogy)가 없습니다. 혼합형 설명 컷은 물체가 있는 3D 장면으로 적으세요.`,
      );
      continue;
    }
    if (clip.objects.length === 0)
      hard.push(
        `${where}에 물체(objects)가 없습니다. 글자만 있는 패널은 쓸 수 없습니다 — 장면 속 물체를 1~3개 적으세요.`,
      );
    if (clip.actions.length === 0)
      hard.push(
        `${where}에 동작(actions)이 없습니다. 물체가 하는 일의 순서(올라감·쏟아짐·열림·차오름)를 영어 한 줄씩 적으세요.`,
      );
    const ids = clip.objects.map((object) => object.subjectId);
    if (new Set(ids).size !== ids.length) hard.push(`${where}의 물체 subjectId 가 중복됩니다.`);
    for (const object of clip.objects) {
      if (!subjectIds.has(object.subjectId))
        hard.push(
          `${where}의 물체 ${object.subjectId}가 subjects 에 선언되지 않았습니다. 등장 대상에 id 와 외형을 먼저 적으세요.`,
        );
      const fixed = colorOf.get(object.subjectId);
      if (fixed && fixed.color !== object.color)
        hard.push(
          `${where}의 물체 ${object.subjectId} 색(${object.color})이 ${fixed.clipId}의 색(${fixed.color})과 다릅니다. 같은 대상의 색은 영상 끝까지 고정하세요.`,
        );
      else if (!fixed) colorOf.set(object.subjectId, { color: object.color, clipId: clip.id });
    }
    if (clip.sceneType === "comparison") {
      if (clip.objects.length < 2)
        hard.push(
          `${where}(비교)에는 물체가 2개 이상 필요합니다. 두 모형을 나란히 같은 카메라로 보여 주세요.`,
        );
      const colors = clip.objects.map((object) => object.color);
      if (new Set(colors).size !== colors.length)
        hard.push(
          `${where}(비교)의 물체 색이 겹칩니다. 비교 대상은 서로 다른 색(accent1·accent2·neutral)으로 구분하세요.`,
        );
      if (!clip.emphasis.some((item) => item.kind === "color_code"))
        soft.push(
          `${where}(비교)에 색 구분 강조(color_code)가 없습니다. 비교는 표·체크리스트가 아니라 색으로 구분합니다.`,
        );
    }
    // 2026-10-08(사용자 결정: 인포그래픽은 Flow INFO 이미지 안에): INFO 에 찍을 문구는 한글·숫자·%·단위만(영문은 hard).
    // 숫자가 자료에 있는지는 shared/script-rules.ts 가 expected.facts 로 본다. 예전 혼합형 대본(infoLines [])은 그대로 통과한다.
    clip.infoLines.forEach((text, index) => {
      if (/[A-Za-z]/u.test(text))
        hard.push(
          `${where}의 INFO 문구 ${index + 1} "${text}"에 영문이 있습니다. INFO 이미지의 글자는 한글·숫자·%만 씁니다(예: 올리브유 100%, 600밀리그램).`,
        );
    });
    clip.emphasis.forEach((item, index) => {
      if (!ids.includes(item.target))
        hard.push(
          `${where}의 강조 ${index + 1}(${item.kind})이 가리키는 ${item.target}이 이 장면의 물체(objects)에 없습니다. 강조는 장면 속 물체에만 붙습니다.`,
        );
      if (item.afterAction >= clip.actions.length)
        hard.push(
          `${where}의 강조 ${index + 1}(${item.kind})이 ${item.afterAction + 1}번째 동작 뒤에 나타나는데 동작은 ${clip.actions.length}개뿐입니다.`,
        );
    });
  }
  return { hard, soft };
}

// 기획의 설명 장면(scenePlan[].explainerScene) ↔ 대본 설명 컷 대조(soft). 기획에 설명 장면이 하나라도 있을 때만 본다
// (예전 기획·실사만 있는 기획은 건너뛴다). 순서대로 짝지어 장면 종류·물체(ID·색)·동작 수를 비교한다.
export function plannedScenePlanProblems(
  planning: VideoPlanning | undefined,
  infoClips: readonly InfoClip[],
): string[] {
  const planned = (planning?.concept.scenePlan ?? []).flatMap((item) =>
    item.source === "info_clip" && item.explainerScene ? [item.explainerScene] : [],
  );
  if (planned.length === 0) return [];
  const soft: string[] = [];
  if (planned.length !== infoClips.length)
    soft.push(
      `기획의 설명 장면은 ${planned.length}개인데 대본의 설명 컷은 ${infoClips.length}개입니다. 기획 장면을 그대로 옮기거나 기획을 다시 쓰세요.`,
    );
  const objectKey = (objects: readonly { subjectId: string; color: string }[]) =>
    [...objects]
      .map((object) => `${object.subjectId}:${object.color}`)
      .sort()
      .join(",");
  planned.forEach((scene, index) => {
    const clip = infoClips[index];
    if (!clip || !isExplainerScene(clip)) return;
    const where = `설명 컷 ${clip.id}`;
    if (clip.sceneType !== scene.sceneType)
      soft.push(`${where}의 장면 종류(${clip.sceneType})가 기획(${scene.sceneType})과 다릅니다.`);
    if (objectKey(clip.objects) !== objectKey(scene.objects))
      soft.push(
        `${where}의 물체·색(${objectKey(clip.objects)})이 기획(${objectKey(scene.objects)})과 다릅니다. 같은 subjectId 와 색을 쓰세요.`,
      );
    if (clip.actions.length !== scene.actions.length)
      soft.push(
        `${where}의 동작은 ${clip.actions.length}개인데 기획은 ${scene.actions.length}개입니다. 기획의 동작 순서를 그대로 옮기세요.`,
      );
  });
  return soft;
}

// 혼합형 대본 전체 규칙(H2·H3·H4·H7·H8·R9). 혼합형이 아니면 빈 결과.
export function hybridProblems(script: VideoScript): ScriptProblems {
  if (!isHybrid(script)) return { hard: [], soft: [] };
  // 숫자 임계값은 호출 때 읽는다(instructions/thresholds.json 주입값).
  const {
    EXPLAINER_CUT_MAX_SEC: explainerCutMaxSec,
    EXPLAINER_HOLD_MS: explainerHoldMs,
    EXPLAINER_MAX_RATIO: explainerMaxRatio,
    HYBRID_ENDING_IMAGE_MAX_SEC: endingImageMaxSec,
    STILL_BEAT_MAX_SEC: stillBeatMaxSec,
  } = thresholds();
  const scene = explainerSceneProblems(script.infoClips, script.subjects);
  const hard = [...scene.hard];
  const soft = [...scene.soft, ...plannedScenePlanProblems(script.planning, script.infoClips)];
  const { cuts } = script;
  const durationMs = Math.round(script.durationSec * 1000);
  // H2 비트 → 소스: 문장 chainStep 으로 판정한다(bridge·"" 는 제한 없음). 사슬 칸이 하나도 없는 대본은 purpose 로 판정한다.
  const chainless = script.voiceover.every(
    (voice) => voice.chainStep === "" || voice.chainStep === "bridge",
  );
  // U3(2026-10-08, 어제 완성본 6e736cd8 반성): 진짜 원인·해결 조건(③④) 문장이 정지 사진 13초로 흘렀다. 이 두 비트 아래 정지 이미지는
  // 한 컷 STILL_BEAT_MAX_SEC 초까지, 연속 두 컷은 거부한다(사슬 없는 대본은 purpose mechanism 문장). 비트에 속한 컷 번호를 모아 뒤에서 본다.
  const beat34Cuts = new Set<number>();
  script.voiceover.forEach((voice, index) => {
    const range = voiceCutRange(voice, cuts);
    if (!range) return;
    const step = voice.chainStep;
    const byPurpose = chainless && voice.purpose !== "";
    const liveOnly = byPurpose
      ? HYBRID_LIVE_ONLY_PURPOSES.includes(voice.purpose)
      : step !== "" && step !== "bridge" && HYBRID_LIVE_ONLY_STEPS.includes(step);
    const explainerOk = byPurpose
      ? HYBRID_EXPLAINER_PURPOSES.includes(voice.purpose)
      : step !== "" && step !== "bridge" && HYBRID_EXPLAINER_STEPS.includes(step);
    // 승인 제품 이미지(광고 카드)는 행동 문장의 엔딩에만 허용한다(H8). 고통·믿는 원인·결과 문장은 사람·상황이 보여야 한다.
    const cardAllowed = byPurpose
      ? voice.purpose === "cta" || voice.purpose === "offer"
      : step === "cta";
    const covered = cuts.slice(range[0], range[1] + 1).map((cut, offset) => ({
      cut,
      index: range[0] + offset,
    }));
    const label = byPurpose ? `purpose ${voice.purpose}` : step;
    const where = `${index + 1}번째 문장(${label}) "${voice.text}"`;
    if (liveOnly) {
      for (const { cut, index: cutIndex } of covered)
        if (!isLiveCut(cut) || (!cardAllowed && cut.source === "approved_image"))
          hard.push(
            `${where}의 ${cutLabel(cut, cutIndex)}은 실사가 아닙니다. 고통·믿는 원인·결과·행동 문장의 컷은 사람·상황이 보이는 실사(veo_clip A~D 또는 still_image)만 씁니다.`,
          );
      // 사람이 보이는가(soft): 구도·목표·클립 동작·정지 이미지 프롬프트 어디에도 사람 낱말이 없으면 경고. 판단할 글이 없는 소스(촬영본·광고 카드)뿐이면 넘어간다.
      const judgeable = covered.filter(
        ({ cut }) => cut.source === "veo_clip" || cut.source === "still_image",
      );
      if (
        judgeable.length > 0 &&
        !judgeable.some(({ cut }) => PERSON_WORDS.test(cutDescription(cut, script)))
      )
        soft.push(
          `${where}의 실사 컷에 사람이 보이지 않습니다(화면 구도·클립 동작·정지 이미지 프롬프트에 사람 낱말이 없음). 고통·상황·결과·행동은 사람이 겪는 장면으로 보여 주세요.`,
        );
    }
    const beat34 = byPurpose
      ? voice.purpose === "mechanism"
      : step === "real_cause" || step === "requirement";
    if (beat34)
      for (const { cut, index: cutIndex } of covered) {
        beat34Cuts.add(cutIndex);
        if (cut.source === "still_image" && cutSeconds(cut) > stillBeatMaxSec)
          hard.push(
            `${where}의 ${cutLabel(cut, cutIndex)}은 정지 이미지 ${cutSeconds(cut)}초입니다. 진짜 원인·해결 조건 문장 아래 정지 이미지는 한 컷 ${stillBeatMaxSec}초까지이고 나머지는 설명 장면(I1~I3) 또는 실사 Veo 움직임으로 보여 줍니다.`,
          );
      }
    if (explainerOk)
      for (const { cut, index: cutIndex } of covered)
        if (!isLiveCut(cut) && !isExplainerCut(cut))
          hard.push(
            `${where}의 ${cutLabel(cut, cutIndex)}은 실사도 설명 장면도 아닙니다. 원인·조건·사실·이유 문장의 컷은 설명 클립(I1~I3) 또는 실사만 씁니다.`,
          );
    // H7 콜아웃은 실사 컷에서만 그린다. 설명 컷뿐인 문장의 콜아웃은 그려지지 않는다(설명 세계는 자막 한 줄만).
    if (voice.callouts.length > 0 && covered.every(({ cut }) => isExplainerCut(cut)))
      soft.push(
        `${where}의 콜아웃 ${voice.callouts.length}개는 설명 컷 위라 그리지 않습니다. 설명 세계에는 자막 한 줄뿐이니 콜아웃을 빼거나 실사 컷이 있는 문장으로 옮기세요.`,
      );
  });
  // U3 ③④ 비트에서 정지 이미지 연속 두 컷 금지(길이와 무관).
  for (const index of [...beat34Cuts].sort((left, right) => left - right)) {
    const cut = cuts[index];
    const next = cuts[index + 1];
    if (
      cut &&
      next &&
      beat34Cuts.has(index + 1) &&
      cut.source === "still_image" &&
      next.source === "still_image"
    )
      hard.push(
        `${cutLabel(cut, index)}과 ${cutLabel(next, index + 1)}이 정지 이미지 연속입니다. 진짜 원인·해결 조건 문장 아래에서는 정지 이미지를 잇지 말고 설명 장면(I1~I3) 또는 실사 Veo 움직임으로 바꾸세요.`,
      );
  }
  // U3 비교 장면은 겉이 똑같은 상태(early)부터: 첫 컷이 early 가 아니면 hard, 둘째 컷이 mid 가 아니면 soft. 과정 장면은 단계 순서(early→mid→late)를 거스르면 soft.
  // 비교 장면의 우리 제품 표식(accent1 색 또는 빨간 외곽선)이 없으면 soft(영상 끝까지 같은 표식).
  const phaseOrder = { early: 0, mid: 1, late: 2 } as const;
  for (const clip of script.infoClips) {
    if (!isExplainerScene(clip)) continue;
    const uses = cuts
      .map((cut, index) => ({ cut, index }))
      .filter(({ cut }) => cut.source === "veo_clip" && cut.veoClip === clip.id);
    const [first, second] = uses;
    if (clip.sceneType === "comparison") {
      if (first && first.cut.phase !== "early")
        hard.push(
          `설명 장면 ${clip.id}(비교)의 첫 컷 ${cutLabel(first.cut, first.index)}이 ${first.cut.phase || "단계 없음"} 단계입니다. 비교는 두 모형이 겉으로 똑같아 보이는 early 단계부터 보여 주고 다음 컷(mid)에서 속이 드러나야 합니다.`,
        );
      else if (second && second.cut.phase !== "mid")
        soft.push(
          `설명 장면 ${clip.id}(비교)의 둘째 컷 ${cutLabel(second.cut, second.index)}이 ${second.cut.phase || "단계 없음"} 단계입니다. 겉이 똑같은 early 다음에는 속이 드러나는 mid 를 이어 보여 주세요.`,
        );
      if (
        !clip.objects.some((object) => object.color === "accent1") &&
        !clip.emphasis.some((item) => item.kind === "outline")
      )
        soft.push(
          `설명 장면 ${clip.id}(비교)에 우리 제품 표식(accent1 색 또는 빨간 외곽선)이 없습니다. 어느 쪽이 우리 제품인지 한 가지 표식으로 영상 끝까지 고정하세요.`,
        );
    } else if (clip.sceneType === "process") {
      const phases = uses
        .map(({ cut }) => cut.phase)
        .filter((phase): phase is keyof typeof phaseOrder => phase in phaseOrder);
      if (
        phases.some(
          (phase, index) => index > 0 && phaseOrder[phase] < phaseOrder[phases[index - 1] ?? phase],
        )
      )
        soft.push(
          `설명 장면 ${clip.id}(과정)의 컷이 단계 순서(early → mid → late)를 거스릅니다. 과정은 동작 순서대로 보여 주세요.`,
        );
    }
  }
  // H2 모션그래픽 단독 컷 금지, 설명 컷 길이 상한(R9: 한 단계만 쓰고 보유 1초).
  cuts.forEach((cut, index) => {
    if (cut.source === "motion_graphic" && index !== cuts.length - 1)
      hard.push(
        `${cutLabel(cut, index)}: 혼합형에서는 글자 패널(motion_graphic) 컷을 쓰지 않습니다. 숫자·목록은 말하고 자막으로만 보여 주고, 화면은 실사 또는 설명 장면으로 바꾸세요.`,
      );
    if (isExplainerCut(cut) && cutSeconds(cut) > explainerCutMaxSec)
      hard.push(
        `${cutLabel(cut, index)} 길이 ${cutSeconds(cut)}초 — 설명 컷은 ${explainerCutMaxSec}초 이하입니다. 한 단계(phase)만 쓰고 마지막 동작 뒤 보유는 ${explainerHoldMs / 1000}초까지입니다.`,
      );
  });
  // R9 한 단계만: 설명 컷의 읽기가 자기 단계 끝을 보유 시간 넘게 지나 다음 단계로 이어지면 거부한다(길이 4초 상한만으로는 early 4초 컷이 mid 로 넘어간다).
  for (const read of clipPhaseReads(cuts)) {
    if (!isInfoClipId(read.clipId)) continue;
    const [phaseStart] = CLIP_PHASE_RANGES_MS[read.phase];
    if (read.endMs > read.phaseEndMs + explainerHoldMs) {
      const cut = cuts[read.index];
      if (cut)
        hard.push(
          `${cutLabel(cut, read.index)}이 ${read.phase} 단계(${phaseStart / 1000}~${read.phaseEndMs / 1000}초)를 넘어 ${read.endMs / 1000}초까지 읽습니다. 설명 컷은 한 단계만 씁니다 — 컷을 줄이거나 다음 단계 컷으로 나누세요.`,
        );
    }
  }
  // 첫 컷·마지막 컷은 실사(H2·H8). 첫 컷은 광고 카드가 아니라 사람·상황이 보이는 장면이어야 한다.
  const first = cuts[0];
  if (first && !isLiveSceneCut(first))
    hard.push(
      `${cutLabel(first, 0)}: 첫 컷은 실사여야 합니다(사람·상황이 보이는 veo_clip 또는 still_image).`,
    );
  const lastIndex = cuts.length - 1;
  const last = cuts[lastIndex];
  if (last && last.source === "motion_graphic")
    hard.push(
      `${cutLabel(last, lastIndex)}: 엔딩이 글자 패널입니다. 마지막 2~3초는 실사 + 제품(사람 손의 제품 또는 승인 이미지 ${endingImageMaxSec}초 이하)이어야 합니다.`,
    );
  else if (last && !isLiveCut(last))
    hard.push(
      `${cutLabel(last, lastIndex)}: 마지막 컷은 실사 + 제품이어야 합니다(설명 장면으로 끝내지 마세요).`,
    );
  else if (last && last.source === "approved_image" && cutSeconds(last) > endingImageMaxSec)
    soft.push(
      `${cutLabel(last, lastIndex)}: 엔딩의 승인 이미지가 ${cutSeconds(last)}초입니다(${endingImageMaxSec}초 이하 권장). 남는 시간은 사람 손의 제품 실사로 채우세요.`,
    );
  else if (
    last &&
    (last.source === "veo_clip" || last.source === "still_image") &&
    !PRODUCT_WORDS.test(cutDescription(last, script))
  )
    soft.push(
      `${cutLabel(last, lastIndex)}: 엔딩 실사에 제품이 보이지 않습니다(화면 구도·클립 동작·프롬프트에 제품·손 낱말이 없음). 마지막 2~3초는 사람 손의 제품을 보여 주세요.`,
    );
  // H3 실사 프롬프트에 사람·제품·사진 금지 문구 금지.
  const livePrompts = [
    { label: "styleAnchor", text: script.styleAnchor },
    ...script.veoClips.flatMap((clip) => [
      { label: `Veo 클립 ${clip.id} 시작 이미지`, text: clip.startImagePrompt },
      { label: `Veo 클립 ${clip.id} 동작`, text: clip.prompt },
    ]),
    ...script.stills.map((still) => ({ label: `정지 이미지 ${still.id}`, text: still.prompt })),
  ];
  for (const prompt of livePrompts) {
    const match = LIVE_PROMPT_FORBIDDEN.exec(prompt.text);
    if (match)
      hard.push(
        `${prompt.label} 프롬프트에 실사를 지우는 문구("${match[0]}")가 있습니다. 사람·제품·사진 금지는 설명 세계(explainerAnchor)에만 적고 실사 프롬프트에서는 빼세요.`,
      );
  }
  if (script.infoClips.length > 0) {
    if (script.explainerAnchor === "")
      hard.push(
        "설명 세계의 시각 기준(explainerAnchor: 클레이·화이트 + 브랜드 강조색 2개 + 흰 발광 + 주광, 사람·글자 없음)이 없습니다.",
      );
    else {
      if (!EXPLAINER_ANCHOR_NO_PEOPLE.test(script.explainerAnchor))
        soft.push(
          'explainerAnchor 에 사람 금지("no people")가 없습니다. 설명 세계에는 사람·손·캐릭터가 없어야 합니다.',
        );
      if (!EXPLAINER_ANCHOR_NO_TEXT.test(script.explainerAnchor))
        soft.push(
          'explainerAnchor 에 글자 금지("no text")가 없습니다. 설명 세계의 글자는 앱 자막 한 줄뿐입니다.',
        );
      if (explainerAnchorColorCount(script.explainerAnchor) < 2)
        soft.push(
          "explainerAnchor 에 브랜드 강조색 2개의 이름(예: deep olive, warm gold)이 없습니다. INFO·영상 프롬프트의 강조색은 이 기준에서 색을 가져옵니다.",
        );
    }
  }
  // 설명 컷 합계 ≤ 50%(soft).
  const explainerMs = cuts
    .filter(isExplainerCut)
    .reduce((sum, cut) => sum + Math.round(cutSeconds(cut) * 1000), 0);
  if (durationMs > 0 && explainerMs > durationMs * explainerMaxRatio)
    soft.push(
      `설명 컷이 ${explainerMs / 1000}초로 전체의 ${Math.round((explainerMs / durationMs) * 100)}%입니다(${Math.round(explainerMaxRatio * 100)}% 이하 권장). 고통·상황·결과 비트를 실사로 더 보여 주세요.`,
    );
  return { hard, soft };
}
