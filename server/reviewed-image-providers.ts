import type { ModelResult } from "../shared/models";
import type { ImageReview } from "../shared/planning";
import type { Job } from "../shared/schema";
import { BlockedError } from "./errors";
import { FlowImageProduction } from "./flow-image-production";
import type { ImageOptions } from "./image-provider";
import { Intelligence, type StartImageReviewTask } from "./intelligence";
import { sceneImagePrompt } from "./scene-image-references";
import type { JobStore } from "./store";

export type ReviewedImageProviders = {
  readonly image: (
    job: Job,
    prompt: string,
    signal: AbortSignal,
    options?: ImageOptions,
  ) => Promise<ModelResult<Uint8Array>>;
  readonly reviewStartImage: (task: StartImageReviewTask) => Promise<ModelResult<ImageReview>>;
};

export function defaultReviewedImageProviders(store: JobStore): ReviewedImageProviders {
  const intelligence = new Intelligence(store.root);
  return {
    image: (job, prompt, signal, options) => {
      if (!job.executionModels) throw new BlockedError("실행 모델 스냅샷이 없습니다.");
      return new FlowImageProduction(store).image({
        job,
        prompt: sceneImagePrompt(prompt, options?.referenceImages?.length ?? 0),
        signal,
        ...(options ? { options } : {}),
      });
    },
    reviewStartImage: intelligence.reviewStartImage.bind(intelligence),
  };
}

import { HTTPError } from "ky";

export class ReviewedImageGenerator {
  private portraitSupported = true;
  constructor(private readonly image: ReviewedImageProviders["image"]) {}

  async generate(input: {
    readonly job: Job;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly referenceImages: readonly Uint8Array[];
    readonly target: NonNullable<ImageOptions["target"]>;
  }): Promise<ModelResult<Uint8Array>> {
    const { job, prompt, signal, referenceImages, target } = input;
    if (!this.portraitSupported)
      return this.image(job, prompt, signal, { size: "1024x1024", referenceImages, target });
    try {
      return await this.image(job, prompt, signal, { size: "1024x1536", referenceImages, target });
    } catch (error) {
      if (!(error instanceof HTTPError) || error.response.status !== 400) throw error;
      this.portraitSupported = false;
      return this.image(job, prompt, signal, { size: "1024x1024", referenceImages, target });
    }
  }
}
