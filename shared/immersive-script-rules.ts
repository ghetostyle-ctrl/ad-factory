import { assignClipOffsets, firstClipReadConflict } from "./clip-offsets";
import type { VideoScript } from "./video-script";
import { isInfoClipId, voiceCutRange, voicePurposeOf } from "./video-script";

export function immersiveExplanationProblems(
  script: VideoScript,
  infoClipsAllowed: boolean | undefined,
): string[] {
  if (script.planning?.visualPolicy !== "immersive_explanations_v1" || infoClipsAllowed === false)
    return [];
  const declared = new Set(script.infoClips.map((clip) => clip.id));
  const usesInfo = (cut: VideoScript["cuts"][number]) =>
    cut.source === "veo_clip" && isInfoClipId(cut.veoClip) && declared.has(cut.veoClip);
  const problems: string[] = [];

  if (
    script.planning.concept.scenePlan?.some((scene) => scene.source === "info_clip") &&
    !script.cuts.some(usesInfo)
  )
    problems.push(
      "기획에서 정한 3D 설명 영상이 대본에서 빠졌습니다. I1~I3를 선언하고 설명 문장의 컷에 연결하세요.",
    );
  script.voiceover.forEach((voice, index) => {
    const explains =
      voicePurposeOf(voice, script.cuts) === "mechanism" ||
      ["real_cause", "requirement", "reason_why"].includes(voice.chainStep);
    if (!explains) return;
    const range = voiceCutRange(voice, script.cuts);
    if (!range || !script.cuts.slice(range[0], range[1] + 1).some(usesInfo))
      problems.push(
        `${index + 1}번째 설명 문장은 움직이는 3D 인포그래픽(I1~I3) 컷이 필요합니다. 평면 글자·체크리스트·정지 이미지로 대신하지 마세요.`,
      );
  });
  return problems;
}

export function immersiveClipReadProblems(script: VideoScript): string[] {
  if (script.planning?.visualPolicy !== "immersive_explanations_v1") return [];
  const slots = script.cuts.map((cut, index) => ({
    index,
    source: cut.source,
    veoClip: cut.veoClip,
    phase: cut.phase,
    startMs: Math.round(cut.startSec * 1000),
    endMs: Math.round(cut.endSec * 1000),
  }));
  const conflict = firstClipReadConflict(slots, assignClipOffsets(slots, true));
  return conflict
    ? [
        `컷 ${conflict.cutIndex}의 클립 ${conflict.clipId} 구간이 다른 컷과 겹쳐 읽히거나 원본 길이를 넘습니다. 같은 원본의 시간 범위를 겹치지 않게 고치세요.`,
      ]
    : [];
}
