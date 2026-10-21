import type { TimelineCut } from "../../shared/render-timeline";
import { STILL_MAX_SEC } from "../../shared/video-script";

export type RenderCutInput = {
  readonly cut: TimelineCut;
  readonly sourcePath: string | null;
  readonly sourceDigest: string;
  readonly cleanClip?: boolean;
  // 작용 원리 컷(2026-10-21)의 아래쪽 실사: Veo/Flow 클립(구간 offsetMs 부터) 또는 대표 이미지. 위쪽 그림은 sourcePath.
  readonly bottom?: {
    readonly path: string;
    readonly digest: string;
    readonly video: boolean;
    readonly offsetMs: number;
    readonly cleanClip?: boolean;
  } | null;
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
      case "screen":
      case "mechanism":
        photograph = null;
        return input;
      default:
        return input.cut.sourceRef satisfies never;
    }
  });
}
