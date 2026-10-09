import type { ClipId } from "../../shared/render-state";
import { assignClipOffsets, type TimelineCut } from "../../shared/render-timeline";
import { usesNaturalTiming, VEO_CLIP_MS, type VideoScript } from "../../shared/video-script";
import { readPlan } from "./segments";

// 컷들이 Veo 클립 하나에서 실제로 읽는 끝 지점(ms). 클립이 이보다 짧으면 `-ss offset -t read` 가
// 말없이 짧거나 빈 세그먼트를 만들어 영상 트랙이 내레이션보다 먼저 끝난다(오디오는 무음으로 채워져 검증도 통과).
// 조립(segments.ts veoSegmentArgs)과 같은 readPlan 을 써서 읽는 구간이 어긋나지 않게 한다.
export function clipNeedMsFromTimeline(cuts: readonly TimelineCut[], clipId: ClipId): number {
  let need = 0;
  for (const cut of cuts) {
    if (cut.sourceRef.kind !== "veo" || cut.sourceRef.clipId !== clipId) continue;
    const plan = readPlan(cut, cut.sourceRef.padMs);
    need = Math.max(need, cut.sourceRef.offsetMs + plan.readMs);
  }
  return Math.min(need, VEO_CLIP_MS);
}
// 타임라인이 아직 없을 때(내레이션 합성 전 선업로드)는 대본의 정수초 컷으로 같은 값을 계산한다.
// 타임라인에서 컷이 늘어날 수 있으므로 하한이다(조립 직전에 타임라인 기준으로 한 번 더 검사한다).
export function clipNeedMsFromScript(script: VideoScript, clipId: ClipId): number {
  let cursor = 0;
  const slots = script.cuts.map((cut, index) => {
    const startMs = cursor;
    const endMs = startMs + (cut.endSec - cut.startSec) * 1000;
    cursor = endMs;
    return {
      index,
      source: cut.source,
      veoClip: cut.veoClip,
      startMs,
      endMs,
      effect: cut.effect,
      // 구간(phase)이 있는 컷은 구간 시작에서 읽으므로(R6) 같은 함수에 넘겨야 조립과 같은 끝 지점이 나온다.
      phase: cut.phase,
    };
  });
  const offsets = assignClipOffsets(slots, usesNaturalTiming(script));
  let need = 0;
  for (const slot of slots) {
    const placed = offsets.get(slot.index);
    if (placed?.clipId !== clipId) continue;
    need = Math.max(need, placed.offsetMs + readPlan(slot, placed.padMs).readMs);
  }
  return Math.min(need, VEO_CLIP_MS);
}
