import type { TimelineCut } from "../../shared/render-timeline";
import { STILL_MAX_SEC } from "../../shared/video-script";

export type RenderCutInput = {
  readonly cut: TimelineCut;
  readonly sourcePath: string | null;
  readonly sourceDigest: string;
  readonly cleanClip?: boolean;
};
type Background = { readonly path: string; readonly digest: string };

export function graphicBackgrounds(inputs: readonly RenderCutInput[]): RenderCutInput[] {
  const exposure = new Map<string, number>();
  for (const input of inputs) {
    if (input.cut.sourceRef.kind !== "still" || !input.sourcePath) continue;
    exposure.set(
      input.sourceDigest,
      (exposure.get(input.sourceDigest) ?? 0) + input.cut.endMs - input.cut.startMs,
    );
  }
  let photograph: Background | null = null;
  return inputs.map((input) => {
    switch (input.cut.sourceRef.kind) {
      case "still":
        photograph = input.sourcePath
          ? { path: input.sourcePath, digest: input.sourceDigest }
          : null;
        return input;
      case "graphic": {
        if (photograph) {
          const total =
            (exposure.get(photograph.digest) ?? 0) + input.cut.endMs - input.cut.startMs;
          if (total <= STILL_MAX_SEC * 1000) exposure.set(photograph.digest, total);
          else photograph = null;
        }
        const background = photograph;
        return {
          ...input,
          sourcePath: background?.path ?? null,
          sourceDigest: background?.digest ?? "none",
        };
      }
      case "image":
      case "card":
      case "veo":
      case "project":
        photograph = null;
        return input;
      default:
        return input.cut.sourceRef satisfies never;
    }
  });
}
