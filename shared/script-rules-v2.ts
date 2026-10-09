import { assignClipOffsets, type ClipCutSlot, CONTINUOUS_TAIL_PAD_MAX_MS } from "./clip-offsets";
import {
  explainerAnchorColorCount,
  explainerSceneProblems,
  HYBRID_LIVE_ONLY_STEPS,
  isExplainerCut,
  isLiveCut,
  isLiveSceneCut,
  LIVE_PROMPT_FORBIDDEN,
} from "./hybrid-script-rules";
import { CHAIN_ORDER, CHAIN_STEP_LABELS, digitGroups } from "./persuasion-chain";
import type { ScriptExpectation, ScriptProblems } from "./script-rules";
import { thresholds } from "./thresholds";
import {
  type CopyLine,
  INFO_CLIPS_MAX,
  isClipPhaseId,
  isExplainerScene,
  isHybrid,
  isInfoClipId,
  memoEnding,
  sentenceSimilarity,
  VEO_CLIP_MS,
  VEO_SHOTS_MAX,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
  type VideoScript,
  voiceCutRange,
} from "./video-script";

// 카피 먼저 흐름(2026-10-08, 사용자 결정 "말 먼저, 그림은 나중, 규칙은 필요한 것만")의 규칙 20개.
// 1단계 카피(copyProblems, 8개) → 사용자가 글로 보고 승인 → 2단계 장면(sceneProblemsV2, 제작 안전 12개).
// 예전 흐름의 규칙 100개(shared/script-rules.ts 등)는 flow "" 대본에만 적용되고, 여기서는 다시 쓰지 않는다.
// 기존 검사 함수는 이 20개에 해당하는 것만 가져온다(되받기·26자·효과 반복·답 시점·재후킹·자막 12자·말한 낱말 화면 대조·콜아웃 어절·
// 숫자 노출(shownDigitGroups) 같은 예전 규칙은 가져오지 않는다).
// 창작 지침은 instructions/copy-first.md 를 본다.

// 문장 사이 무음(ms). 카피 길이 추정과 조립의 문장 간격이 같은 값을 쓴다.
export const COPY_GAP_MS = 500;
// 같은 클립의 같은 구간을 겹쳐 읽는 양이 이 값 이하면 경고만(조립이 뒤 컷을 당겨 읽어 잠깐 반복), 넘으면 거부.
export const OVERLAP_SOFT_MAX_MS = 1000;

// 발화 시간 추정(ms): 글자 수 / 초당 글자 수(NATURAL_CHARS_PER_SEC) + 문장 사이 무음. 공백·문장부호도 글자로 센다(Typecast 실측 근사).
export function estimateSpeechMs(
  texts: readonly string[],
  rate: number = thresholds().NATURAL_CHARS_PER_SEC,
  gapMs: number = COPY_GAP_MS,
): number {
  if (texts.length === 0) return 0;
  const speech = texts.reduce((sum, text) => sum + ([...text.trim()].length / rate) * 1000, 0);
  return Math.round(speech + gapMs * (texts.length - 1));
}

export type CopyContext = {
  // 목표 길이(초). 추정 발화가 30~60초를 벗어나면 hard, 목표와 많이 다르면 soft.
  readonly durationTargetSec: number;
  // 등록된 사실·고객 후기 글(숫자 대조용). 비어 있으면 숫자 검사는 건너뛴다.
  readonly facts: readonly string[];
};

// --- 1단계 카피 규칙 8개 ------------------------------------------------------------------------------------------
// 같은 사실을 두 번 말한 것으로 보는 글자 bigram 자카드 하한(공백·문장부호는 뺀 뒤 비교). 예전 규칙의 0.75 보다 느슨하다.
const SAME_FACT_SIMILARITY = 0.6;
// 추정 발화 시간이 목표와 이만큼(초) 넘게 다르면 경고.
const TARGET_DRIFT_SEC = 8;
const LATIN_LETTER = /[A-Za-z]/;
const MEMO_MARKER = /예\s*[:：]|출처|FACT|sourceId/;
// 서술어 없는 명사형 종결("~했음", "~함"). 대본 규칙(narrationProblems)과 같은 판정이다.
const NOMINAL_ENDING = /(?:했음|됐음|졌음|었음|았음|있음|없음|거임|였음|함)$/;
// 행동 문장의 명령·권유 종결: ~세요/~보세요/~해요/~봐요/~줘요/~할까요/~볼래요/~합시다/~십시오.
const CTA_ENDING = /(?:세요|[해봐줘]요|[할볼]까요|래요|십시오|시다)$/u;
// 행동 문장에서 피할 검증 낱말(소프트): 검증은 화면이 하고 행동은 결정 단계 동사로 끝낸다.
const CTA_VERIFY_WORDS = /확인|표기|라벨|상세\s?페이지|상세에서/u;
// 필수 단계(믿는 원인만 생략 가능).
const REQUIRED_STEPS = CHAIN_ORDER.filter((step) => step !== "believed_cause");

const charCount = (text: string) => [...text.trim()].length;
const trimEnd = (text: string) => text.trim().replace(/[\s\p{P}\p{S}]+$/u, "");
// 숫자 묶음 비교용: "1,000" 과 "1000" 을 같은 숫자로 본다.
const digitSet = (text: string): Set<string> =>
  new Set([...digitGroups(text)].map((value) => value.replaceAll(",", "")));

export function copyProblems(lines: readonly CopyLine[], ctx: CopyContext): ScriptProblems {
  const hard: string[] = [];
  const soft: string[] = [];
  const at = (index: number, line: CopyLine) =>
    `${index + 1}번째 문장(${CHAIN_STEP_LABELS[line.chainStep]}) "${line.text}"`;

  // 1. 순서: 고통 → 믿는 원인(선택) → 진짜 원인 → 해결 조건 → 우리 상품의 사실 → 가능한 이유 → 결과 → 행동. 연결(bridge)은 사이에만.
  const chain = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.chainStep !== "bridge");
  let last = -1;
  for (const { line, index } of chain) {
    const position = CHAIN_ORDER.indexOf(line.chainStep);
    if (position < last)
      hard.push(
        `${at(index, line)}이 순서를 거슬렀습니다. 순서는 고통 → 믿는 원인 → 진짜 원인 → 해결 조건 → 우리 상품의 사실 → 가능한 이유 → 결과 → 행동입니다.`,
      );
    last = Math.max(last, position);
  }
  const present = new Set(chain.map(({ line }) => line.chainStep));
  const missing = REQUIRED_STEPS.filter((step) => !present.has(step));
  if (missing.length > 0)
    hard.push(
      `빠진 단계가 있습니다: ${missing.map((step) => CHAIN_STEP_LABELS[step]).join(", ")}. 믿는 원인(②)만 생략할 수 있고 나머지는 한 문장 이상 말해야 합니다.`,
    );
  if (lines[0]?.chainStep === "bridge")
    hard.push("1번째 문장이 연결(bridge)입니다. 첫 문장은 고통(①)이어야 합니다.");
  if (lines.length > 1 && lines[lines.length - 1]?.chainStep === "bridge")
    hard.push(`${lines.length}번째 문장이 연결(bridge)입니다. 마지막 문장은 행동이어야 합니다.`);
  const ctaIndexes = lines.flatMap((line, index) => (line.chainStep === "cta" ? [index + 1] : []));
  if (ctaIndexes.length > 1)
    hard.push(
      `행동 문장이 ${ctaIndexes.length}개(${ctaIndexes.join("·")}번째)입니다. 행동은 맨 뒤 한 문장뿐입니다.`,
    );

  // 2. 사실 밖 숫자 금지: 아라비아 숫자 묶음이 등록된 사실 글에 있어야 한다(한글 숫자는 발화용이라 보지 않는다).
  const factText = ctx.facts.join(" ");
  if (factText.trim() !== "") {
    const allowed = digitSet(factText);
    lines.forEach((line, index) => {
      for (const value of digitSet(line.text))
        if (!allowed.has(value))
          hard.push(
            `${at(index, line)}에 사실에 없는 숫자(${value})가 있습니다. 등록된 자료에 있는 숫자만 쓰세요(말로 읽는 한글 숫자는 괜찮습니다).`,
          );
    });
  }

  // 3. 길이: 한 문장은 한 호흡(COPY_BEAT_MAX_CHARS 이내). 목표 글자 수 초과는 보지 않는다.
  const {
    COPY_BEAT_MAX_CHARS: maxChars,
    COPY_LINES_MIN: minLines,
    COPY_LINES_MAX: maxLines,
  } = thresholds();
  lines.forEach((line, index) => {
    const chars = charCount(line.text);
    if (chars > maxChars)
      hard.push(
        `${at(index, line)}이 ${chars}자입니다. 한 문장은 한 호흡(${maxChars}자 이내)이어야 합니다. 상황·반전·감정을 따로 끊으세요.`,
      );
  });

  // 4. 문장 수·시간: 문장 수는 범위 안, 추정 발화는 30~60초. 길이가 안 맞으면 문장을 자르지 말고 수를 조절한다.
  if (lines.length < minLines || lines.length > maxLines)
    hard.push(
      `문장이 ${lines.length}개입니다. ${minLines}~${maxLines}개로 맞추세요(문장을 자르지 말고 수를 조절하세요).`,
    );
  if (lines.length > 0) {
    const ms = estimateSpeechMs(lines.map((line) => line.text));
    const seconds = Math.round(ms / 100) / 10;
    if (ms < VIDEO_MIN_SEC * 1000 || ms > VIDEO_MAX_SEC * 1000)
      hard.push(
        `읽는 시간이 약 ${seconds}초(문장 ${lines.length}개)로 ${VIDEO_MIN_SEC}~${VIDEO_MAX_SEC}초 밖입니다. 문장을 자르지 말고 수를 조절하세요(${ms < VIDEO_MIN_SEC * 1000 ? "문장을 더하세요" : "문장을 빼세요"}).`,
      );
    else if (Math.abs(seconds - ctx.durationTargetSec) > TARGET_DRIFT_SEC)
      soft.push(
        `읽는 시간이 약 ${seconds}초로 목표 ${ctx.durationTargetSec}초와 ${TARGET_DRIFT_SEC}초 넘게 다릅니다.`,
      );
  }

  // 5. ④ 해결 조건은 한 문장.
  const requirementIndexes = lines.flatMap((line, index) =>
    line.chainStep === "requirement" ? [index + 1] : [],
  );
  if (requirementIndexes.length >= 2)
    hard.push(
      `해결 조건(④) 문장이 ${requirementIndexes.length}개(${requirementIndexes.join("·")}번째)입니다. 조건은 한 문장으로 쓰세요.`,
    );

  // 6. 영문·메모체·출처 낭독 금지, 서술어로 끝내기.
  lines.forEach((line, index) => {
    if (LATIN_LETTER.test(line.text))
      hard.push(
        `${at(index, line)}에 영문이 있습니다 — 한글로 적으세요(예: 엑스트라 버진, 600밀리그램).`,
      );
    if (MEMO_MARKER.test(line.text))
      hard.push(
        `${at(index, line)}에 메모·출처 표기("예:", "출처", "FACT", "sourceId")가 있습니다. 시청자에게 말하는 완전한 문장으로 쓰세요.`,
      );
    if (memoEnding(line.text) || NOMINAL_ENDING.test(trimEnd(line.text)))
      hard.push(
        `${at(index, line)}이 서술어 없이 명사·조사로 끝납니다. "~해요", "~예요", "~세요"처럼 시청자에게 말하는 문장으로 끝내세요.`,
      );
  });

  // 7. 같은 사실은 두 번까지: 거의 같은 문장 쌍이 2쌍 이상이면 거부, 1쌍이면 경고.
  const pairs: [number, number][] = [];
  for (let left = 0; left < lines.length; left++)
    for (let right = left + 1; right < lines.length; right++)
      if (
        sentenceSimilarity(lines[left]?.text ?? "", lines[right]?.text ?? "") >=
        SAME_FACT_SIMILARITY
      )
        pairs.push([left + 1, right + 1]);
  const pairText = pairs.map(([left, right]) => `${left}·${right}번째`).join(", ");
  if (pairs.length >= 2)
    hard.push(
      `거의 같은 말을 되풀이한 문장 쌍이 ${pairs.length}쌍(${pairText})입니다. 같은 사실은 두 번까지만 말하고, 새 정보가 없는 문장은 다른 사실로 바꾸세요.`,
    );
  else if (pairs.length === 1)
    soft.push(`${pairText} 문장이 거의 같은 말입니다. 새 정보가 없다면 하나를 바꾸세요.`);

  // 8. 행동 문장은 명령·권유 동사로 끝낸다. 검증 낱말(확인·표기·라벨·상세페이지)은 경고.
  lines.forEach((line, index) => {
    if (line.chainStep !== "cta") return;
    if (!CTA_ENDING.test(trimEnd(line.text)))
      hard.push(
        `${at(index, line)}이 행동을 권하는 말로 끝나지 않습니다. "~보세요/~해 보세요/~하세요/~해요"로 끝내세요(예: 읽어 보세요, 골라 보세요, 비교해 보세요).`,
      );
    if (CTA_VERIFY_WORDS.test(line.text))
      soft.push(
        `${at(index, line)}에 확인·표기·라벨·상세페이지 같은 검증 낱말이 있습니다. 검증은 화면이 하니 행동은 읽어 보세요·골라 보세요·비교해 보세요처럼 끝내세요.`,
      );
  });
  return { hard, soft };
}

// --- 2단계 장면(제작 안전) 규칙 12개 --------------------------------------------------------------------------------
// 카피 규칙은 다시 보지 않는다(문장은 이미 확정). 장면이 문장을 담을 수 있는지, 제작 단계가 깨지지 않는지만 본다.
// 정지 이미지는 영상 전체 6초·한 컷 3초까지, 정지 이미지 선언은 3장까지.
const STILLS_DECLARED_MAX = 3;
const STILL_TOTAL_MAX_MS = 6000;
const STILL_CUT_MAX_MS = 3000;
// 문장의 읽는 시간에 더하는 여유(ms).
const SPEECH_SLACK_MS = 300;
// 설명 장면 INFO 문구: 1~4줄, 줄당 24자 이하.
const INFO_LINES_MIN = 1;
const INFO_LINES_MAX = 4;
const INFO_LINE_MAX_CHARS = 24;
const EXPLAINER_ANCHOR_COLORS_MIN = 2;

type Cut = VideoScript["cuts"][number];
const cutMs = (cut: Cut) => Math.round(cut.endSec * 1000) - Math.round(cut.startSec * 1000);
const SOURCE_LABELS: Record<Cut["source"], string> = {
  approved_image: "대표 이미지",
  card_slide: "카드뉴스",
  veo_clip: "Veo 클립",
  project_clip: "촬영본",
  motion_graphic: "모션그래픽",
  still_image: "정지 이미지",
};
function cutWhere(cut: Cut, index: number): string {
  const source = cut.source === "veo_clip" ? `${cut.veoClip} 클립` : SOURCE_LABELS[cut.source];
  return `컷 ${index}(${source}, ${cut.startSec}~${cut.endSec}초)`;
}
const shorten = (text: string, max = 14) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};
const seconds1 = (ms: number) => Math.round(ms / 100) / 10;

export function sceneProblemsV2(script: VideoScript, expected: ScriptExpectation): ScriptProblems {
  const hard: string[] = [];
  const soft: string[] = [];
  const fail = (message: string) => {
    if (!hard.includes(message)) hard.push(message);
  };
  const warn = (message: string) => {
    if (!soft.includes(message)) soft.push(message);
  };
  const { cuts, voiceover } = script;
  const limits = thresholds();

  if (script.number !== expected.number || script.hypothesisId !== expected.hypothesis.id)
    fail(`number는 ${expected.number}, hypothesisId는 ${expected.hypothesis.id}여야 합니다.`);

  // 1. 선언된 ID 만 쓴다(중복 선언·설명 ID 를 Veo 목록에 넣는 것도 거부). 선언하고 안 쓴 것은 경고.
  for (const [kind, ids] of [
    ["Veo 클립", script.veoClips.map((clip) => clip.id)],
    ["설명 컷", script.infoClips.map((clip) => clip.id)],
    ["정지 이미지", script.stills.map((still) => still.id)],
  ] as const)
    if (new Set(ids).size !== ids.length) fail(`${kind} ID가 중복 선언됐습니다.`);
  if (script.veoClips.some((clip) => isInfoClipId(clip.id)))
    fail("veoClips 에는 A~D 만 선언하고 설명 컷은 infoClips 에 선언하세요.");
  const declaredClips = new Set<string>([
    ...script.veoClips.map((clip) => clip.id),
    ...script.infoClips.map((clip) => clip.id),
  ]);
  const declaredStills = new Set<string>(script.stills.map((still) => still.id));
  cuts.forEach((cut, index) => {
    if (cut.source === "veo_clip" && !declaredClips.has(cut.veoClip))
      fail(
        `${cutWhere(cut, index)}이 선언하지 않은 클립 "${cut.veoClip}"을 가리킵니다. veoClips 또는 infoClips 에 선언한 ID 만 쓰세요.`,
      );
    if (cut.source === "still_image" && !declaredStills.has(cut.stillId))
      fail(
        `${cutWhere(cut, index)}이 선언하지 않은 정지 이미지 "${cut.stillId}"를 가리킵니다. stills 에 선언한 ID 만 쓰세요.`,
      );
  });
  for (const clip of script.veoClips)
    if (!cuts.some((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id))
      warn(`선언한 Veo 클립 ${clip.id}를 쓰는 컷이 없습니다.`);
  for (const clip of script.infoClips)
    if (!cuts.some((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id))
      warn(`선언한 설명 컷 ${clip.id}를 쓰는 컷이 없습니다.`);
  for (const still of script.stills)
    if (!cuts.some((cut) => cut.source === "still_image" && cut.stillId === still.id))
      warn(`선언한 정지 이미지 ${still.id}를 쓰는 컷이 없습니다.`);

  // 2. 컷 시간이 이어지고 합계가 영상 길이와 같으며 길이는 30~60초.
  if (script.durationSec < VIDEO_MIN_SEC || script.durationSec > VIDEO_MAX_SEC)
    fail(
      `길이 ${script.durationSec}초는 허용 범위 ${VIDEO_MIN_SEC}~${VIDEO_MAX_SEC}초 밖입니다. 컷을 더하거나 빼세요.`,
    );
  let endMs = 0;
  for (const [index, cut] of cuts.entries()) {
    if (Math.round(cut.startSec * 1000) !== endMs || cutMs(cut) <= 0) {
      fail(
        `컷 시간이 이어지지 않습니다(${endMs / 1000}초 다음 컷 ${index}이 ${cut.startSec}~${cut.endSec}초).`,
      );
      break;
    }
    endMs = Math.round(cut.endSec * 1000);
  }
  if (endMs !== Math.round(script.durationSec * 1000))
    fail(
      `컷 합계가 ${endMs / 1000}초인데 영상 길이는 ${script.durationSec}초입니다. 0초부터 ${script.durationSec}초까지 빈틈없이 채우세요.`,
    );

  // 3. 같은 클립은 합계 8초 이하로 읽고, 클립의 같은 구간을 두 번 읽지 않는다.
  const clipKind = (id: string) => (isInfoClipId(id) ? "설명 컷" : "Veo 클립");
  // 조립이 쓰는 같은 계산(shared/clip-offsets.ts assignClipOffsets → firstClipReadConflict)으로 판정한다: 앞 구간이 넘쳐 다음 구간을
  // 이어 읽는 것은 겹침이 아니고(밀어서 읽음), 클립 끝(8초)을 넘는 복제는 이어 읽은 뒤 1초 이내 꼬리만 허용된다.
  // 실측(2026-10-08 작업 7e6c1720): 구간 시작 기준으로만 비교하면 0.1~0.3초 넘침이 전부 "겹침"으로 거부돼 모델이 3회 다 실패했다.
  const slots: ClipCutSlot[] = cuts.map((cut, index) => ({
    index,
    source: cut.source,
    veoClip: cut.veoClip,
    startMs: Math.round(cut.startSec * 1000),
    endMs: Math.round(cut.endSec * 1000),
    phase: cut.phase,
  }));
  // 조립 계산으로 실제 읽기 구간을 구한다. 꼬리 복제가 1초를 넘으면 hard(클립이 모자람). 같은 구간 겹침은 조립이 뒤 컷을 당겨 읽어
  // 그 구간이 잠깐 반복되는 것이라, 1초 이하는 soft(실측 2026-10-09: 2.5초 구간에 3초 컷을 두면 0.5초가 겹친다), 1초 넘으면 hard.
  const offsets = assignClipOffsets(slots, true);
  const readsByClip = new Map<
    string,
    { index: number; start: number; end: number; pad: number }[]
  >();
  for (const slot of slots) {
    const ref = offsets.get(slot.index);
    if (!ref) continue;
    const reads = readsByClip.get(ref.clipId) ?? [];
    reads.push({
      index: slot.index,
      start: ref.offsetMs,
      end: ref.offsetMs + (slot.endMs - slot.startMs) - ref.padMs,
      pad: ref.padMs,
    });
    readsByClip.set(ref.clipId, reads);
  }
  for (const [clipId, reads] of readsByClip) {
    // 합계: 8초 + 허용 겹침(1초)을 넘게 읽으면 어디선가 반복될 수밖에 없다(쌍별 겹침은 작아도).
    const used = reads.reduce((sum, read) => sum + (read.end - read.start) + read.pad, 0);
    if (used > VEO_CLIP_MS + OVERLAP_SOFT_MAX_MS)
      fail(
        `${clipKind(clipId)} ${clipId}에서 ${used / 1000}초를 읽어 같은 구간을 겹쳐 읽습니다(조립 기준). 한 클립은 ${VEO_CLIP_MS / 1000}초뿐이니 컷을 줄이거나 새 클립을 선언하세요.`,
      );
    for (const read of reads)
      if (read.pad > CONTINUOUS_TAIL_PAD_MAX_MS)
        fail(
          `${clipKind(clipId)} ${clipId}의 컷 ${read.index}이 클립의 ${VEO_CLIP_MS / 1000}초 분량을 ${read.pad / 1000}초 넘깁니다(조립 기준). 컷을 줄이거나 다른 구간(phase)으로 옮기거나 새 클립을 선언하세요.`,
        );
    let worst = 0;
    let pair: [number, number] = [0, 0];
    reads.forEach((left, i) => {
      for (const right of reads.slice(i + 1)) {
        const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
        if (overlap > worst) {
          worst = overlap;
          pair = [left.index, right.index];
        }
      }
    });
    if (worst > OVERLAP_SOFT_MAX_MS)
      fail(
        `${clipKind(clipId)} ${clipId}의 컷 ${pair[0]}과 컷 ${pair[1]}이 클립의 같은 구간을 ${worst / 1000}초 겹쳐 읽습니다(조립 기준). 컷을 줄이거나 다른 구간(phase)으로 옮기세요.`,
      );
    else if (worst > 0)
      warn(
        `${clipKind(clipId)} ${clipId}의 컷 ${pair[0]}과 컷 ${pair[1]}이 같은 구간을 ${worst / 1000}초 겹쳐 읽습니다(조립이 뒤 컷을 당겨 그 구간이 잠깐 반복됨).`,
      );
  }

  // 4. 설명 컷은 구간(phase) 하나만 읽고 EXPLAINER_CUT_MAX_SEC 이하.
  cuts.forEach((cut, index) => {
    if (!isExplainerCut(cut)) return;
    if (!isClipPhaseId(cut.phase))
      fail(
        `${cutWhere(cut, index)}에 구간(phase)이 없습니다 — 설명 컷은 early·mid·late 중 하나를 적으세요.`,
      );
    if (cutMs(cut) > limits.EXPLAINER_CUT_MAX_SEC * 1000)
      fail(
        `${cutWhere(cut, index)} 길이 ${cutMs(cut) / 1000}초 — 설명 컷은 ${limits.EXPLAINER_CUT_MAX_SEC}초 이하입니다. 한 구간만 쓰고 컷을 나누세요.`,
      );
  });

  // 5. 개수 상한: Veo 4개(A~D)·정지 이미지 3장·설명 컷 3개.
  if (script.veoClips.length > VEO_SHOTS_MAX)
    fail(`Veo 클립은 영상 1편에 ${VEO_SHOTS_MAX}개까지입니다(A~D).`);
  if (script.stills.length > STILLS_DECLARED_MAX)
    fail(`정지 이미지는 영상 1편에 ${STILLS_DECLARED_MAX}장까지입니다.`);
  if (script.infoClips.length > INFO_CLIPS_MAX)
    fail(`설명 컷은 영상 1편에 ${INFO_CLIPS_MAX}개까지입니다.`);

  // 6. 혼합형: 고통·믿는 원인·결과·행동 문장의 컷은 실사만(승인 이미지는 행동에서만), 첫 컷은 사람·상황이 보이는 실사,
  //    마지막 컷은 실사, 글자 패널(motion_graphic) 컷 금지.
  if (isHybrid(script)) {
    voiceover.forEach((voice, index) => {
      const step = voice.chainStep;
      if (step === "" || step === "bridge" || !HYBRID_LIVE_ONLY_STEPS.includes(step)) return;
      const range = voiceCutRange(voice, cuts);
      if (!range) return;
      for (let cutIndex = range[0]; cutIndex <= range[1]; cutIndex++) {
        const cut = cuts[cutIndex];
        if (!cut) continue;
        if (!isLiveCut(cut) || (cut.source === "approved_image" && step !== "cta"))
          fail(
            `${index + 1}번째 문장(${CHAIN_STEP_LABELS[step]}) "${shorten(voice.text)}"의 ${cutWhere(cut, cutIndex)}은 실사가 아닙니다. 고통·믿는 원인·결과·행동 문장의 컷은 사람·상황이 보이는 실사(Veo 클립 또는 정지 이미지)만 쓰고, 승인 이미지는 행동 문장에서만 씁니다.`,
          );
      }
    });
    cuts.forEach((cut, index) => {
      if (cut.source === "motion_graphic")
        fail(
          `${cutWhere(cut, index)}: 혼합형에서는 글자 패널(motion_graphic) 컷을 쓰지 않습니다. 실사 또는 설명 장면으로 바꾸세요.`,
        );
    });
    const first = cuts[0];
    if (first && first.source !== "motion_graphic" && !isLiveSceneCut(first))
      fail(
        `${cutWhere(first, 0)}: 첫 컷은 사람·상황이 보이는 실사여야 합니다(Veo 클립 또는 정지 이미지).`,
      );
    const lastIndex = cuts.length - 1;
    const last = cuts[lastIndex];
    if (last && last.source !== "motion_graphic" && !isLiveCut(last))
      fail(
        `${cutWhere(last, lastIndex)}: 마지막 컷은 실사여야 합니다(설명 장면으로 끝내지 마세요).`,
      );
  }

  // 7. 비교 설명 장면의 첫 컷(컷 순서상)은 겉이 똑같은 early 구간부터.
  for (const clip of script.infoClips) {
    if (clip.sceneType !== "comparison") continue;
    const firstIndex = cuts.findIndex(
      (cut) => cut.source === "veo_clip" && cut.veoClip === clip.id,
    );
    const firstCut = cuts[firstIndex];
    if (firstCut && firstCut.phase !== "early")
      fail(
        `설명 장면 ${clip.id}(비교)의 첫 컷 ${cutWhere(firstCut, firstIndex)}이 ${firstCut.phase || "단계 없음"} 구간입니다. 비교는 두 모형이 겉으로 똑같아 보이는 early 구간부터 보여 주세요.`,
      );
  }

  // 8. 설명 장면 INFO 문구: 1~4줄, 줄당 24자 이하, 숫자는 사실에 있는 것만. 영문은 explainerSceneProblems(아래)가 거부한다.
  const factNumbers = digitSet((expected.facts ?? []).join(" "));
  for (const clip of script.infoClips) {
    const where = `설명 컷 ${clip.id}`;
    if (clip.infoLines.length < INFO_LINES_MIN || clip.infoLines.length > INFO_LINES_MAX)
      fail(
        `${where}의 INFO 문구가 ${clip.infoLines.length}줄입니다. ${INFO_LINES_MIN}~${INFO_LINES_MAX}줄로 적으세요.`,
      );
    clip.infoLines.forEach((text, index) => {
      if (charCount(text) > INFO_LINE_MAX_CHARS)
        fail(
          `${where}의 INFO 문구 ${index + 1} "${text}"가 ${charCount(text)}자입니다. ${INFO_LINE_MAX_CHARS}자 이하로 줄이세요.`,
        );
      if (factNumbers.size > 0)
        for (const value of digitSet(text))
          if (!factNumbers.has(value))
            fail(
              `${where}의 INFO 문구 ${index + 1} "${text}"에 사실에 없는 숫자(${value})가 있습니다. 자료에 있는 숫자만 쓰세요.`,
            );
    });
  }

  // 9. 실사 프롬프트에 사람·제품·사진 금지 문구를 넣지 않는다.
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
      fail(
        `${prompt.label} 프롬프트에 실사를 지우는 문구("${match[0]}")가 있습니다. 사람·제품·사진 금지는 설명 세계(explainerAnchor)에만 적고 실사 프롬프트에서는 빼세요.`,
      );
  }

  // 10. 설명 컷이 있으면 설명 세계 기준(explainerAnchor)이 있고 브랜드 강조색 이름이 2개 이상.
  if (
    script.infoClips.length > 0 &&
    (isHybrid(script) || script.infoClips.some(isExplainerScene))
  ) {
    if (script.explainerAnchor === "")
      fail(
        "설명 세계의 시각 기준(explainerAnchor: 클레이·화이트 + 브랜드 강조색 2개 + 흰 발광 + 주광, 사람·글자 없음)이 없습니다.",
      );
    else if (explainerAnchorColorCount(script.explainerAnchor) < EXPLAINER_ANCHOR_COLORS_MIN)
      fail(
        `explainerAnchor 에 브랜드 강조색 이름이 ${EXPLAINER_ANCHOR_COLORS_MIN}개 이상 있어야 합니다(예: deep olive, warm gold). INFO·영상 프롬프트의 강조색은 이 기준에서 가져옵니다.`,
      );
  }

  // 11. 문장-컷 길이: 문장을 읽는 시간(NATURAL_CHARS_PER_SEC) + 여유가 묶인 컷의 시간 합계 안에 들어와야 한다.
  if (voiceover.length === 0) fail("음성 트랙(voiceover)이 없습니다. 카피 문장을 컷에 묶으세요.");
  let previousEnd = -1;
  voiceover.forEach((voice, index) => {
    const range = voiceCutRange(voice, cuts);
    if (!range) {
      fail(`${index + 1}번째 문장 "${shorten(voice.text)}"이 가리키는 컷이 없습니다.`);
      return;
    }
    if (range[0] <= previousEnd)
      fail(
        `${index + 1}번째 문장의 컷 범위 [${range[0]}~${range[1]}]가 앞 문장과 겹치거나 순서가 거꾸로입니다. 문장은 컷에 순서대로 겹치지 않게 묶으세요.`,
      );
    previousEnd = Math.max(previousEnd, range[1]);
    const haveMs = cuts.slice(range[0], range[1] + 1).reduce((sum, cut) => sum + cutMs(cut), 0);
    const needMs = estimateSpeechMs([voice.text], undefined, 0) + SPEECH_SLACK_MS;
    if (needMs > haveMs)
      fail(
        `문장 ${index + 1}("${shorten(voice.text)}")은 ${seconds1(needMs)}초가 필요한데 컷[${range[0]}~${range[1]}]은 ${seconds1(haveMs)}초입니다 — 컷을 더 주세요.`,
      );
  });

  // 12. 정지 이미지: 컷 하나 3초 이하, 영상 전체 합계 6초 이하.
  let stillTotalMs = 0;
  cuts.forEach((cut, index) => {
    if (cut.source !== "still_image") return;
    stillTotalMs += cutMs(cut);
    if (cutMs(cut) > STILL_CUT_MAX_MS)
      fail(
        `${cutWhere(cut, index)}은 정지 이미지 ${cutMs(cut) / 1000}초입니다. 정지 이미지 한 컷은 ${STILL_CUT_MAX_MS / 1000}초까지이고 나머지는 실사 움직임으로 보여 주세요.`,
      );
  });
  if (stillTotalMs > STILL_TOTAL_MAX_MS)
    fail(
      `정지 이미지 컷이 합계 ${stillTotalMs / 1000}초입니다. 영상 전체에서 ${STILL_TOTAL_MAX_MS / 1000}초 이하로 줄이고 실사 움직임을 늘리세요.`,
    );

  // 설명 장면 자체의 깨짐(물체·동작·강조 정합, 영문 INFO 문구)은 hard 만 그대로 가져온다.
  for (const problem of explainerSceneProblems(script.infoClips, script.subjects).hard)
    fail(problem);
  return { hard, soft };
}
