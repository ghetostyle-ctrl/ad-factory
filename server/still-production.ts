import type { FlowTexts } from "../shared/flow-texts";
import { cleanKeyframePrompt } from "../shared/veo-prompt";
import { type Still, type StillId, StillIdSchema, type VideoScript } from "../shared/video-script";
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

// phase 'stills': 분위기·상황·장소·사물 컷에 쓸 AI 정지 이미지를 만든다(Veo 대신 이미지 + 카메라 무브).
// 장마다 승인 대표 이미지와 비전 검토(최대 2회). 생성·검토·재개 규칙은 시작 이미지와 같은 엔진을 쓴다.
export type StillProviders = ReviewedImageProviders;
export const STILL_MAX_ATTEMPTS = REVIEWED_IMAGE_MAX_ATTEMPTS;
// R3 깨끗한 키프레임: 고정 문장(STILL_IMAGE_TAIL)과 글자·화살표·수치·라벨·아이콘·강조 링 금지 꼬리(CLEAN_KEYFRAME_TAIL)는
// instructions/flow.md 의 절이다. texts 를 생략하면 지금 파일을 읽는다(재시작 없이 다음 생성부터 반영).
export function stillPrompt(
  script: VideoScript,
  still: Still,
  texts: Pick<FlowTexts, "STILL_IMAGE_TAIL" | "CLEAN_KEYFRAME_TAIL"> = flowTexts(),
): string {
  return cleanKeyframePrompt(
    `${script.styleAnchor}\n${still.prompt}\n${texts.STILL_IMAGE_TAIL}`,
    texts.CLEAN_KEYFRAME_TAIL,
  );
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
