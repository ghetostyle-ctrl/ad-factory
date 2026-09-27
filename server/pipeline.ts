import { type Creative, CreativeSchema, type Strategy, StrategySchema } from "../shared/planning";
import type { AgentId, Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { BlockedError, publicError, StudioError } from "./errors";
import { generateImageResult } from "./image-provider";
import { logger } from "./logger";
import { MetaClient } from "./meta-client";
import { MetaStager } from "./meta-stage";
import { snapshotModels } from "./model-settings";
import { Planner } from "./planning";
import type { JobStore } from "./store";

export type Providers = {
  readonly strategy: (job: Job, signal: AbortSignal) => Promise<Strategy>;
  readonly creative: (job: Job, strategy: Strategy, signal: AbortSignal) => Promise<Creative>;
  readonly image: (prompt: string, signal: AbortSignal, job: Job) => Promise<Uint8Array>;
  readonly stage: (job: Job, creative: Creative, signal: AbortSignal) => Promise<void>;
};
export class Pipeline {
  readonly active = new Map<string, AbortController>();
  readonly assets: Artifacts;
  readonly providers: Providers;
  constructor(
    readonly store: JobStore,
    providers?: Providers,
    readonly metaClientFactory: () => MetaClient = () => new MetaClient(),
  ) {
    this.assets = new Artifacts(store);
    const planner = new Planner(store.root);
    const meta = new MetaStager(store, this.assets, metaClientFactory);
    this.providers = providers ?? {
      strategy: planner.strategy.bind(planner),
      creative: planner.creative.bind(planner),
      image: async (prompt, signal, job) =>
        (
          await generateImageResult({
            prompt,
            signal,
            models: job.executionModels ?? snapshotModels(store.root),
          })
        ).value,
      stage: meta.stage.bind(meta),
    };
  }
  run(id: string): Job {
    const job = this.store.get(id);
    if (job.sourceSnapshot)
      throw new StudioError(
        "source_automation",
        "자료 기반 작업은 자동 운영 설정에서 3개 가설과 제작 한도를 승인하고 시작하세요.",
      );
    if (job.automation) throw new StudioError("automation", "자동 운영 제어를 사용하세요.");
    if (job.staged?.publishedAt)
      throw new StudioError("published", "게시된 작업은 Meta 광고 관리자에서 관리하세요.");
    if (this.active.has(id) || job.status === "running")
      throw new StudioError("busy", "이미 실행 중입니다.");
    if (job.staged?.pendingOperation)
      return this.store.change(id, (draft) => {
        draft.status = "blocked";
        draft.result =
          "이전 Meta 요청 결과가 불확실합니다. Meta 광고 관리자에서 확인하세요. 자동 재요청은 차단됩니다.";
      });
    if (job.staged?.adId)
      return this.store.change(id, (draft) => {
        draft.status = "review";
      });
    const controller = new AbortController();
    this.active.set(id, controller);
    const started = this.store.change(id, (draft) => {
      draft.status = "running";
      draft.result = null;
      draft.executionModels ??= snapshotModels(this.store.root);
    });
    void this.execute(id, controller.signal).finally(() => this.active.delete(id));
    return started;
  }
  cancel(id: string): Job {
    const job = this.store.get(id);
    if (job.automation) throw new StudioError("automation", "자동 운영 중지 버튼을 사용하세요.");
    if (job.staged?.publishedAt)
      throw new StudioError("published", "게시된 작업은 Meta 광고 관리자에서 관리하세요.");
    if (job.status === "running" && !this.active.has(id))
      throw new StudioError(
        "publishing",
        "게시 처리 중에는 취소할 수 없습니다. 완료 후 Meta 상태를 확인하세요.",
      );
    this.active.get(id)?.abort();
    return this.store.change(id, (draft) => {
      draft.status = "cancelled";
      draft.result = "실행이 취소되었습니다. 이미 외부에서 생성된 PAUSED 개체는 유지됩니다.";
      for (const agent of draft.agents)
        if (agent.status === "running") {
          agent.status = "cancelled";
          agent.action = draft.result;
        }
      this.store.event(draft, null, "warning", draft.result);
    });
  }
  async execute(id: string, signal: AbortSignal): Promise<void> {
    let stage: AgentId = "strategy";
    try {
      let job = this.store.get(id);
      let strategy: Strategy;
      const existingStrategy = job.artifacts.findLast((asset) => asset.agentId === "strategy");
      if (existingStrategy)
        strategy = StrategySchema.parse(
          await (await this.assets.read(id, existingStrategy.name)).json(),
        );
      else {
        this.store.agent(id, stage, {
          status: "running",
          action: "텍스트 공급자에 제품 사실과 타깃을 전달해 전략을 작성하고 있습니다.",
        });
        strategy = await this.providers.strategy(job, signal);
        signal.throwIfAborted();
        await this.assets.save(id, {
          name: `strategy-${Date.now()}.json`,
          kind: "json",
          agentId: stage,
          content: JSON.stringify(strategy, null, 2),
        });
        this.store.agent(id, stage, {
          status: "completed",
          action: "실제 공급자 응답으로 전략 산출물을 저장했습니다.",
        });
      }
      stage = "creative";
      job = this.store.get(id);
      let creative: Creative;
      const existingCreative = job.artifacts.findLast((asset) => asset.agentId === "creative");
      if (existingCreative)
        creative = CreativeSchema.parse(
          await (await this.assets.read(id, existingCreative.name)).json(),
        );
      else {
        signal.throwIfAborted();
        this.store.agent(id, stage, {
          status: "running",
          action: "전략을 바탕으로 카피와 이미지 제작 지시서를 작성하고 있습니다.",
        });
        creative = await this.providers.creative(job, strategy, signal);
        signal.throwIfAborted();
        await this.assets.save(id, {
          name: `creative-${Date.now()}.json`,
          kind: "json",
          agentId: stage,
          content: JSON.stringify(creative, null, 2),
        });
        this.store.agent(id, stage, {
          status: "completed",
          action: "실제 공급자 응답으로 카피와 제작 지시서를 저장했습니다.",
        });
      }
      stage = "production";
      job = this.store.get(id);
      if (!job.artifacts.some((asset) => asset.kind === "image")) {
        signal.throwIfAborted();
        this.store.agent(id, stage, {
          status: "running",
          action: "이미지 공급자에 제작 요청을 전달합니다. 실제 생성이 끝나면 산출물이 표시됩니다.",
        });
        const image = await this.providers.image(creative.imagePrompt, signal, job);
        signal.throwIfAborted();
        await this.assets.save(id, {
          name: `creative-${Date.now()}.png`,
          kind: "image",
          agentId: stage,
          content: image,
        });
        this.store.agent(id, stage, {
          status: "completed",
          action:
            "이미지 공급자가 반환한 실제 이미지를 저장했습니다. 게시 전에 상품 표현을 확인하세요.",
        });
      }
      stage = "deployment";
      signal.throwIfAborted();
      this.store.agent(id, stage, {
        status: "running",
        action: "연결 정보와 선택 계정을 확인한 후 PAUSED 광고 개체를 준비합니다.",
      });
      await this.providers.stage(this.store.get(id), creative, signal);
      signal.throwIfAborted();
      this.store.agent(id, stage, {
        status: "review",
        action:
          "실제 Meta 광고가 PAUSED 상태로 준비되었습니다. 설정과 이미지를 검토하고 게시를 승인하세요.",
      });
      this.store.change(id, (draft) => {
        draft.status = "review";
        draft.result = "검토 대기 · 광고는 PAUSED 상태입니다.";
      });
    } catch (error) {
      const status = signal.aborted
        ? "cancelled"
        : error instanceof BlockedError
          ? "blocked"
          : "failed";
      const message = publicError(error);
      this.store.agent(id, stage, { status, action: message });
      this.store.change(id, (draft) => {
        draft.status = status;
        draft.result = message;
      });
      logger[status === "failed" ? "error" : "info"](
        { jobId: id, agentId: stage, code: error instanceof StudioError ? error.code : "provider" },
        "pipeline.stopped",
      );
    }
  }
}
