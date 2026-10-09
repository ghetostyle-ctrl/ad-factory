import { z } from "zod";
import { adCaptionPoints } from "./ad-caption-points";
import { AD_EDIT_STYLE } from "./ad-edit-style";
import { CalloutMotionSchema } from "./callout-motion";
import { assignClipOffsets, type ClipCutSlot, firstClipReadConflict } from "./clip-offsets";
import {
  type ActionSyncError,
  actionSyncError,
  explanationVoiceTiming,
} from "./explanation-timing";

export { assignClipOffsets } from "./clip-offsets";

import { CaptionSchema, textTiming, timelineCaptions } from "./narration-captions";

export { CAPTION_LEAD_MS, CaptionSchema } from "./narration-captions";

import type { ProductionAsset } from "./production-assets";
import { type ClipId, ClipIdSchema } from "./render-state";
import { sha256Hex } from "./sha256";
import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";
import { VisualPolicySchema } from "./video-planning";
import {
  CalloutAnchorSchema,
  CalloutKindSchema,
  CLIP_PHASE_RANGES_MS,
  CutEffectSchema,
  CutPhaseSchema,
  calloutWordIndex,
  GraphicKindSchema,
  isClipPhaseId,
  isInfoClipId,
  StillIdSchema,
  scriptDigestJson,
  VEO_CLIP_MS,
  VIDEO_MAX_SEC,
  VideoCutSchema,
  type VideoScript,
  VOICE_GAP_SEC,
  voiceCutRange,
} from "./video-script";

// 렌더 타임라인: 대본(소수초)과 내레이션 실측 길이(ms)를 합쳐 컷·자막·음성 배치를 ms 단위로 확정한 것.
// voice 단계가 timeline-<n>.json 으로 저장하고 graphics·assemble 단계는 이 파일 하나만 읽는다.

// 기본값(분리 전 상수). 숫자 중 간격·여유·분산·연장은 instructions/thresholds.json 의 임계값이며 buildTimeline 은 timelineDefaults()
// (지금 주입된 값)를 쓴다. maxTempo 는 Typecast audio_tempo 상한과 묶인 코드 고정 값이다.
export const TIMELINE_DEFAULTS = {
  // 문장 사이 최소 간격(대본 검사 rangeCharLimit 가 같은 값을 빼고 글자 수 상한을 계산한다)
  gapMs: Math.round(VOICE_GAP_SEC * 1000),
  // 창을 이만큼 넘는 것은 초과로 보지 않는다
  slackMs: DEFAULT_THRESHOLDS.TIMELINE_SLACK_MS,
  // 재합성 템포 상한(Typecast audio_tempo·설정 ttsTempo 상한과 같다)
  maxTempo: 1.3,
  // 남은 초과를 뒤따르는 컷 하나에 얹을 수 있는 최대치
  maxSpreadMs: DEFAULT_THRESHOLDS.TIMELINE_MAX_SPREAD_MS,
  // 영상 1편의 총 연장 상한
  maxExtendMs: DEFAULT_THRESHOLDS.TIMELINE_MAX_EXTEND_MS,
  // 말이 끝난 뒤 남는 컷 시간 줄이기(silenceTrim). 제작(voice 단계)은 켠다.
  trimSilence: false,
  // 새 기획은 문장 길이에 맞춰 장면을 늘리고, 60초를 넘길 때는 대본 수정을 요청한다.
  naturalTiming: false,
} as const;
// 호출 시점 기본값: 임계값(thresholds.json 주입값)을 반영한 TIMELINE_DEFAULTS. 서버 voice 단계·buildTimeline 이 쓴다.
export function timelineDefaults(): Omit<TimelineOptions, "sources"> {
  const limits = thresholds();
  return {
    ...TIMELINE_DEFAULTS,
    gapMs: Math.round(limits.VOICE_GAP_SEC * 1000),
    slackMs: limits.TIMELINE_SLACK_MS,
    maxSpreadMs: limits.TIMELINE_MAX_SPREAD_MS,
    maxExtendMs: limits.TIMELINE_MAX_EXTEND_MS,
  };
}
export type TimelineOptions = {
  readonly gapMs: number;
  readonly slackMs: number;
  readonly maxTempo: number;
  readonly maxSpreadMs: number;
  readonly maxExtendMs: number;
  readonly trimSilence: boolean;
  readonly naturalTiming: boolean;
  // 컷 소스 파일을 가리키는 이름들. 없으면 빈 이름 + 경고로 타임라인은 만들어진다.
  readonly sources?: TimelineSources;
};
export type TimelineSources = {
  readonly approvedImage?: string;
  readonly cards?: readonly string[];
  readonly projectAssets?: readonly ProductionAsset[];
  // 정지 이미지 ID → 산출물 이름. 내레이션 합성(타임라인 확정) 시점에는 정지 이미지가 아직 없으므로 보통 비어 있고,
  // 조립 단계가 renders[n].stills 에서 파일을 찾는다.
  readonly stills?: Readonly<Record<string, string>>;
};

const WordSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type TimelineWord = z.infer<typeof WordSchema>;
const ms = z.number().int().nonnegative();
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("veo"), clipId: ClipIdSchema, offsetMs: ms, padMs: ms }),
  z.object({ kind: z.literal("image"), artifactName: z.string() }),
  z.object({ kind: z.literal("card"), artifactName: z.string(), slideIndex: ms }),
  z.object({
    kind: z.literal("project"),
    assetId: z.string(),
    startMs: ms,
    audio: z.enum(["keep", "mute"]),
  }),
  // AI 정지 이미지 컷: offsetIndex 는 같은 정지 이미지를 쓰는 컷 중 몇 번째인지(0부터).
  // 조립이 이 값으로 크롭 창과 줌 방향을 정해 같은 이미지를 재사용해도 반복처럼 보이지 않게 한다.
  z.object({
    kind: z.literal("still"),
    stillId: StillIdSchema,
    artifactName: z.string(),
    offsetIndex: ms,
  }),
  z.object({ kind: z.literal("graphic") }),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;
// 대상(인물·제품)이 프레임에서 차지하는 영역(비율). 콜아웃의 subject 앵커·링 크기가 쓴다. 없으면 그리기가 기본 상자를 쓴다.
export const SubjectBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type SubjectBox = z.infer<typeof SubjectBoxSchema>;
// 콜아웃 강조색 수(server/render/theme.ts THEME.colors.accents 와 같다). 콜아웃마다 0→1→2→0 으로 돌려 쓴다.
export const CALLOUT_COLORS = 3;
// 콜아웃(R7) 확정 배치: 문장 어절의 음성 시각(CAPTION_LEAD_MS 선행)에 떠서 그 시각을 담은 컷의 끝까지 남는다.
export const TimelineCalloutSchema = z.object({
  cutIndex: ms,
  text: z.string(),
  kind: CalloutKindSchema,
  anchor: CalloutAnchorSchema,
  color: z
    .number()
    .int()
    .min(0)
    .max(CALLOUT_COLORS - 1),
  startMs: ms,
  endMs: ms,
  targetId: z.string().optional(),
  motion: CalloutMotionSchema.optional(),
});
export type TimelineCallout = z.infer<typeof TimelineCalloutSchema>;
export const TimelineCutSchema = z.object({
  index: ms,
  startMs: ms,
  endMs: ms,
  purpose: VideoCutSchema.shape.purpose,
  source: VideoCutSchema.shape.source,
  effect: CutEffectSchema,
  onScreenText: z.string(),
  caption: CaptionSchema.nullable(),
  graphicKind: GraphicKindSchema,
  graphicLines: z.array(z.string()),
  sourceRef: SourceRefSchema,
  // 장면 계획(2026-10-06) 필드. 예전 타임라인 JSON 에는 없고 기본값도 넣지 않아(optional) 파싱해도 다이제스트가 변하지 않는다.
  // 새 타임라인도 값이 비면(goal ""·phase ""·punchMs 0) 적지 않는다.
  goal: z.string().optional(),
  phase: CutPhaseSchema.optional(),
  // zoom_punch 컷의 펀치인 시점(컷 시작 기준 ms): 콜아웃이 있으면 첫 콜아웃 시각, 없으면 생략(=0, 컷 시작에 펀치인).
  punchMs: ms.optional(),
  subjectBox: SubjectBoxSchema.optional(),
  visualPolicy: VisualPolicySchema.optional(),
});
export type TimelineCut = z.infer<typeof TimelineCutSchema>;
export const TimelineVoiceSchema = z.object({
  index: ms,
  text: z.string(),
  artifactName: z.string(),
  sourceStartMs: ms.optional(),
  startMs: ms,
  durationMs: ms,
  tempo: z.number().positive(),
  words: z.array(WordSchema),
});
export type TimelineVoice = z.infer<typeof TimelineVoiceSchema>;
export const RenderTimelineSchema = z.object({
  number: z.number().int().min(1).max(10),
  durationMs: ms,
  extendedMs: ms,
  scriptDigest: z.string(),
  cuts: z.array(TimelineCutSchema),
  voice: z.array(TimelineVoiceSchema),
  warnings: z.array(z.string()),
  captions: z.array(CaptionSchema).optional(),
  fixedTitle: z.array(z.string()).max(2).optional(),
  disclaimer: z.string().optional(),
  // 콜아웃 배치(없으면 생략). 조립의 captions-<n>.ass 가 그린다.
  callouts: z.array(TimelineCalloutSchema).optional(),
  visualPolicy: VisualPolicySchema.optional(),
});
export type RenderTimeline = z.infer<typeof RenderTimelineSchema>;

// 문장별 합성 실측. attempt 는 재합성 횟수(기본 1): 2 이상이면 다시 재합성을 요구하지 않고 컷을 연장한다.
export type VoiceMeasurement = {
  readonly sourceStartMs?: number;
  readonly index: number;
  readonly durationMs: number;
  readonly tempo: number;
  readonly attempt?: number;
  readonly artifactName?: string;
  readonly words?: readonly TimelineWord[];
};
export type TimelineResult =
  | { readonly timeline: RenderTimeline }
  | { readonly overflow: readonly { readonly index: number; readonly requiredTempo: number }[] }
  | { readonly error: "too_long"; readonly index: number }
  | { readonly error: "clip_too_short"; readonly index: number; readonly clipId: ClipId }
  | ActionSyncError;

// k번째 card_slide 컷은 카드 n장 중 k mod n 번째를 쓴다.
export function cardIndex(k: number, n: number): number {
  return n > 0 ? ((k % n) + n) % n : 0;
}

function appliesTo(asset: ProductionAsset, videoNumber: number): boolean {
  const target = asset.settings.targets;
  return target.mode === "all" || target.videoNumbers.includes(videoNumber);
}
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export type ProjectPickContext = {
  // 영상 전체 길이(ms). 컷 위치로 opening/middle/ending 을 정한다. 없으면 middle 로 본다.
  readonly durationMs?: number;
  // 같은 촬영본을 여러 컷이 쓸 때 누적 사용량(assetId → ms)
  readonly used?: Map<string, number>;
  // 이 컷이 몇 번째 project_clip 컷인지(0부터)
  readonly ordinal?: number;
};
// project_clip 컷에 쓸 촬영본 결정: 제목 정규화 부분일치 → placement 정렬 → k mod n.
// settings.startSec 부터 누적해서 읽고 endSec 을 넘으면 처음으로 되감는다. 후보가 없으면 null.
export function pickProjectAsset(
  cut: { readonly screenComposition: string; readonly startMs: number; readonly endMs: number },
  assets: readonly ProductionAsset[],
  number: number,
  context: ProjectPickContext = {},
): { assetId: string; startMs: number; audio: "keep" | "mute" } | null {
  const candidates = assets.filter((asset) => appliesTo(asset, number));
  if (candidates.length === 0) return null;
  const composition = normalize(cut.screenComposition);
  const byTitle = candidates.filter((asset) => {
    const title = normalize(asset.title);
    return title.length > 0 && composition.includes(title);
  });
  let chosen: ProductionAsset | undefined;
  if (byTitle.length > 0) chosen = byTitle[0];
  else {
    const position = context.durationMs ? cut.startMs / context.durationMs : 0.5;
    const slot = position < 1 / 3 ? "opening" : position >= 2 / 3 ? "ending" : "middle";
    const rank = (asset: ProductionAsset) =>
      asset.settings.placement === slot ? 0 : asset.settings.placement === "auto" ? 1 : 2;
    const sorted = candidates
      .map((asset, order) => ({ asset, order }))
      .sort((left, right) => rank(left.asset) - rank(right.asset) || left.order - right.order)
      .map((item) => item.asset);
    chosen = sorted[cardIndex(context.ordinal ?? 0, sorted.length)];
  }
  if (!chosen) return null;
  const cutMs = cut.endMs - cut.startMs;
  const from = Math.round(chosen.settings.startSec * 1000);
  const limit = Math.round((chosen.settings.endSec ?? chosen.durationSec) * 1000);
  const used = context.used?.get(chosen.id) ?? 0;
  const startMs = from + used + cutMs > limit ? from : from + used;
  context.used?.set(chosen.id, startMs - from + cutMs);
  return { assetId: chosen.id, startMs, audio: chosen.settings.audio };
}

// 무음 줄이기(사용자 결정 2026-10-06): 문장이 묶인 컷 범위가 말보다 길면 범위의 마지막 컷부터 줄여
// 말 끝 + tailMs 에서 다음 컷으로 넘어가게 한다. 컷은 SILENCE_TRIM_MIN_CUT_MS 아래로, 영상은
// SILENCE_TRIM_FLOOR_MS(30초, 대본 길이가 그보다 짧으면 그 길이) 아래로 줄이지 않는다.
// 창이 말보다 짧아지지 않으므로 템포 재합성(유료)·컷 연장이 새로 생기지 않는다. 컷 범위가 없는 예전 대본은 그대로 둔다.
// 2026-10-07(H6·R9, 모든 정책의 새 타임라인): 어제 완성본(8e3aeb37)은 설명 클립 8초를 통째로 틀고 말은 4초였다.
// - 설명 컷(veo I1~I3)은 max(말 끝 + tailMs, 예정 동작 끝 + EXPLAINER_HOLD_MS)까지만 남긴다(컷 예정 길이 안에서).
//   예정 동작 끝 = 동작 싱크 비트의 끝 > 컷 단계(early·mid·late)의 끝 > 단계 없는 컷은 읽는 구간 전체.
//   같은 클립을 뒤 컷이 이어 읽으면 줄이지 않는다(줄이면 뒤 컷의 원본 시각이 밀려 비트가 안 보인다).
//   클립 끝까지 읽는 컷(끝부분 읽기·당겨진 단계)은 줄여도 동작 끝이 그대로이므로 비트가 있으면 두고, 단계만 있으면
//   그 단계 길이까지 줄인다.
// - 단계 없이 8초를 통째로 요구한 설명 컷은 경고하고 late 단계로 잘라 읽는다(hybrid 는 대본 규칙이 먼저 막는다).
// - 문장 사이 무음 상한(SILENCE_GAP_MAX_MS): 범위 밖의 말 없는 컷도 다음 문장 앞에서 줄인다.
// - 예전 immersive 면제(모든 veo 컷 보존, 584c972)는 푼다. 실사 컷(A~H)은 다른 컷과 같이 말 끝 + tailMs 까지 줄인다.
// 아래 세 값은 instructions/thresholds.json 의 임계값 기본값이다. 계산은 thresholds() 의 지금 값을 읽는다(SILENCE_TRIM_FLOOR_MS 는 코드 고정).
export const SILENCE_TRIM_MIN_CUT_MS = DEFAULT_THRESHOLDS.SILENCE_TRIM_MIN_CUT_MS;
export const SILENCE_TRIM_FLOOR_MS = 30_000;
// 설명 컷이 마지막 동작이 끝난 뒤 머무는 최대 시간(R9)
export const EXPLAINER_HOLD_MS = DEFAULT_THRESHOLDS.EXPLAINER_HOLD_MS;
// 문장 사이 무음 상한(H6). tailMs(300) 보다 크므로 범위 컷에는 tailMs 가, 범위 밖 말 없는 컷에는 이 값이 적용된다.
export const SILENCE_GAP_MAX_MS = DEFAULT_THRESHOLDS.SILENCE_GAP_MAX_MS;
const LATE_PHASE_MS = CLIP_PHASE_RANGES_MS.late[1] - CLIP_PHASE_RANGES_MS.late[0];
// 설명 컷: Flow 에서 만든 CLEAN→INFO 설명 클립(I1~I3)을 읽는 veo_clip 컷.
function isInfoCut(cut: Pick<VideoScript["cuts"][number], "source" | "veoClip">): boolean {
  return cut.source === "veo_clip" && isInfoClipId(cut.veoClip);
}
export type SilenceTrimPlan = {
  // 컷별 줄인 시간(ms)
  readonly trim: number[];
  // 8초 통째 컷 → late 단계로 읽는 컷 번호(타임라인 컷의 phase 가 "late" 가 된다)
  readonly lateCuts: ReadonlySet<number>;
  readonly warnings: string[];
};
type SilenceMeasured = ReadonlyMap<
  number,
  Pick<VoiceMeasurement, "durationMs"> & Partial<Pick<VoiceMeasurement, "tempo" | "words">>
>;
export function silenceTrim(
  script: Pick<VideoScript, "cuts" | "voiceover" | "infoClips"> & {
    readonly flow?: VideoScript["flow"];
  },
  measured: SilenceMeasured,
  gapMs: number,
  tailMs: number,
  readInfoFromStart = false,
  maxSilenceMs?: number,
): number[] {
  return silenceTrimPlan(script, measured, gapMs, tailMs, readInfoFromStart, maxSilenceMs).trim;
}
export function silenceTrimPlan(
  script: Pick<VideoScript, "cuts" | "voiceover" | "infoClips"> & {
    readonly flow?: VideoScript["flow"];
  },
  measured: SilenceMeasured,
  gapMs: number,
  tailMs: number,
  // 단계 없는 설명 컷을 처음부터 읽는지(새 기획, buildTimeline 의 naturalTiming). 예전 설명 컷은 끝부분을 읽는다.
  readInfoFromStart = false,
  // 문장 사이 무음 상한. 생략하면 임계값(SILENCE_GAP_MAX_MS)의 지금 값.
  maxSilenceMs: number = thresholds().SILENCE_GAP_MAX_MS,
): SilenceTrimPlan {
  // 설명 컷 보유·컷 최소 길이도 호출 때의 임계값을 읽는다.
  const { EXPLAINER_HOLD_MS: holdMs, SILENCE_TRIM_MIN_CUT_MS: minCutMs } = thresholds();
  const cuts = script.cuts;
  const trim = cuts.map(() => 0);
  const lateCuts = new Set<number>();
  const warnings: string[] = [];
  const plan: SilenceTrimPlan = { trim, lateCuts, warnings };
  if (script.voiceover.length === 0 || script.voiceover.some((line) => line.fromCut < 0))
    return plan;
  const length = cuts.map((cut) => Math.round((cut.endSec - cut.startSec) * 1000));
  const total = length.reduce((sum, value) => sum + value, 0);
  let budget =
    script.flow === "copy_first"
      ? total
      : Math.max(0, total - Math.min(SILENCE_TRIM_FLOOR_MS, total));
  const startOf = (k: number) =>
    length.slice(0, k).reduce((sum, value, i) => sum + value - (trim[i] ?? 0), 0);
  const ranges = script.voiceover.map((line) => voiceCutRange(line, cuts));
  // 동작 싱크 문장이 읽는 설명 컷과, 동작 앞의 컷(도입). 도입은 줄이지 않고 마지막 동작 컷은 보유 하한까지만 줄인다.
  const syncedReads = new Set<number>();
  const protectedCuts = new Set<number>();
  for (const [index, line] of script.voiceover.entries()) {
    const range = ranges[index];
    if (!line.actionSync || !range) continue;
    const reads: number[] = [];
    for (let k = range[0]; k <= range[1]; k++) {
      const cut = cuts[k];
      if (cut?.source === "veo_clip" && cut.veoClip === line.actionSync.clipId) reads.push(k);
    }
    for (const k of reads) syncedReads.add(k);
    const lastActionCut = reads.at(-1);
    const through = lastActionCut === undefined ? range[1] : lastActionCut - 1;
    for (let k = range[0]; k <= through; k++) protectedCuts.add(k);
  }
  for (const [k, cut] of cuts.entries()) {
    if (!isInfoCut(cut) || isClipPhaseId(cut.phase) || (length[k] ?? 0) < VEO_CLIP_MS) continue;
    if (syncedReads.has(k))
      warnings.push(
        `컷 ${k + 1}: 설명 클립 ${cut.veoClip}을 8초 통째로 읽습니다. 동작 싱크가 걸려 있어 그대로 두니 새 대본은 단계(early·mid·late)를 나누세요.`,
      );
    else {
      lateCuts.add(k);
      warnings.push(
        `컷 ${k + 1}: 설명 클립 ${cut.veoClip}을 8초 통째로 요구해 late 단계(${LATE_PHASE_MS / 1000}초)만 씁니다.`,
      );
    }
  }
  const slotsOf = (): ClipCutSlot[] =>
    cuts.map((cut, index) => ({
      index,
      source: cut.source,
      veoClip: cut.veoClip,
      phase: lateCuts.has(index) ? "late" : cut.phase,
      startMs: startOf(index),
      endMs: startOf(index + 1),
    }));
  // 설명 컷이 머물러야 하는 최소 길이(ms): 예정 동작 끝 + 보유. 같은 클립을 뒤 컷이 이어 읽으면 현재 길이 그대로.
  const actionHoldMs = (k: number, current: number): number => {
    const cut = cuts[k];
    if (!cut) return 0;
    const clipId = cut.veoClip;
    const labels = script.infoClips.find((clip) => clip.id === clipId)?.labelLayer;
    if (
      !labels &&
      cuts.some((other, j) => j > k && other.source === "veo_clip" && other.veoClip === clipId)
    )
      return current;
    const slots = slotsOf();
    const ref = assignClipOffsets(slots, readInfoFromStart).get(k);
    if (!ref) return current;
    const readEnd = ref.offsetMs + current - ref.padMs;
    if (labels) {
      const ready = labels.labels.map(
        (label) => Math.max(label.fullSec, label.startSec + AD_EDIT_STYLE.label.growSec) * 1000,
      );
      const needed = ready
        .filter((at) => at >= ref.offsetMs && at < readEnd)
        .map((at) => at + 1120 - ref.offsetMs);
      return Math.min(current, Math.max(0, ...needed));
    }
    // 끝을 1ms 줄였을 때 읽기 시작이 움직이면 클립 끝까지 읽는 컷이다: 줄여도 동작 끝은 그대로 클립 끝이다.
    const shortened = slots.map((slot) =>
      slot.index === k ? { ...slot, endMs: slot.endMs - 1 } : slot,
    );
    const tailRead =
      (assignClipOffsets(shortened, readInfoFromStart).get(k)?.offsetMs ?? ref.offsetMs) !==
      ref.offsetMs;
    let beatEnd = -1;
    for (const [index, line] of script.voiceover.entries()) {
      const range = ranges[index];
      const sync = line.actionSync;
      if (!sync || sync.clipId !== clipId || !range || k < range[0] || k > range[1]) continue;
      const beat = script.infoClips
        .find((clip) => clip.id === clipId)
        ?.explanation?.beats.find((item) => item.id === sync.beatId);
      if (!beat) continue;
      const sourceStart = Math.round(beat.startProgress * VEO_CLIP_MS);
      const sourceEnd = Math.round(beat.endProgress * VEO_CLIP_MS);
      if (sourceEnd <= ref.offsetMs || sourceStart >= readEnd) continue;
      if (sourceEnd > readEnd || tailRead) return current;
      beatEnd = Math.max(beatEnd, sourceEnd);
    }
    if (beatEnd >= 0) return Math.min(current, beatEnd - ref.offsetMs + holdMs);
    const phase = slots[k]?.phase ?? "";
    if (isClipPhaseId(phase)) {
      const [phaseStart, phaseEnd] = CLIP_PHASE_RANGES_MS[phase];
      if (tailRead)
        return Math.min(current, Math.max(0, readEnd - Math.max(ref.offsetMs, phaseStart)));
      return Math.min(current, Math.max(0, phaseEnd - ref.offsetMs) + holdMs);
    }
    // 단계 없는 컷: 처음부터 읽는 새 기획은 읽는 구간 전체가 동작이고, 끝부분을 읽는 예전 설명 컷은 끝에서 완성된다.
    return readInfoFromStart ? current : 0;
  };
  // 컷 k 의 하한. 설명 컷은 동작 보유와(말이 그 컷에서 끝나면) 말 끝 + tailMs 까지 머문다.
  const floorOf = (k: number, voiceEnd: number): number => {
    const cut = cuts[k];
    if (!cut || !isInfoCut(cut)) return minCutMs;
    const current = (length[k] ?? 0) - (trim[k] ?? 0);
    const cutStart = startOf(k);
    const voiceTail =
      cutStart <= voiceEnd && voiceEnd < cutStart + current ? voiceEnd + tailMs - cutStart : 0;
    return Math.max(minCutMs, actionHoldMs(k, current), voiceTail);
  };
  let previousEnd = -gapMs;
  for (const [index, line] of script.voiceover.entries()) {
    const item = measured.get(index);
    const range = ranges[index];
    if (!item || !range) continue;
    const [from, to] = range;
    let start = Math.max(startOf(from), previousEnd + gapMs);
    if (line.actionSync) {
      const slots = slotsOf();
      const sync = explanationVoiceTiming({
        script,
        index,
        voice: {
          index,
          text: line.text,
          artifactName: "",
          startMs: 0,
          durationMs: item.durationMs,
          tempo: item.tempo ?? 1,
          words: [...(item.words ?? [])],
        },
        slots,
        offsets: assignClipOffsets(slots, readInfoFromStart),
        previousEnd,
        gapMs,
      });
      if ("error" in sync) return plan;
      start = sync.startMs;
    }
    const end = start + item.durationMs;
    const take = (k: number, excess: number): number => {
      if (protectedCuts.has(k)) return 0;
      const room = (length[k] ?? 0) - (trim[k] ?? 0) - floorOf(k, end);
      const amount = Math.min(Math.max(0, room), excess, budget);
      trim[k] = (trim[k] ?? 0) + amount;
      budget -= amount;
      return amount;
    };
    // 범위 컷: 마지막 컷부터 줄여 말 끝 + tailMs 에서 다음 컷으로 넘어간다.
    let excess = startOf(to + 1) - (end + tailMs);
    for (let k = to; k >= from && excess > 0 && budget > 0; k--) excess -= take(k, excess);
    // 범위 밖의 말 없는 컷(다음 문장 앞): 문장 사이 무음 상한까지 줄인다. 마지막 문장 뒤의 엔딩은 그대로 둔다.
    const nextFrom = ranges[index + 1]?.[0];
    if (nextFrom !== undefined && nextFrom > to + 1) {
      let gap = startOf(nextFrom) - (end + maxSilenceMs);
      for (let k = nextFrom - 1; k > to && gap > 0 && budget > 0; k--) gap -= take(k, gap);
    }
    previousEnd = end;
  }
  return plan;
}

export function timelineDigest(timeline: RenderTimeline): string {
  return sha256Hex(JSON.stringify(timeline));
}

// 기존 대본 규칙: 컷 시간 고정 → 문장 start = max(그 문장이 묶인 첫 컷의 시작(예전 대본은 적힌 startSec), 이전 끝+gap)
// → 창(묶인 마지막 컷의 끝, +slack) 초과 문장은 overflow 반환(호출자가 템포 재합성 후 재호출) → 재합성 뒤에도
// 남는 초과는 그 문장이 묶인 컷들(마지막 컷부터 거꾸로)에 먼저, 그다음 뒤따르는 컷들에 maxSpreadMs 씩 분산
// (motion_graphic 컷은 건너뛴다) → 총 연장 maxExtendMs·전체 VIDEO_MAX_SEC 초과 또는 받을 컷이 없으면 too_long.
// naturalTiming은 음성이 끝날 때까지 해당 장면을 유지한다(모션그래픽 포함). 템포를 올리지 않고 60초까지만 연장한다.
// 기존 대본은 모션그래픽 합계·각 컷 길이가 대본 값 그대로이고, 전체가 늘어나므로 모션그래픽 비율(40% 상한)은
// 연장 뒤에도 대본 때보다 커지지 않는다. 문장이 자기 컷에서 시작하므로 말과 그림이 어긋나지 않는다.
export function buildTimeline(
  script: VideoScript,
  measurements: readonly VoiceMeasurement[],
  options: Partial<TimelineOptions> = {},
): TimelineResult {
  const settings = {
    ...timelineDefaults(),
    ...(script.flow === "copy_first"
      ? { gapMs: AD_EDIT_STYLE.pacing.gapMs, slackMs: AD_EDIT_STYLE.pacing.tailMs }
      : {}),
    ...options,
  };
  const cuts = script.cuts;
  const extension = cuts.map(() => 0);
  const measured = new Map(measurements.map((item) => [item.index, item]));
  // 말이 끝난 뒤 남는 컷 시간을 줄인다(음수 연장). 이렇게 하지 않으면 정수 초 컷 때문에 문장 뒤마다 1~4초 무음이 생겼다.
  // 8초를 통째로 요구한 설명 컷은 같은 계획이 late 단계로 바꾼다(lateCuts).
  const plan: SilenceTrimPlan = settings.trimSilence
    ? silenceTrimPlan(script, measured, settings.gapMs, settings.slackMs, settings.naturalTiming)
    : { trim: cuts.map(() => 0), lateCuts: new Set<number>(), warnings: [] };
  const phaseOf = (index: number): string =>
    plan.lateCuts.has(index) ? "late" : (cuts[index]?.phase ?? "");
  const slotsOf = (): ClipCutSlot[] => {
    let cursor = 0;
    return cuts.map((cut, index) => {
      const startMs = cursor;
      const endMs =
        startMs + Math.round((cut.endSec - cut.startSec) * 1000) + (extension[index] ?? 0);
      cursor = endMs;
      return {
        index,
        source: cut.source,
        veoClip: cut.veoClip,
        startMs,
        endMs,
        phase: phaseOf(index),
      };
    });
  };
  // 원래 ms → 연장 반영 ms: 그 시점 이전에 끝나는 컷들의 연장분만큼 밀린다.
  const mapTime = (value: number) =>
    value +
    cuts.reduce(
      (sum, cut, index) =>
        Math.round(cut.endSec * 1000) <= value ? sum + (extension[index] ?? 0) : sum,
      0,
    );
  // 문장이 묶인 컷 범위(예전 대본은 시간에서 유도). 컷이 없으면 [0, 0].
  const rangeOf = (line: VideoScript["voiceover"][number]): readonly [number, number] =>
    voiceCutRange(line, cuts) ?? [0, 0];
  for (const [index, value] of plan.trim.entries()) extension[index] = -value;
  const trimmedMs = plan.trim.reduce((sum, value) => sum + value, 0);
  const overflow: { index: number; requiredTempo: number }[] = [];
  const voice: TimelineVoice[] = [];
  const baseMs = Math.round(script.durationSec * 1000) - trimmedMs;
  let totalExtension = 0;
  let previousEnd = -settings.gapMs;
  for (const [index, line] of script.voiceover.entries()) {
    const item = measured.get(index);
    if (!item) throw new RangeError(`문장 ${index + 1}의 합성 실측이 없습니다.`);
    const [from, to] = rangeOf(line);
    // 새 대본은 묶인 첫 컷의 시작에 문장을 건다(따로 적은 시작 시점이 없다). 예전 대본은 적힌 시간을 그대로 쓴다.
    const bound = line.fromCut >= 0;
    const plannedStart = bound ? (cuts[from]?.startSec ?? line.startSec) : line.startSec;
    const plannedEnd = bound ? (cuts[to]?.endSec ?? line.endSec) : line.endSec;
    let startMs = Math.max(mapTime(Math.round(plannedStart * 1000)), previousEnd + settings.gapMs);
    if (line.actionSync) {
      const slots = slotsOf();
      const sync = explanationVoiceTiming({
        script,
        index,
        voice: {
          index,
          text: line.text,
          artifactName: item.artifactName ?? "",
          startMs: 0,
          durationMs: item.durationMs,
          tempo: item.tempo,
          words: [...(item.words ?? [])],
        },
        slots,
        offsets: assignClipOffsets(slots, settings.naturalTiming),
        previousEnd,
        gapMs: settings.gapMs,
      });
      if ("error" in sync) return sync;
      startMs = sync.startMs;
    }
    const windowEnd = mapTime(Math.round(plannedEnd * 1000));
    let endMs = startMs + item.durationMs;
    const excess = endMs - windowEnd - (settings.naturalTiming ? 0 : settings.slackMs);
    if (excess > 0 && settings.naturalTiming) {
      // 다음 장면에 시간을 얹으면 말과 화면이 갈라진다. 말이 묶인 마지막 장면만 유지한다.
      extension[to] = (extension[to] ?? 0) + excess;
      totalExtension += excess;
      if (baseMs + totalExtension > VIDEO_MAX_SEC * 1000) return { error: "too_long", index };
    } else if (excess > 0) {
      const available = Math.max(1, windowEnd - startMs);
      const needed = (item.tempo * item.durationMs) / available;
      if ((item.attempt ?? 1) < 2 && item.tempo < settings.maxTempo && needed > item.tempo) {
        overflow.push({
          index,
          requiredTempo: Math.min(settings.maxTempo, Math.ceil(needed * 100) / 100),
        });
        // 재합성으로 창에 맞는다고 보고 뒤 문장 계산을 이어간다.
        endMs = windowEnd;
      } else {
        let remaining = excess;
        // 받을 컷 순서: 이 문장이 묶인 컷들(마지막 컷부터 거꾸로, 말이 끝나는 그림을 더 오래 보여 준다) → 뒤따르는 컷들.
        const order = [
          ...Array.from({ length: to - from + 1 }, (_, offset) => to - offset),
          ...Array.from({ length: cuts.length - to - 1 }, (_, offset) => to + 1 + offset),
        ];
        for (const k of order) {
          if (remaining <= 0) break;
          // 모션그래픽 컷은 늘리지 않는다: 대본이 지킨 전체 40% 상한과 컷 1~2초 상한이 연장으로 깨지지 않게
          // 남은 초과는 실사·이미지 컷으로 넘기고, 받을 컷이 없으면 아래에서 too_long 이 된다.
          if (cuts[k]?.source === "motion_graphic") continue;
          const room = settings.maxSpreadMs - (extension[k] ?? 0);
          if (room <= 0) continue;
          const add = Math.min(room, remaining);
          extension[k] = (extension[k] ?? 0) + add;
          remaining -= add;
          totalExtension += add;
        }
        if (
          remaining > 0 ||
          totalExtension > settings.maxExtendMs ||
          baseMs + totalExtension > VIDEO_MAX_SEC * 1000
        )
          return { error: "too_long", index };
      }
    }
    voice.push({
      index,
      text: line.text,
      artifactName: item.artifactName ?? "",
      ...(item.sourceStartMs !== undefined ? { sourceStartMs: item.sourceStartMs } : {}),
      startMs,
      durationMs: item.durationMs,
      tempo: item.tempo,
      words: [...(item.words ?? [])],
    });
    previousEnd = endMs;
  }
  if (overflow.length > 0) return { overflow };
  // Slack may delay an internal cut, but must never let the final word fall outside the video.
  const tailOverflow = previousEnd - baseMs - totalExtension;
  if (tailOverflow > 0) {
    const voiceIndex = voice.at(-1)?.index ?? 0;
    if (
      totalExtension + tailOverflow > settings.maxExtendMs ||
      baseMs + totalExtension + tailOverflow > VIDEO_MAX_SEC * 1000
    )
      return { error: "too_long", index: voiceIndex };
    const lastLine = script.voiceover[voiceIndex];
    const firstBoundCut = lastLine ? rangeOf(lastLine)[0] : cuts.length;
    let remaining = tailOverflow;
    // Only stretch cuts at or after this sentence's anchor; previous voice starts stay fixed.
    for (let index = cuts.length - 1; index >= firstBoundCut && remaining > 0; index--) {
      if (cuts[index]?.source === "motion_graphic") continue;
      const room = settings.maxSpreadMs - (extension[index] ?? 0);
      const add = Math.min(Math.max(0, room), remaining);
      extension[index] = (extension[index] ?? 0) + add;
      totalExtension += add;
      remaining -= add;
    }
    if (remaining > 0) return { error: "too_long", index: voiceIndex };
  }

  const warnings: string[] = [...plan.warnings];
  const durationMs = baseMs + totalExtension;
  for (const [index, item] of voice.entries()) {
    const previous = voice[index - 1];
    if (
      previous &&
      item.startMs - previous.startMs - previous.durationMs > AD_EDIT_STYLE.pacing.maxGapMs
    )
      warnings.push(
        `문장 ${index + 1} 앞 공백이 ${item.startMs - previous.startMs - previous.durationMs}ms입니다. 동작/컷 조건으로 남은 구간이므로 최종 편집에서 확인하세요.`,
      );
  }
  const slots = slotsOf();
  const offsets = assignClipOffsets(slots, settings.naturalTiming);
  for (const item of voice) {
    if (!script.voiceover[item.index]?.actionSync) continue;
    const previous = voice[item.index - 1];
    const sync = explanationVoiceTiming({
      script,
      index: item.index,
      voice: item,
      slots,
      offsets,
      previousEnd: previous ? previous.startMs + previous.durationMs : -settings.gapMs,
      gapMs: settings.gapMs,
    });
    if ("error" in sync) return sync;
    if (sync.startMs !== item.startMs) return actionSyncError(item.index, "source_changed");
    if (sync.warning) warnings.push(sync.warning);
  }
  const conflict = settings.naturalTiming ? firstClipReadConflict(slots, offsets) : null;
  if (conflict) {
    const index = script.voiceover.findIndex((line) => {
      const [from, to] = rangeOf(line);
      return from <= conflict.cutIndex && conflict.cutIndex <= to;
    });
    return { error: "clip_too_short", index: Math.max(0, index), clipId: conflict.clipId };
  }
  const callouts = script.infoClips.some((clip) => clip.labelLayer)
    ? []
    : timelineCallouts(script, voice, slots);
  // zoom_punch 컷의 펀치인 시점(R8): 콜아웃이 있으면 첫 콜아웃 시각까지 1.0 으로 기다린다. 없으면 0(컷 시작).
  const punchMsOf = (index: number, startMs: number): number => {
    const first = Math.min(
      ...callouts.filter((callout) => callout.cutIndex === index).map((callout) => callout.startMs),
    );
    return Number.isFinite(first) ? Math.max(0, first - startMs) : 0;
  };
  const sources = settings.sources ?? {};
  const cards = sources.cards ?? [];
  const projectAssets = sources.projectAssets ?? [];
  const used = new Map<string, number>();
  let cardOrdinal = 0;
  let projectOrdinal = 0;
  const stillOrdinals = new Map<string, number>();
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const timelineCuts: TimelineCut[] = cuts.map((cut, index) => {
    const slot = slots[index];
    if (!slot) throw new RangeError("컷 배열이 어긋났습니다.");
    // 자막은 이 컷에서 시작하는 문장(묶인 범위의 첫 컷이 이 컷인 문장)보다 CAPTION_LEAD_MS 먼저 뜬다.
    const anchor =
      voice.find((item) => {
        const line = script.voiceover[item.index];
        return line !== undefined && rangeOf(line)[0] === index;
      })?.startMs ?? slot.startMs;
    // 모션그래픽 컷은 화면 자체가 글줄을 그리므로 자막을 겹쳐 올리지 않는다.
    const caption: TimelineCut["caption"] =
      cut.onScreenText && cut.source !== "motion_graphic"
        ? {
            text: cut.onScreenText,
            startMs: Math.max(0, Math.min(anchor, slot.endMs - 1) - thresholds().CAPTION_LEAD_MS),
            endMs: slot.endMs,
            style: cut.effect === "text_pop" ? "pop" : "bottom",
          }
        : null;
    let sourceRef: SourceRef;
    switch (cut.source) {
      case "veo_clip": {
        const offset = offsets.get(index);
        if (offset) sourceRef = { kind: "veo", ...offset };
        else {
          warn(`컷 ${index + 1}: veo_clip 컷에 클립 ID가 없어 대표 이미지로 대체합니다.`);
          sourceRef = { kind: "image", artifactName: sources.approvedImage ?? "" };
        }
        break;
      }
      case "card_slide": {
        const slideIndex = cardIndex(cardOrdinal++, cards.length);
        if (cards.length === 0) warn("카드뉴스 이미지가 없어 card_slide 컷 이름이 비어 있습니다.");
        sourceRef = { kind: "card", artifactName: cards[slideIndex] ?? "", slideIndex };
        break;
      }
      case "project_clip": {
        const picked = pickProjectAsset(
          { screenComposition: cut.screenComposition, startMs: slot.startMs, endMs: slot.endMs },
          projectAssets,
          script.number,
          { durationMs, used, ordinal: projectOrdinal++ },
        );
        if (picked) sourceRef = { kind: "project", ...picked };
        else {
          warn(`컷 ${index + 1}: 쓸 수 있는 촬영본이 없어 대표 이미지로 대체합니다.`);
          sourceRef = { kind: "image", artifactName: sources.approvedImage ?? "" };
        }
        break;
      }
      case "still_image": {
        const stillId = StillIdSchema.safeParse(cut.stillId);
        if (!stillId.success) {
          warn(`컷 ${index + 1}: still_image 컷에 정지 이미지 ID가 없어 대표 이미지로 대체합니다.`);
          sourceRef = { kind: "image", artifactName: sources.approvedImage ?? "" };
          break;
        }
        const offsetIndex = stillOrdinals.get(stillId.data) ?? 0;
        stillOrdinals.set(stillId.data, offsetIndex + 1);
        sourceRef = {
          kind: "still",
          stillId: stillId.data,
          artifactName: sources.stills?.[stillId.data] ?? "",
          offsetIndex,
        };
        break;
      }
      case "motion_graphic":
        sourceRef = { kind: "graphic" };
        break;
      case "approved_image":
        if (!sources.approvedImage)
          warn("대표 이미지 이름이 없어 approved_image 컷 이름이 비어 있습니다.");
        sourceRef = { kind: "image", artifactName: sources.approvedImage ?? "" };
        break;
      default:
        return cut.source satisfies never;
    }
    const punchMs = cut.effect === "zoom_punch" ? punchMsOf(index, slot.startMs) : 0;
    const phase = phaseOf(index);
    return {
      index,
      startMs: slot.startMs,
      endMs: slot.endMs,
      purpose: cut.purpose,
      source: cut.source,
      effect: cut.effect,
      onScreenText: cut.onScreenText,
      caption,
      graphicKind: cut.graphicKind,
      graphicLines: [...cut.graphicLines],
      sourceRef,
      ...(cut.goal ? { goal: cut.goal } : {}),
      ...(isClipPhaseId(phase) ? { phase } : {}),
      ...(punchMs > 0 ? { punchMs } : {}),
      ...(script.planning?.visualPolicy ? { visualPolicy: script.planning.visualPolicy } : {}),
    };
  });
  return {
    timeline: {
      number: script.number,
      durationMs,
      extendedMs: totalExtension,
      scriptDigest: sha256Hex(scriptDigestJson(script)),
      cuts: timelineCuts,
      voice,
      warnings,
      captions: adCaptionPoints(timelineCaptions(voice, timelineCuts), script, voice, timelineCuts),
      ...(script.fixedTitle.length ? { fixedTitle: script.fixedTitle } : {}),
      ...(script.disclaimer ? { disclaimer: script.disclaimer } : {}),
      ...(callouts.length ? { callouts } : {}),
      ...(script.planning?.visualPolicy ? { visualPolicy: script.planning.visualPolicy } : {}),
    },
  };
}

// 콜아웃(R7) 배치: 문장 안 어절(word)의 음성 시각(자막과 같은 textTiming: 단어 시각 보간, 어긋나면 글자 수 비례)에서
// CAPTION_LEAD_MS 앞당겨 뜨고, 그 시각을 담은 컷(문장이 묶인 범위 안)의 끝까지 남는다. 어절을 못 찾으면 문장 시작.
// 색은 영상 전체에서 뜨는 순서대로 팔레트 3색을 돌려 쓴다. 콜아웃이 없는 예전 대본은 [].
// 설명 컷(I1~I3) 위에는 그리지 않는다(H7, 2026-10-07): 설명 세계의 글자는 자막 한 줄뿐이다. INFO 프레임이 가진
// 이름표와 앱 콜아웃이 겹치던 문제(be958ae 의 annotations 대조)도 이 규칙이 함께 막는다.
export function timelineCallouts(
  script: Pick<VideoScript, "cuts" | "voiceover">,
  voice: readonly TimelineVoice[],
  slots: readonly { readonly index: number; readonly startMs: number; readonly endMs: number }[],
): TimelineCallout[] {
  const placed: Omit<TimelineCallout, "color">[] = [];
  for (const item of voice) {
    const line = script.voiceover[item.index];
    if (!line || line.callouts.length === 0) continue;
    const [from, to] = voiceCutRange(line, script.cuts) ?? [0, 0];
    const text = item.text.replace(/\s+/g, " ").trim();
    const timeAt = textTiming(item, text);
    const tokens = text.split(" ");
    for (const callout of line.callouts) {
      const token = calloutWordIndex(callout.word, text);
      const found = token >= 0 ? -1 : text.indexOf(callout.word);
      const offset =
        token >= 0
          ? [...tokens.slice(0, token).join(" ")].length + (token > 0 ? 1 : 0)
          : found >= 0
            ? [...text.slice(0, found)].length
            : 0;
      const wordMs = item.startMs + timeAt(offset);
      const range = slots.slice(from, to + 1);
      const slot =
        range.find((candidate) => wordMs >= candidate.startMs && wordMs < candidate.endMs) ??
        (wordMs < (range[0]?.startMs ?? 0) ? range[0] : range[range.length - 1]) ??
        slots[0];
      if (!slot) continue;
      const cut = script.cuts[slot.index];
      if (cut && isInfoCut(cut)) continue;
      placed.push({
        cutIndex: slot.index,
        text: callout.text,
        kind: callout.kind,
        anchor: callout.anchor,
        startMs: Math.max(slot.startMs, wordMs - thresholds().CAPTION_LEAD_MS),
        endMs: slot.endMs,
        ...(callout.targetId ? { targetId: callout.targetId } : {}),
      });
    }
  }
  // 키 순서는 TimelineCalloutSchema 와 같게 둔다: 저장(JSON.stringify)과 다시 읽기(zod parse)의 다이제스트가 같아야 조립이 받는다.
  return placed
    .sort((left, right) => left.startMs - right.startMs)
    .map((callout, order) => ({
      cutIndex: callout.cutIndex,
      text: callout.text,
      kind: callout.kind,
      anchor: callout.anchor,
      color: order % CALLOUT_COLORS,
      startMs: callout.startMs,
      endMs: callout.endMs,
      ...(callout.targetId ? { targetId: callout.targetId } : {}),
    }));
}
