import { type Still, type StillId, StillIdSchema, type VideoScript } from "../shared/video-script";
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

// phase 'stills': 분위기·상황·장소·사물 컷에 쓸 AI 정지 이미지를 만든다(Veo 대신 이미지 + 카메라 무브).
// 장마다 승인 대표 이미지와 비전 검토(최대 2회). 생성·검토·재개 규칙은 시작 이미지와 같은 엔진을 쓴다.
export type StillProviders = ReviewedImageProviders;
export const STILL_MAX_ATTEMPTS = REVIEWED_IMAGE_MAX_ATTEMPTS;
export function stillPrompt(script: VideoScript, still: Still): string {
  return `${script.styleAnchor}\n${still.prompt}\nPortrait 9:16 photographic still, natural lighting, realistic. The same product, person, place and lighting as the reference image where they appear. No text overlays, added promotional copy, captions or new logos. Preserve visible existing product labels and packaging.`;
}

function isStillKey(key: string): key is StillId {
  return StillIdSchema.safeParse(key).success;
}
const spec: ReviewedImageSpec = {
  phase: "stills",
  noun: "정지 이미지",
  label: (key) => `정지 이미지 ${key}`,
  imageName: renderNames.still,
  reviewName: renderNames.stillReview,
  read: (render, key) => (isStillKey(key) ? render?.stills[key] : undefined),
  write: (render, key, state) => {
    if (isStillKey(key)) render.stills[key] = state;
  },
};

export class StillProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  readonly providers: StillProviders;
  private readonly engine: ReviewedImageEngine;
  constructor(
    readonly store: JobStore,
    providers?: StillProviders,
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
      items: script.stills.map((still) => ({
        key: still.id,
        prompt: stillPrompt(script, still),
        intent: still.prompt,
      })),
    });
  }
}
