import type { FlowTexts } from "../shared/flow-texts";
import { type ClipId, ClipIdSchema } from "../shared/render-state";
import { cleanKeyframePrompt } from "../shared/veo-prompt";
import type { VeoClip, VideoScript } from "../shared/video-script";
import type { Artifacts } from "./artifacts";
import type { AutomationGuard } from "./automation-guard";
import { flowTexts } from "./flow-instructions";
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
// R3 깨끗한 키프레임: 고정 문장(START_IMAGE_TAIL)과 글자·화살표·수치·라벨·아이콘·강조 링 금지 꼬리(CLEAN_KEYFRAME_TAIL)는
// instructions/flow.md 의 절이다. texts 를 생략하면 지금 파일을 읽는다(재시작 없이 다음 생성부터 반영).
export function startImagePrompt(
  script: VideoScript,
  clip: VeoClip,
  texts: Pick<FlowTexts, "START_IMAGE_TAIL" | "CLEAN_KEYFRAME_TAIL"> = flowTexts(),
): string {
  return cleanKeyframePrompt(
    `${script.styleAnchor}\n${clip.startImagePrompt}\n${texts.START_IMAGE_TAIL}`,
    texts.CLEAN_KEYFRAME_TAIL,
  );
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
