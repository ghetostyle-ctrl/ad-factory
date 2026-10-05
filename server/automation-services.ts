import type { Creative } from "../shared/planning";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { AutomaticProduction } from "./automation-production";
import { ClipProduction } from "./clip-production";
import { Intelligence } from "./intelligence";
import { MetaClient } from "./meta-client";
import { InsightsSchema, metricsFromResponse } from "./meta-insights";
import { pauseJob, publishJob } from "./meta-publish";
import { MetaStager } from "./meta-stage";
import { stageComplete } from "./meta-stage-variants";
import { RenderPipeline } from "./render-pipeline";
import { VideoScriptService } from "./script-service";
import { StartImageProduction } from "./start-image-production";
import { StillProduction } from "./still-production";
import type { JobStore } from "./store";
import { VoiceProduction } from "./voice-production";

export type AutomationServices = {
  readonly produce: (id: string, signal: AbortSignal) => Promise<void>;
  readonly prepare: (id: string, signal: AbortSignal) => Promise<void>;
  readonly activate: (job: Job, signal: AbortSignal) => Promise<void>;
  readonly analyze: (job: Job, signal: AbortSignal) => Promise<void>;
  readonly pause: (job: Job) => Promise<void>;
  // 영상 대본 확인·수정·승인·다시 쓰기(같은 대본 작성·검토 공급자를 쓴다)
  readonly scripts: VideoScriptService;
};
export function automationServices(
  store: JobStore,
  dependencies?: {
    readonly production?: AutomaticProduction;
    readonly clientFactory?: () => MetaClient;
    readonly intelligence?: Intelligence;
    readonly renderPipeline?: RenderPipeline;
  },
): AutomationServices {
  const assets = new Artifacts(store);
  const guard = new AutomationGuard(store);
  const production = dependencies?.production ?? new AutomaticProduction(store);
  // 렌더 파이프라인: 테스트가 ProductionProviders 에 voice/veo/검토 스텁을 넣으면 그대로 쓴다.
  const providers = production.providers;
  const renderPipeline =
    dependencies?.renderPipeline ??
    new RenderPipeline(store, {
      ...(providers.voice ? { voice: new VoiceProduction(store, providers.voice) } : {}),
      ...(providers.reviewStartImage
        ? {
            startImages: new StartImageProduction(store, {
              image: providers.image,
              reviewStartImage: providers.reviewStartImage,
            }),
            stills: new StillProduction(store, {
              image: providers.image,
              reviewStartImage: providers.reviewStartImage,
            }),
          }
        : {}),
      ...(providers.veo
        ? { clips: new ClipProduction(store, providers.veo, providers.reviewClipFrames ?? null) }
        : {}),
    });
  const client = dependencies?.clientFactory ?? (() => new MetaClient());
  const stager = new MetaStager(store, assets, client);
  const intelligence = dependencies?.intelligence ?? new Intelligence(store.root);
  const stage = async (id: string, creative: Creative, signal: AbortSignal) => {
    if (!stageComplete(store.get(id)))
      await guard.operation(id, {
        phase: "stage",
        signal,
        run: async () => {
          store.agent(id, "deployment", {
            status: "running",
            action: "승인 범위로 PAUSED Meta 개체 자동 준비 중",
          });
          await stager.stage(store.get(id), creative, signal);
        },
      });
    store.change(id, (job) => {
      job.status = "review";
      job.result = "자동 검토 통과 · Meta PAUSED 준비 완료";
    });
    store.agent(id, "deployment", {
      status: "review",
      action: "Meta PAUSED 준비 완료 · 초기 정책에 따라 진행",
    });
  };
  return {
    produce: async (id, signal) => {
      await production.run(id, signal);
      await renderPipeline.run(id, signal);
    },
    prepare: async (id, signal) => {
      await stage(id, await production.run(id, signal), signal);
    },
    activate: async (job, signal) => {
      await guard.operation(job.id, {
        phase: "activate",
        signal,
        run: async () => {
          await publishJob(store, {
            id: job.id,
            digest: job.staged?.digest ?? "",
            signal,
            client: client(),
          });
        },
      });
    },
    analyze: async (job, signal) => {
      guard.check(job.id, signal);
      store.change(job.id, (draft) => {
        if (draft.automation) draft.automation.phase = "insights";
      });
      store.agent(job.id, "analysis", {
        status: "running",
        action: "Meta 캠페인 실제 누적 Insights 조회 중",
      });
      const response = InsightsSchema.parse(
        await client().get(`${job.staged?.campaignId}/insights`, {
          fields: "spend,impressions,clicks,actions,action_values,date_start,date_stop",
          date_preset: "maximum",
        }),
      );
      guard.check(job.id, signal);
      const metrics = metricsFromResponse(response, job.currency);
      const variantMetrics = await Promise.all(
        (job.staged?.variants ?? []).map(async (variant) => {
          if (!variant.adId) return { variantId: variant.id, adId: "", metrics: null };
          guard.check(job.id, signal);
          const result = InsightsSchema.parse(
            await client().get(`${variant.adId}/insights`, {
              fields: "spend,impressions,clicks,actions,action_values,date_start,date_stop",
              date_preset: "maximum",
            }),
          );
          return {
            variantId: variant.id,
            adId: variant.adId,
            metrics: metricsFromResponse(result, job.currency),
          };
        }),
      );
      guard.check(job.id, signal);
      store.change(job.id, (draft) => {
        draft.metrics = metrics;
        draft.variantMetrics = variantMetrics;
      });
      if (
        !metrics ||
        [
          metrics.spend,
          metrics.impressions,
          metrics.clicks,
          metrics.purchases,
          metrics.revenue,
        ].every((value) => value === 0)
      ) {
        store.agent(job.id, "analysis", {
          status: "idle",
          action: "Meta에 실제 성과 데이터가 아직 없습니다. 다음 자동 조회를 기다립니다.",
        });
        return;
      }
      const policy = job.automation?.policy;
      if (policy && policy.mode !== "creative" && metrics.spend >= policy.maxTotalSpend) return;
      const digest = contentDigest(
        JSON.stringify({
          spend: metrics.spend,
          impressions: metrics.impressions,
          clicks: metrics.clicks,
          purchases: metrics.purchases,
          revenue: metrics.revenue,
          currency: metrics.currency,
          dateStart: metrics.dateStart,
          dateStop: metrics.dateStop,
          variants: variantMetrics.map((variant) => ({
            variantId: variant.variantId,
            adId: variant.adId,
            metrics: variant.metrics ? { ...variant.metrics, fetchedAt: undefined } : null,
          })),
        }),
      );
      if (digest === store.get(job.id).automation?.lastAnalysisDigest) {
        store.agent(job.id, "analysis", {
          status: "completed",
          action: "실제 성과가 이전 보고서와 같습니다. 추가 AI 호출 없이 다음 조회를 기다립니다.",
        });
        return;
      }
      await guard.operation(job.id, {
        phase: "report",
        signal,
        run: async () => {
          const result = await intelligence.report(store.get(job.id), metrics, signal);
          await assets.save(job.id, {
            name: `analysis-${Date.now()}.json`,
            kind: "json",
            agentId: "analysis",
            content: JSON.stringify({ metrics, variantMetrics, report: result.value }),
            model: result.model,
          });
          store.change(job.id, (draft) => {
            if (draft.automation) draft.automation.lastAnalysisDigest = digest;
          });
          store.agent(job.id, "analysis", {
            status: "completed",
            action: "실제 Meta 성과에 근거한 AI 분석 보고서 저장 완료",
          });
        },
      });
    },
    pause: (job) => pauseJob(store, job, client()),
    scripts: new VideoScriptService(store, providers),
  };
}
