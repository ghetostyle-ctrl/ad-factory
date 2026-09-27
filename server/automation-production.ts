import type { ModelResult } from "../shared/models";
import {
  type Creative,
  CreativeSchema,
  type ImageReview,
  ImageReviewSchema,
  type Strategy,
  StrategySchema,
} from "../shared/planning";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError, MissingConnectionError, StudioError } from "./errors";
import { generateImageResult } from "./image-provider";
import { Intelligence } from "./intelligence";
import { Planner } from "./planning";
import { type PlanProvider, SourceProduction } from "./source-production";
import type { JobStore } from "./store";
import type { VideoScriptProvider } from "./video-scripts";

export type ProductionProviders = {
  readonly plan?: PlanProvider;
  readonly videoScript?: VideoScriptProvider;
  readonly strategy: (job: Job, signal: AbortSignal) => Promise<ModelResult<Strategy>>;
  readonly creative: (
    job: Job,
    strategy: Strategy,
    signal: AbortSignal,
  ) => Promise<ModelResult<Creative>>;
  readonly image: (
    job: Job,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<ModelResult<Uint8Array>>;
  readonly review: (input: {
    readonly job: Job;
    readonly creative: Creative;
    readonly image: Uint8Array;
    readonly signal: AbortSignal;
  }) => Promise<ModelResult<ImageReview>>;
};
export class AutomaticProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  readonly providers: ProductionProviders;
  constructor(
    readonly store: JobStore,
    providers?: ProductionProviders,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
    const planner = new Planner(store.root);
    const intelligence = new Intelligence(store.root);
    this.providers = providers ?? {
      strategy: planner.strategyResult.bind(planner),
      creative: planner.creativeResult.bind(planner),
      image: (job, prompt, signal) => {
        if (!job.executionModels) throw new BlockedError("실행 모델 스냅샷이 없습니다.");
        return generateImageResult({ prompt, signal, models: job.executionModels });
      },
      review: intelligence.review.bind(intelligence),
    };
  }
  async run(id: string, signal: AbortSignal): Promise<Creative> {
    const strategyAsset = this.store
      .get(id)
      .artifacts.findLast((asset) => asset.agentId === "strategy");
    const strategy = strategyAsset
      ? StrategySchema.parse(await (await this.assets.read(id, strategyAsset.name)).json())
      : await this.guard.operation(id, {
          phase: "strategy",
          signal,
          run: async () => {
            this.store.agent(id, "strategy", { status: "running", action: "자동 전략 생성 중" });
            const result = await this.providers.strategy(this.store.get(id), signal);
            await this.assets.save(id, {
              name: "strategy-auto.json",
              kind: "json",
              agentId: "strategy",
              content: JSON.stringify(result.value),
              model: result.model,
            });
            this.store.agent(id, "strategy", { status: "completed", action: "전략 생성 완료" });
            return result.value;
          },
        });
    if (this.store.get(id).sourceSnapshot)
      return new SourceProduction(this.store, this.providers).run(id, strategy, signal);
    const creativeAsset = this.store
      .get(id)
      .artifacts.findLast((asset) => asset.agentId === "creative");
    const creative = creativeAsset
      ? CreativeSchema.parse(await (await this.assets.read(id, creativeAsset.name)).json())
      : await this.guard.operation(id, {
          phase: "creative",
          signal,
          run: async () => {
            this.store.agent(id, "creative", {
              status: "running",
              action: "자동 카피·제작 지시 생성 중",
            });
            const result = await this.providers.creative(this.store.get(id), strategy, signal);
            await this.assets.save(id, {
              name: "creative-auto.json",
              kind: "json",
              agentId: "creative",
              content: JSON.stringify(result.value),
              model: result.model,
            });
            this.store.agent(id, "creative", {
              status: "completed",
              action: "카피·제작 지시 생성 완료",
            });
            return result.value;
          },
        });
    let prompt = creative.imagePrompt;
    while (true) {
      const job = this.guard.check(id, signal);
      const latestImage = job.artifacts.findLast((asset) => asset.kind === "image");
      const reviewAsset = job.artifacts.findLast((asset) => asset.name.startsWith("review-auto-"));
      const review = reviewAsset
        ? ImageReviewSchema.parse(await (await this.assets.read(id, reviewAsset.name)).json())
        : null;
      const reviewedImage =
        reviewAsset &&
        latestImage &&
        job.artifacts.indexOf(reviewAsset) > job.artifacts.indexOf(latestImage);
      if (reviewedImage && review?.status === "pass") {
        if (
          latestImage?.id !== job.automation?.approvedImageId ||
          contentDigest(JSON.stringify(creative)) !== job.automation.approvedCreativeDigest
        )
          throw new StudioError(
            "review_binding",
            "AI 검토 이후 이미지 또는 카피가 변경되었습니다.",
          );
        return creative;
      }
      if (reviewedImage && review?.status === "revise") {
        if ((job.automation?.imageAttempts ?? 0) >= 2) {
          this.store.agent(id, "production", {
            status: "completed",
            action: "검토 보류로 확정 · 다음 소재 제작으로 진행",
          });
          this.store.change(id, (draft) => {
            if (!draft.automation || !latestImage) return;
            draft.automation.approvedImageId = latestImage.id;
            draft.automation.approvedImageDigest = contentDigest(JSON.stringify(latestImage));
            draft.automation.approvedCreativeDigest = contentDigest(JSON.stringify(creative));
          });
          return creative;
        }
        prompt =
          review.revisionPrompt ??
          `${creative.imagePrompt}\n수정 요청: ${review.issues.join("; ")}`;
      }
      if (!latestImage || reviewedImage)
        await this.guard.operation(id, {
          phase: "image",
          signal,
          run: async () => {
            const current = this.store.get(id);
            if ((current.automation?.imageAttempts ?? 0) >= 2)
              throw new BlockedError("이미지 생성 한도에 도달했습니다.");
            this.store.agent(id, "production", {
              status: "running",
              action: "OpenAI 이미지 자동 생성 중",
            });
            const attempt = (current.automation?.imageAttempts ?? 0) + 1;
            this.store.change(id, (draft) => {
              if (draft.automation) draft.automation.imageAttempts = attempt;
            });
            const result = await this.providers.image(current, prompt, signal).catch((error) => {
              if (error instanceof MissingConnectionError)
                this.store.change(id, (draft) => {
                  if (draft.automation) draft.automation.imageAttempts = attempt - 1;
                });
              throw error;
            });
            await this.assets.save(id, {
              name: `image-auto-${attempt}.png`,
              kind: "image",
              agentId: "production",
              content: result.value,
              model: result.model,
            });
          },
        });
      await this.guard.operation(id, {
        phase: "review",
        signal,
        run: async () => {
          const current = this.store.get(id);
          const asset = current.artifacts.findLast((item) => item.kind === "image");
          if (!asset) throw new BlockedError("AI 검토할 이미지가 없습니다.");
          const image = new Uint8Array(
            await (await this.assets.read(id, asset.name)).arrayBuffer(),
          );
          this.store.agent(id, "production", {
            status: "running",
            action: "AI가 실제 이미지와 카피를 자동 검토 중",
          });
          const result = await this.providers.review({ job: current, creative, image, signal });
          await this.assets.save(id, {
            name: `review-auto-${current.automation?.imageAttempts ?? 0}.json`,
            kind: "json",
            agentId: "production",
            content: JSON.stringify(result.value),
            model: result.model,
          });
          this.store.change(id, (draft) => {
            if (!draft.automation) return;
            draft.automation.approvedImageId = result.value.status === "pass" ? asset.id : null;
            draft.automation.approvedImageDigest =
              result.value.status === "pass" ? contentDigest(image) : null;
            draft.automation.approvedCreativeDigest =
              result.value.status === "pass" ? contentDigest(JSON.stringify(creative)) : null;
          });
          this.store.agent(id, "production", {
            status: result.value.status === "pass" ? "completed" : "review",
            action: result.value.summary,
          });
        },
      });
    }
  }
}
