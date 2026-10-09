import type { ClipId } from "./render-state";
import {
  CLIP_PHASE_RANGES_MS,
  isClipPhaseId,
  isInfoClipId,
  VEO_CLIP_MS,
  type VideoScript,
} from "./video-script";

export type ClipCutSlot = {
  readonly index: number;
  readonly source: VideoScript["cuts"][number]["source"];
  readonly veoClip: VideoScript["cuts"][number]["veoClip"];
  readonly startMs: number;
  readonly endMs: number;
  // 컷이 읽는 클립 구간(장면 계획 대본의 veo_clip 컷: early|mid|late). 없거나 "" 이면 예전 순차 읽기.
  readonly phase?: string;
};
type ClipRead = { readonly start: number; readonly end: number; readonly phase: string };

// 같은 클립을 참조하는 컷은 대본 순서대로 클립의 연속 구간을 쓴다. 8초를 넘는 부분은 마지막 프레임 복제(padMs).
// 구간(phase)이 있는 컷(R6)은 CLIP_PHASE_RANGES_MS 의 구간 시작에서 읽되, 같은 구간을 이미 읽었거나 앞 구간의 컷이
// 이 구간 시작을 넘어 이어 읽었으면 그 끝에서 잇는다(같은 장면을 두 번 보여 주지 않는다). 클립 끝(8초)을 넘으면
// 끝에 맞춰 당긴다(대본 규칙이 거부하는 경우라 타임라인 연장으로 조금 넘친 때만 온다). Flow 클립 길이 검사(clip-need.ts)도
// 이 함수를 쓰므로 조립과 같은 구간을 본다.
// 연속 읽기가 클립 끝에 닿은 뒤 마지막 프레임을 멈춰 둘 수 있는 최대 꼬리(설명 컷 보유 1초와 같다).
export const CONTINUOUS_TAIL_PAD_MAX_MS = 1000;
export function assignClipOffsets(
  cuts: readonly ClipCutSlot[],
  readInfoFromStart = false,
): Map<number, { clipId: ClipId; offsetMs: number; padMs: number }> {
  const used = new Map<ClipId, number>();
  const reads = new Map<ClipId, ClipRead[]>();
  const result = new Map<number, { clipId: ClipId; offsetMs: number; padMs: number }>();
  for (const cut of cuts) {
    if (cut.source !== "veo_clip" || cut.veoClip === "") continue;
    const clipId = cut.veoClip;
    const durationMs = cut.endMs - cut.startMs;
    const phase = cut.phase ?? "";
    let offset: number;
    if (isClipPhaseId(phase)) {
      const [phaseStart] = CLIP_PHASE_RANGES_MS[phase];
      // 같은 구간을 다시 쓰는 컷이나 앞 구간에서 넘쳐 들어온 읽기가 있으면 그 끝에서 잇는다.
      let pushedBy: ClipRead | null = null;
      for (const read of reads.get(clipId) ?? [])
        if (
          (read.phase === phase || read.start < phaseStart) &&
          read.end > (pushedBy?.end ?? phaseStart)
        )
          pushedBy = read;
      offset = Math.max(phaseStart, pushedBy?.end ?? phaseStart);
      // 앞 단계(다른 phase)를 이어 읽어 시작점이 밀린 연속 재생은 뒤로 당기지 않는다 — 당기면 앞 컷과 같은 구간을
      // 다시 읽어 충돌(clip_too_short)이 난다. 남는 시간은 마지막 프레임을 멈춰 채운다(padMs). 실측 2026-10-08:
      // 설명 컷 early 가 말 길이로 3.35초가 되자 mid·late 가 8초를 넘겨 막혔다. 같은 phase 를 두 번 쓰는 예전 컷은
      // 전처럼 8초 안으로 당긴다(복제 없음).
      const continuous = pushedBy !== null && pushedBy.phase !== phase && offset > phaseStart;
      if (!continuous && offset + durationMs > VEO_CLIP_MS)
        offset = Math.max(0, VEO_CLIP_MS - durationMs);
    } else {
      // 예전 설명 컷은 끝부분을 읽는다. 새 기획은 그래픽이 나타나는 과정부터 보여 준다.
      offset =
        isInfoClipId(clipId) && !readInfoFromStart
          ? (used.get(clipId) ?? Math.max(0, VEO_CLIP_MS - durationMs))
          : (used.get(clipId) ?? 0);
    }
    const readable = Math.max(0, Math.min(durationMs, VEO_CLIP_MS - offset));
    result.set(cut.index, {
      clipId,
      offsetMs: Math.min(offset, VEO_CLIP_MS),
      padMs: durationMs - readable,
    });
    reads.set(clipId, [
      ...(reads.get(clipId) ?? []),
      { start: offset, end: offset + readable, phase },
    ]);
    used.set(clipId, Math.max(used.get(clipId) ?? 0, offset + durationMs));
  }
  return result;
}

// 대본 승인 전 검사와 음성 실측 후 검사가 같은 소스 구간을 비교한다.
export function firstClipReadConflict(
  cuts: readonly ClipCutSlot[],
  offsets: ReadonlyMap<
    number,
    { readonly clipId: ClipId; readonly offsetMs: number; readonly padMs: number }
  >,
): { readonly cutIndex: number; readonly clipId: ClipId } | null {
  const reads = new Map<ClipId, { start: number; end: number }[]>();
  for (const cut of cuts) {
    const ref = offsets.get(cut.index);
    if (!ref) continue;
    const end = ref.offsetMs + cut.endMs - cut.startMs;
    const prior = reads.get(ref.clipId) ?? [];
    // 복제(padMs)는 클립이 모자란다는 뜻이라 충돌로 본다. 다만 앞 단계를 이어 읽어 클립 끝(8초)까지 다 쓴 뒤
    // 마지막 프레임을 EXPLAINER_HOLD 한도 안에서 멈추는 꼬리는 허용한다(설명 장면의 완성 상태를 잠깐 더 보여 주는 것).
    const reachesEnd = ref.offsetMs + (end - ref.offsetMs - ref.padMs) === VEO_CLIP_MS;
    const tailHold = ref.padMs > 0 && reachesEnd && ref.padMs <= CONTINUOUS_TAIL_PAD_MAX_MS;
    if (
      (ref.padMs > 0 && !tailHold) ||
      prior.some((read) => ref.offsetMs < read.end && end > read.start)
    )
      return { cutIndex: cut.index, clipId: ref.clipId };
    reads.set(ref.clipId, [...prior, { start: ref.offsetMs, end }]);
  }
  return null;
}
