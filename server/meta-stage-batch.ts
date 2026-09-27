import { z } from "zod";
import type { Job, Stage } from "../shared/schema";
import type { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError, StudioError } from "./errors";
import { budgetMinorUnits, type MetaClient } from "./meta-client";
import { checkVariantBindings, prepareVariants, type StagedVariant } from "./meta-stage-variants";
import type { JobStore } from "./store";

const IdResponse = z.object({ id: z.string().regex(/^\d+$/) });
const ImageResponse = z.object({ images: z.record(z.string(), z.object({ hash: z.string() })) });

export class MetaBatchStager {
  constructor(
    readonly store: JobStore,
    readonly artifacts: Artifacts,
    readonly client: MetaClient,
  ) {}

  async stage(job: Job, signal: AbortSignal): Promise<void> {
    const adPolicy = job.automation?.policy.mode === "creative" ? null : job.automation?.policy;
    const selection = job.selection;
    if (!selection?.pageId || !job.dailyBudget || job.accountId !== selection.accountId)
      throw new BlockedError("실제 광고 계정, Facebook 페이지와 일일 예산을 선택하세요.");
    if (job.objective === "sales" && !selection.pixelId)
      throw new BlockedError("판매 목표에는 구매 이벤트를 받을 Meta Pixel ID가 필요합니다.");
    if (job.staged?.pendingOperation) this.uncertain(job.staged);
    const check = () => {
      signal.throwIfAborted();
      if (job.automation) new AutomationGuard(this.store).check(job.id, signal);
    };
    check();
    const prepared = await prepareVariants(job, this.artifacts);
    const first = prepared[0];
    if (!first) throw new BlockedError("배포할 광고 가설이 없습니다.");
    const account = (await this.client.accounts()).find((item) => item.id === selection.accountId);
    if (!account || account.currency !== job.currency)
      throw new BlockedError("광고 계정 접근 권한과 브리프 통화를 확인하세요.");
    if (!job.staged)
      this.store.change(job.id, (draft) => {
        draft.staged = {
          accountId: account.id,
          dailyBudget: job.dailyBudget ?? 0,
          budgetMinorUnits: budgetMinorUnits(job.dailyBudget ?? 0, account.currency),
          currency: account.currency,
          country: job.country,
          objective: job.objective,
          pageId: selection.pageId ?? "",
          campaignId: null,
          adsetId: null,
          creativeId: null,
          adId: null,
          imageHash: null,
          artifactId: first.artifactId,
          managerUrl: null,
          createdAt: new Date().toISOString(),
          publishedAt: null,
          pendingOperation: null,
          deliveryStatus: null,
          digest: "",
          maxTotalSpend: adPolicy?.maxTotalSpend ?? null,
          spendCapMinorUnits: adPolicy
            ? budgetMinorUnits(adPolicy.maxTotalSpend, job.currency)
            : null,
          endAt: adPolicy?.endAt ?? null,
          creativeSnapshot: first.creative,
          variants: prepared.map((item) => ({
            id: item.id,
            artifactId: item.artifactId,
            creativeSnapshot: item.creative,
            creativeId: null,
            adId: null,
            imageHash: null,
            deliveryStatus: null,
          })),
        };
      });
    let stage = this.current(job.id);
    checkVariantBindings(job, stage);
    if (
      stage.accountId !== job.accountId ||
      stage.dailyBudget !== job.dailyBudget ||
      stage.currency !== job.currency ||
      stage.country !== job.country ||
      stage.objective !== job.objective ||
      stage.pageId !== selection.pageId ||
      stage.maxTotalSpend !== (adPolicy?.maxTotalSpend ?? null) ||
      stage.endAt !== (adPolicy?.endAt ?? null) ||
      stage.publishedAt
    )
      throw new StudioError("approval_changed", "배포 묶음의 승인 대상 설정이 변경되었습니다.");
    const create = async (
      operation: string,
      request: { readonly path: string; readonly data: Readonly<Record<string, unknown>> },
    ) => {
      check();
      this.patch(job.id, { pendingOperation: operation });
      return IdResponse.parse(await this.client.post(request.path, request.data)).id;
    };
    for (const variant of prepared) {
      if (this.variant(job.id, variant.id).imageHash) continue;
      check();
      this.patch(job.id, { pendingOperation: `image upload:${variant.id}` });
      const result = ImageResponse.parse(
        await this.client.post(`${account.id}/adimages`, {
          bytes: Buffer.from(variant.bytes).toString("base64"),
        }),
      );
      const image = Object.values(result.images)[0];
      if (!image) throw new StudioError("meta_image", "Meta 이미지 해시가 반환되지 않았습니다.");
      this.patchVariant(job.id, variant.id, { imageHash: image.hash });
    }
    if (!stage.campaignId) {
      const campaignId = await create("campaignId", {
        path: `${account.id}/campaigns`,
        data: {
          name: job.name,
          objective: job.objective === "sales" ? "OUTCOME_SALES" : "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: false,
          ...(stage.spendCapMinorUnits !== null ? { spend_cap: stage.spendCapMinorUnits } : {}),
        },
      });
      this.patch(job.id, { campaignId, pendingOperation: null });
      stage = this.current(job.id);
    }
    if (!stage.adsetId) {
      const adsetId = await create("adsetId", {
        path: `${account.id}/adsets`,
        data: {
          name: `${job.name} · ${job.country}`,
          campaign_id: stage.campaignId,
          status: "PAUSED",
          daily_budget: stage.budgetMinorUnits,
          billing_event: "IMPRESSIONS",
          optimization_goal: job.objective === "sales" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          destination_type: "WEBSITE",
          ...(stage.endAt ? { end_time: stage.endAt } : {}),
          targeting: { geo_locations: { countries: [job.country] }, age_min: 18 },
          ...(job.objective === "sales"
            ? { promoted_object: { pixel_id: selection.pixelId, custom_event_type: "PURCHASE" } }
            : {}),
        },
      });
      this.patch(job.id, { adsetId, pendingOperation: null });
      stage = this.current(job.id);
    }
    for (const item of prepared) {
      let variant = this.variant(job.id, item.id);
      if (!variant.creativeId) {
        const creativeId = await create(`creativeId:${item.id}`, {
          path: `${account.id}/adcreatives`,
          data: {
            name: `${job.name} · ${item.id}`,
            object_story_spec: {
              page_id: selection.pageId,
              ...(selection.instagramAccountId
                ? { instagram_user_id: selection.instagramAccountId }
                : {}),
              link_data: {
                image_hash: variant.imageHash,
                link: job.productUrl,
                message: item.creative.primaryText,
                name: item.creative.headline,
                description: item.creative.description,
                call_to_action: {
                  type: item.creative.callToAction,
                  value: { link: job.productUrl },
                },
              },
            },
          },
        });
        this.patchVariant(job.id, item.id, { creativeId });
        variant = this.variant(job.id, item.id);
      }
      if (!variant.adId) {
        const adId = await create(`adId:${item.id}`, {
          path: `${account.id}/ads`,
          data: {
            name: `${job.name} · ${item.id}`,
            adset_id: stage.adsetId,
            creative: { creative_id: variant.creativeId },
            status: "PAUSED",
          },
        });
        this.patchVariant(job.id, item.id, { adId });
      }
    }
    stage = this.current(job.id);
    this.patch(job.id, {
      digest: contentDigest(
        JSON.stringify({ ...stage, digest: "", managerUrl: null, pendingOperation: null }),
      ),
      managerUrl: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account.id.replace("act_", "")}&selected_ad_ids=${stage.variants.map((item) => item.adId).join(",")}`,
    });
  }

  private current(id: string): Stage {
    const stage = this.store.get(id).staged;
    if (!stage) throw new StudioError("stage_missing", "배포 설정이 없습니다.");
    if (stage.pendingOperation) this.uncertain(stage);
    return stage;
  }
  private uncertain(stage: Stage): never {
    throw new BlockedError(
      `이전 ${stage.pendingOperation} 요청 결과가 불확실합니다. 자동 재요청은 차단됩니다.`,
    );
  }
  private variant(id: string, variantId: string): StagedVariant {
    const variant = this.current(id).variants.find((item) => item.id === variantId);
    if (!variant) throw new StudioError("stage_missing", "배포할 광고 가설이 없습니다.");
    return variant;
  }
  private patch(id: string, patch: Partial<Stage>): void {
    this.store.change(id, (job) => {
      if (job.staged) Object.assign(job.staged, patch);
    });
  }
  private patchVariant(id: string, variantId: string, patch: Partial<StagedVariant>): void {
    this.store.change(id, (job) => {
      const stage = job.staged;
      const variant = stage?.variants.find((item) => item.id === variantId);
      if (!stage || !variant)
        throw new StudioError("stage_missing", "배포할 광고 가설이 없습니다.");
      Object.assign(variant, patch);
      stage.pendingOperation = null;
      const first = stage.variants[0];
      if (first)
        Object.assign(stage, {
          creativeId: first.creativeId,
          adId: first.adId,
          imageHash: first.imageHash,
        });
    });
  }
}
