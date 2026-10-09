import type { ClipCutSlot } from "./clip-offsets";
import { textTiming } from "./narration-captions";
import type { ClipId } from "./render-state";
import type { TimelineVoice } from "./render-timeline";
import { VEO_CLIP_MS, type VideoScript, voiceCutRange } from "./video-script";

export type ActionSyncReason =
  | "missing_beat"
  | "missing_cue"
  | "unmeasured_cue"
  | "action_not_visible"
  | "voice_before_window"
  | "voice_overlap"
  | "voice_after_window"
  | "source_changed";
export type ActionSyncError = {
  readonly error: "action_sync";
  readonly index: number;
  readonly reason: ActionSyncReason;
  readonly message: string;
};

export function actionSyncError(index: number, reason: ActionSyncReason): ActionSyncError {
  const details: Record<ActionSyncReason, string> = {
    missing_beat: "연결한 설명 동작을 찾지 못했습니다. 대본의 클립·동작 연결을 확인하세요.",
    missing_cue:
      "동작과 맞출 말이 문장에 없거나 여러 번 나옵니다. 동작의 내레이션 구절을 하나로 지정하세요.",
    unmeasured_cue:
      "단어별 음성 시각을 확인할 수 없습니다. 단어 시각이 있는 음성으로 동작 싱크를 다시 확인하세요.",
    action_not_visible:
      "설명 동작의 시작부터 끝까지 해당 문장의 컷에서 연속으로 보이지 않습니다. 원본 읽기 구간과 컷 범위를 수정하세요.",
    voice_before_window:
      "동작과 말을 맞추려면 문장이 담당 장면보다 먼저 시작해야 합니다. 동작 시작을 늦추거나 앞말을 줄이세요.",
    voice_overlap: "동작과 말을 맞추면 앞 문장과 겹칩니다. 문장 간격이나 동작 시작을 조정하세요.",
    voice_after_window:
      "동작과 말을 맞추면 문장이 담당 장면을 넘습니다. 대사를 줄이거나 담당 장면을 나누세요.",
    source_changed:
      "다른 문장의 컷 연장으로 설명 동작의 원본 시각이 달라졌습니다. 컷 길이와 동작 연결을 조정하세요.",
  };
  return { error: "action_sync", index, reason, message: `문장 ${index + 1}: ${details[reason]}` };
}

// textTiming may estimate captions when word timing is missing. A locked action cue cannot use that fallback.
function hasMeasuredText(voice: TimelineVoice, text: string): boolean {
  if (voice.words.length === 0) return false;
  let cursor = 0;
  let previousMs = 0;
  for (const word of voice.words) {
    const token = word.text.replace(/\s+/g, " ").trim();
    const at = token ? text.indexOf(token, cursor) : -1;
    const startMs = Math.round(word.start * 1000);
    const endMs = Math.round(word.end * 1000);
    if (
      at < 0 ||
      /[\p{L}\p{N}]/u.test(text.slice(cursor, at)) ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < previousMs ||
      endMs <= startMs ||
      endMs > voice.durationMs + 50
    )
      return false;
    cursor = at + token.length;
    previousMs = endMs;
  }
  return !/[\p{L}\p{N}]/u.test(text.slice(cursor));
}

type Offsets = ReadonlyMap<
  number,
  { readonly clipId: ClipId; readonly offsetMs: number; readonly padMs: number }
>;

export function explanationVoiceTiming(input: {
  readonly script: Pick<VideoScript, "cuts" | "voiceover" | "infoClips">;
  readonly index: number;
  readonly voice: TimelineVoice;
  readonly slots: readonly ClipCutSlot[];
  readonly offsets: Offsets;
  readonly previousEnd: number;
  readonly gapMs: number;
}): { readonly startMs: number; readonly warning?: string } | ActionSyncError {
  const { script, index, voice, slots, offsets, previousEnd, gapMs } = input;
  const line = script.voiceover[index];
  const sync = line?.actionSync;
  const beat = script.infoClips
    .find((clip) => clip.id === sync?.clipId)
    ?.explanation?.beats.find((item) => item.id === sync?.beatId);
  if (!line || !sync || !beat) return actionSyncError(index, "missing_beat");
  const text = voice.text.replace(/\s+/g, " ").trim();
  const cue = beat.narrationCue.replace(/\s+/g, " ").trim();
  const cueAt = cue ? text.indexOf(cue) : -1;
  if (cueAt < 0 || text.indexOf(cue, cueAt + 1) >= 0) return actionSyncError(index, "missing_cue");
  if (!hasMeasuredText(voice, text)) return actionSyncError(index, "unmeasured_cue");
  const range = voiceCutRange(line, script.cuts);
  if (!range) return actionSyncError(index, "action_not_visible");
  const owned = slots.slice(range[0], range[1] + 1);
  const sourceStart = Math.round(beat.startProgress * VEO_CLIP_MS);
  const sourceEnd = Math.round(beat.endProgress * VEO_CLIP_MS);
  let coveredUntil = sourceStart;
  let actionMs: number | undefined;
  let timelineEnd: number | undefined;
  for (const slot of owned) {
    const ref = offsets.get(slot.index);
    if (!ref || ref.clipId !== sync.clipId) {
      if (actionMs !== undefined && coveredUntil < sourceEnd) break;
      continue;
    }
    const readEnd = ref.offsetMs + slot.endMs - slot.startMs - ref.padMs;
    if (actionMs === undefined) {
      if (ref.offsetMs > sourceStart || readEnd <= sourceStart) continue;
      actionMs = slot.startMs + sourceStart - ref.offsetMs;
    } else if (ref.offsetMs !== coveredUntil || slot.startMs !== timelineEnd) break;
    coveredUntil = readEnd;
    timelineEnd = slot.endMs;
    if (coveredUntil >= sourceEnd) break;
  }
  if (actionMs === undefined || coveredUntil < sourceEnd)
    return actionSyncError(index, "action_not_visible");
  const cueOffsetMs = textTiming(voice, text)([...text.slice(0, cueAt)].length);
  let startMs = actionMs - cueOffsetMs;
  const ownedStartMs = owned[0]?.startMs ?? 0;
  let warning: string | undefined;
  if (startMs < ownedStartMs) {
    const firstWord = voice.words[0];
    const leadingSilenceMs = Math.round((firstWord?.start ?? 0) * 1000);
    const firstToken = firstWord?.text.replace(/\s+/g, " ").trim() ?? "";
    const residualMs = ownedStartMs - startMs;
    if (
      !firstToken ||
      cueAt !== text.indexOf(firstToken) ||
      cueOffsetMs !== leadingSilenceMs ||
      residualMs > leadingSilenceMs
    )
      return actionSyncError(index, "voice_before_window");
    startMs = ownedStartMs;
    warning = `문장 ${index + 1}: 실측 선행 무음 ${leadingSilenceMs}ms를 유지해 동작 싱크 구절이 예정 동작보다 ${residualMs}ms 늦게 시작합니다.`;
  }
  if (startMs < previousEnd + gapMs) return actionSyncError(index, "voice_overlap");
  if (startMs + voice.durationMs > (owned.at(-1)?.endMs ?? 0))
    return actionSyncError(index, "voice_after_window");
  return { startMs, ...(warning ? { warning } : {}) };
}
