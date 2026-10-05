import { wrapCaption } from "./script-repair";
import { bindVoiceover, cutNarration, type VideoScript } from "./video-script";

export type ScriptEditInput = {
  readonly voiceover: readonly { readonly index: number; readonly text: string }[];
  readonly captions: readonly { readonly cutIndex: number; readonly onScreenText: string }[];
};

// The API validates edit indexes before calling this shared browser/server normalization.
export function applyScriptEdit(current: VideoScript, edit: ScriptEditInput): VideoScript {
  const voiceover = bindVoiceover(
    current.voiceover.map((voice, index) => {
      const change = edit.voiceover.find((item) => item.index === index);
      return change ? { ...voice, text: change.text.trim() } : voice;
    }),
    current.cuts,
    current.durationSec,
  );
  const narration = cutNarration(current.cuts, voiceover);
  return {
    ...current,
    voiceover,
    cuts: current.cuts.map((cut, index) => {
      const caption = edit.captions.find((item) => item.cutIndex === index);
      return {
        ...cut,
        onScreenText: caption ? wrapCaption(caption.onScreenText.trim()).text : cut.onScreenText,
        narration: narration[index] ?? "",
      };
    }),
  };
}
