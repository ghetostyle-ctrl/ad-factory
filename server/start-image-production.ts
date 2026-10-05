import { type ClipId, ClipIdSchema } from "../shared/render-state";
import type { VeoClip, VideoScript } from "../shared/video-script";
import type { Artifacts } from "./artifacts";
import type { AutomationGuard } from "./automation-guard";
import { renderNames, scriptOf } from "./render-state-helpers";
import {
  defaultReviewedImageProviders,
  REVIEWED_IMAGE_MAX_ATTEMPTS,
  ReviewedImageEngine,
  type ReviewedImageProviders,
  type ReviewedImageSpec,
} from "./reviewed-image-production";
import type { JobStore } from "./store";

// phase 'startImages': Veo 클립마다 시작 이미지를 만들고 승인 대표 이미지와 비교 검토(클립당 최대 2회).
// 생성·검토·재개 규칙은 정지 이미지(still-production.ts)와 같은 엔진(reviewed-image-production.ts)을 쓴다.
export type StartImageProviders = ReviewedImageProviders;
export const START_IMAGE_MAX_ATTEMPTS = REVIEWED_IMAGE_MAX_ATTEMPTS;
export function startImagePrompt(script: VideoScript, clip: VeoClip): string {
  return `${script.styleAnchor}\n${clip.startImagePrompt}\nPortrait 9:16 frame. Same product, same person, same place and lighting as the reference image where they appear. No added promotional text, captions or logos. Preserve visible existing product labels and packaging.`;
}

const spec: ReviewedImageSpec = {
  phase: "startImages",
  noun: "시작 이미지",
  label: (key) => `클립 ${key} 시작 이미지`,
  imageName: renderNames.startImage,
  reviewName: renderNames.startReview,
  read: (render, key) => (isClipId(key) ? render?.startImages[key] : undefined),
  write: (render, key, state) => {
    if (isClipId(key)) render.startImages[key] = state;
  },
};
function isClipId(key: string): key is ClipId {
  return ClipIdSchema.safeParse(key).success;
}

export class StartImageProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  readonly providers: StartImageProviders;
  private readonly engine: ReviewedImageEngine;
  constructor(
    readonly store: JobStore,
    providers?: StartImageProviders,
  ) {
    this.providers = providers ?? defaultReviewedImageProviders(store);
    this.engine = new ReviewedImageEngine(store, this.providers, spec);
    this.assets = this.engine.assets;
    this.guard = this.engine.guard;
  }
  async run(id: string, number: number, signal: AbortSignal): Promise<void> {
    const script = scriptOf(this.guard.check(id, signal), number);
    await this.engine.run(id, number, signal, {
      hypothesisId: script.hypothesisId,
      styleAnchor: script.styleAnchor,
      items: script.veoClips.map((clip) => ({
        key: clip.id,
        prompt: startImagePrompt(script, clip),
        intent: clip.startImagePrompt,
      })),
    });
  }
}
