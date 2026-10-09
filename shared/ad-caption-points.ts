import type { Caption } from "./narration-captions";
import type { TimelineCut, TimelineVoice } from "./render-timeline";
import { isInfoClipId, type VideoScript } from "./video-script";

export function adCaptionPoints(
  captions: readonly Caption[],
  script: VideoScript,
  voices: readonly TimelineVoice[],
  cuts: readonly TimelineCut[],
): Caption[] {
  if (script.flow !== "copy_first") return [...captions];
  const picked = new Map<number, string>();
  const live = (caption: Caption) =>
    !cuts.some(
      (cut) =>
        cut.sourceRef.kind === "veo" &&
        isInfoClipId(cut.sourceRef.clipId) &&
        cut.startMs < caption.endMs &&
        caption.startMs < cut.endMs,
    );
  for (const voice of voices) {
    const words = script.voiceover[voice.index]?.callouts.map((callout) => callout.word) ?? [];
    const index = captions.findIndex(
      (caption) =>
        caption.startMs < voice.startMs + voice.durationMs &&
        caption.endMs > voice.startMs &&
        live(caption) &&
        words.some((word) => caption.text.includes(word)),
    );
    const caption = captions[index],
      word = words.find((value) => caption?.text.includes(value));
    if (caption && word && picked.size < 2) picked.set(index, word);
  }
  const last = voices.at(-1);
  const index = captions.findLastIndex(
    (caption) => Boolean(last) && caption.endMs > (last?.startMs ?? Infinity) && live(caption),
  );
  const ending = captions[index];
  if (ending) {
    const word = ending.text.match(/[\p{L}\p{N}]+/u)?.[0];
    if (word) picked.set(index, word);
  }
  return captions.map((caption, i) => {
    const keyword = picked.get(i);
    return keyword ? { ...caption, style: "pop", keyword } : caption;
  });
}
