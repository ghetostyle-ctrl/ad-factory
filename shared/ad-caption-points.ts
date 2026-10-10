import { captionDirectionFor, supportedCaptionIcon } from "./caption-direction";
import type { Caption } from "./narration-captions";
import type { TimelineCut, TimelineVoice } from "./render-timeline";
import { isInfoClipId, type VideoScript } from "./video-script";

export function adCaptionPoints(
  captions: readonly Caption[],
  script: VideoScript,
  voices: readonly TimelineVoice[],
  cuts: readonly TimelineCut[],
): Caption[] {
  if (script.flow !== "copy_first" && !script.voiceover.some((voice) => voice.captionDirection))
    return [...captions];
  const info = (caption: Caption) =>
    cuts.some(
      (cut) =>
        cut.sourceRef.kind === "veo" &&
        isInfoClipId(cut.sourceRef.clipId) &&
        cut.startMs < caption.endMs &&
        caption.startMs < cut.endMs,
    );
  let legacyPoints = 0;
  return captions.map((caption) => {
    if (info(caption)) {
      const { keyword: _keyword, ...rest } = caption;
      return { ...rest, style: "bottom", tone: "plain", icon: "none", placement: "lower" };
    }
    const voice = voices.reduce<TimelineVoice | undefined>((best, candidate) => {
      const overlap = (value: TimelineVoice) =>
        Math.max(
          0,
          Math.min(caption.endMs, value.startMs + value.durationMs) -
            Math.max(caption.startMs, value.startMs),
        );
      return overlap(candidate) > (best ? overlap(best) : 0) ? candidate : best;
    }, undefined);
    const line = voice ? script.voiceover[voice.index] : undefined;
    if (!line) return { ...caption, tone: "plain", icon: "none", placement: "lower" };
    const direction = captionDirectionFor(line);
    const requested = line.captionDirection
      ? direction.keyword
      : (line.callouts.find((callout) => caption.text.includes(callout.word))?.word ??
        caption.keyword ??
        "");
    const keyword = requested && caption.text.includes(requested) ? requested : "";
    const ending = voice === voices.at(-1);
    const point = direction.tone === "impact" || Boolean(keyword && legacyPoints < 2);
    if (keyword && !line.captionDirection && !ending) legacyPoints += 1;
    const { keyword: _oldKeyword, ...rest } = caption;
    return {
      ...rest,
      tone: direction.tone,
      placement: "chest",
      style: point ? "pop" : "bottom",
      ...(keyword ? { keyword } : {}),
      icon: supportedCaptionIcon(direction.icon, keyword),
    };
  });
}
