import { z } from "zod";
import { CAPTION_LEAD_MS, CaptionSchema, timelineCaptions } from "./narration-captions";

export { CAPTION_LEAD_MS, CaptionSchema } from "./narration-captions";

import type { ProductionAsset } from "./production-assets";
import { type ClipId, ClipIdSchema } from "./render-state";
import { sha256Hex } from "./sha256";
import {
  CutEffectSchema,
  GraphicKindSchema,
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

export const TIMELINE_DEFAULTS = {
  // 문장 사이 최소 간격(대본 검사 rangeCharLimit 가 같은 값을 빼고 글자 수 상한을 계산한다)
  gapMs: Math.round(VOICE_GAP_SEC * 1000),
  // 창을 이만큼 넘는 것은 초과로 보지 않는다
  slackMs: 300,
  // 재합성 템포 상한(Typecast audio_tempo·설정 ttsTempo 상한과 같다)
  maxTempo: 1.3,
  // 남은 초과를 뒤따르는 컷 하나에 얹을 수 있는 최대치
  maxSpreadMs: 500,
  // 영상 1편의 총 연장 상한
  maxExtendMs: 3000,
} as const;
export type TimelineOptions = {
  readonly gapMs: number;
  readonly slackMs: number;
  readonly maxTempo: number;
  readonly maxSpreadMs: number;
  readonly maxExtendMs: number;
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
});
export type TimelineCut = z.infer<typeof TimelineCutSchema>;
export const TimelineVoiceSchema = z.object({
  index: ms,
  text: z.string(),
  artifactName: z.string(),
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
});
export type RenderTimeline = z.infer<typeof RenderTimelineSchema>;

// 문장별 합성 실측. attempt 는 재합성 횟수(기본 1): 2 이상이면 다시 재합성을 요구하지 않고 컷을 연장한다.
export type VoiceMeasurement = {
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
  | { readonly error: "too_long"; readonly index: number };

type CutSlot = {
  readonly index: number;
  readonly source: VideoScript["cuts"][number]["source"];
  readonly veoClip: VideoScript["cuts"][number]["veoClip"];
  readonly startMs: number;
  readonly endMs: number;
};

// 같은 클립을 참조하는 컷은 대본 순서대로 클립의 연속 구간을 쓴다. 8초를 넘는 부분은 마지막 프레임 복제(padMs).
export function assignClipOffsets(
  cuts: readonly CutSlot[],
): Map<number, { clipId: ClipId; offsetMs: number; padMs: number }> {
  const used = new Map<ClipId, number>();
  const result = new Map<number, { clipId: ClipId; offsetMs: number; padMs: number }>();
  for (const cut of cuts) {
    if (cut.source !== "veo_clip" || cut.veoClip === "") continue;
    const clipId = cut.veoClip;
    const durationMs = cut.endMs - cut.startMs;
    const offset = used.get(clipId) ?? 0;
    const readable = Math.max(0, Math.min(durationMs, VEO_CLIP_MS - offset));
    result.set(cut.index, {
      clipId,
      offsetMs: Math.min(offset, VEO_CLIP_MS),
      padMs: durationMs - readable,
    });
    used.set(clipId, offset + durationMs);
  }
  return result;
}

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

export function timelineDigest(timeline: RenderTimeline): string {
  return sha256Hex(JSON.stringify(timeline));
}

// 규칙: 컷 시간 고정 → 문장 start = max(그 문장이 묶인 첫 컷의 시작(예전 대본은 적힌 startSec), 이전 끝+gap)
// → 창(묶인 마지막 컷의 끝, +slack) 초과 문장은 overflow 반환(호출자가 템포 재합성 후 재호출) → 재합성 뒤에도
// 남는 초과는 그 문장이 묶인 컷들(마지막 컷부터 거꾸로)에 먼저, 그다음 뒤따르는 컷들에 maxSpreadMs 씩 분산
// (motion_graphic 컷은 건너뛴다) → 총 연장 maxExtendMs·전체 VIDEO_MAX_SEC 초과 또는 받을 컷이 없으면 too_long.
// 그래서 모션그래픽 합계·각 컷 길이는 대본 값 그대로이고, 전체가 늘어나므로 모션그래픽 비율(40% 상한)은
// 연장 뒤에도 대본 때보다 커지지 않는다. 문장이 자기 컷에서 시작하므로 말과 그림이 어긋나지 않는다.
export function buildTimeline(
  script: VideoScript,
  measurements: readonly VoiceMeasurement[],
  options: Partial<TimelineOptions> = {},
): TimelineResult {
  const settings = { ...TIMELINE_DEFAULTS, ...options };
  const cuts = script.cuts;
  const extension = cuts.map(() => 0);
  const measured = new Map(measurements.map((item) => [item.index, item]));
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
  const overflow: { index: number; requiredTempo: number }[] = [];
  const voice: TimelineVoice[] = [];
  const baseMs = Math.round(script.durationSec * 1000);
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
    const startMs = Math.max(
      mapTime(Math.round(plannedStart * 1000)),
      previousEnd + settings.gapMs,
    );
    const windowEnd = mapTime(Math.round(plannedEnd * 1000));
    let endMs = startMs + item.durationMs;
    const excess = endMs - windowEnd - settings.slackMs;
    if (excess > 0) {
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

  const warnings: string[] = [];
  const durationMs = baseMs + totalExtension;
  let cursor = 0;
  const slots: CutSlot[] = cuts.map((cut, index) => {
    const startMs = cursor;
    const endMs =
      startMs + Math.round((cut.endSec - cut.startSec) * 1000) + (extension[index] ?? 0);
    cursor = endMs;
    return { index, source: cut.source, veoClip: cut.veoClip, startMs, endMs };
  });
  const offsets = assignClipOffsets(slots);
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
            startMs: Math.max(0, Math.min(anchor, slot.endMs - 1) - CAPTION_LEAD_MS),
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
      captions: timelineCaptions(voice, timelineCuts),
      ...(script.fixedTitle.length ? { fixedTitle: script.fixedTitle } : {}),
      ...(script.disclaimer ? { disclaimer: script.disclaimer } : {}),
    },
  };
}
