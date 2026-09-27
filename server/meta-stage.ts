import { createHash } from "node:crypto";
import { z } from "zod";
import type { Creative } from "../shared/planning";
import type { Job, Stage } from "../shared/schema";
import type { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError, StudioError } from "./errors";
import { budgetMinorUnits, MetaClient } from "./meta-client";
import { MetaBatchStager } from "./meta-stage-batch";
import type { JobStore } from "./store";

const IdResponse = z.object({ id: z.string().regex(/^\d+$/) });
const ImageResponse = z.object({ images: z.record(z.string(), z.object({ hash: z.string() })) });
export class MetaStager {
  constructor(
    readonly store: JobStore,
    readonly artifacts: Artifacts,
    readonly clientFactory: () => MetaClient = () => new MetaClient(),
  ) {}
  async stage(job: Job, creative: Creative, signal: AbortSignal): Promise<void> {
    const adPolicy = job.automation?.policy.mode === "creative" ? null : job.automation?.policy;
    if (job.sourceSnapshot || job.creativeVariants.length > 0) {
      await new MetaBatchStager(this.store, this.artifacts, this.clientFactory()).stage(
        job,
        signal,
      );
      return;
    }
    const client = this.clientFactory();
    const selection = job.selection;
    if (!selection?.pageId)
      throw new BlockedError("실제 광고 계정과 Facebook 페이지 ID를 선택하세요.");
    if (!job.dailyBudget) throw new BlockedError("명시적인 일일 예산을 입력한 작업이 필요합니다.");
    if (job.objective === "sales" && !selection.pixelId)
      throw new BlockedError("판매 목표에는 구매 이벤트를 받을 Meta Pixel ID가 필요합니다.");
    const account = (await client.accounts()).find((item) => item.id === selection.accountId);
    if (!account) throw new BlockedError("선택한 계정의 접근 권한을 확인할 수 없습니다.");
    if (account.currency !== job.currency)
      throw new BlockedError(
        `계정 통화(${account.currency})와 브리프 통화(${job.currency})가 다릅니다.`,
      );
    const asset = job.automation
      ? job.artifacts.find(
          (item) => item.id === job.automation?.approvedImageId && item.kind === "image",
        )
      : job.artifacts.findLast((item) => item.kind === "image");
    if (!asset) throw new BlockedError("배포할 이미지 산출물이 없습니다.");
    const imageBytes = new Uint8Array(
      await (await this.artifacts.read(job.id, asset.name)).arrayBuffer(),
    );
    if (
      job.automation &&
      (contentDigest(imageBytes) !== job.automation.approvedImageDigest ||
        contentDigest(JSON.stringify(creative)) !== job.automation.approvedCreativeDigest)
    )
      throw new StudioError(
        "review_binding",
        "AI가 검토한 이미지·카피와 배포 산출물이 일치하지 않습니다.",
      );
    const initial = {
      accountId: account.id,
      dailyBudget: job.dailyBudget,
      budgetMinorUnits: budgetMinorUnits(job.dailyBudget, account.currency),
      currency: account.currency,
      country: job.country,
      objective: job.objective,
      pageId: selection.pageId,
      campaignId: null,
      adsetId: null,
      creativeId: null,
      adId: null,
      imageHash: null,
      artifactId: asset.id,
      managerUrl: null,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      pendingOperation: null,
      deliveryStatus: null,
      maxTotalSpend: adPolicy?.maxTotalSpend ?? null,
      spendCapMinorUnits: adPolicy ? budgetMinorUnits(adPolicy.maxTotalSpend, job.currency) : null,
      endAt: adPolicy?.endAt ?? null,
      creativeSnapshot: creative,
      variants: [],
    };
    const digest = createHash("sha256")
      .update(JSON.stringify({ initial, selection, creative, productUrl: job.productUrl }))
      .update(imageBytes)
      .digest("hex");
    if (!job.staged)
      this.store.change(job.id, (draft) => {
        draft.staged = { ...initial, digest };
      });
    let stage = this.current(job.id);
    if (stage.pendingOperation)
      throw new BlockedError(
        `이전 ${stage.pendingOperation} 요청 결과가 불확실합니다. Meta 광고 관리자에서 상태를 확인하세요. 자동 재요청은 차단됩니다.`,
      );
    const check = () => {
      signal.throwIfAborted();
      if (job.automation) new AutomationGuard(this.store).check(job.id, signal);
    };
    check();
    const create = async (
      field: "campaignId" | "adsetId" | "creativeId" | "adId",
      request: { readonly path: string; readonly data: Readonly<Record<string, unknown>> },
    ) => {
      check();
      this.checkpoint(job.id, { pendingOperation: field });
      const result = IdResponse.parse(await client.post(request.path, request.data));
      this.checkpoint(job.id, { [field]: result.id, pendingOperation: null });
      stage = this.current(job.id);
    };
    if (!stage.imageHash) {
      check();
      this.checkpoint(job.id, { pendingOperation: "image upload" });
      const result = ImageResponse.parse(
        await client.post(`${account.id}/adimages`, {
          bytes: Buffer.from(imageBytes).toString("base64"),
        }),
      );
      const image = Object.values(result.images)[0];
      if (!image) throw new StudioError("meta_image", "Meta 이미지 해시가 반환되지 않았습니다.");
      this.checkpoint(job.id, { imageHash: image.hash, pendingOperation: null });
      stage = this.current(job.id);
    }
    if (!stage.campaignId)
      await create("campaignId", {
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
    if (!stage.adsetId)
      await create("adsetId", {
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
    if (!stage.creativeId)
      await create("creativeId", {
        path: `${account.id}/adcreatives`,
        data: {
          name: `${job.name} · creative`,
          object_story_spec: {
            page_id: selection.pageId,
            ...(selection.instagramAccountId
              ? { instagram_user_id: selection.instagramAccountId }
              : {}),
            link_data: {
              image_hash: stage.imageHash,
              link: job.productUrl,
              message: creative.primaryText,
              name: creative.headline,
              description: creative.description,
              call_to_action: { type: creative.callToAction, value: { link: job.productUrl } },
            },
          },
        },
      });
    if (!stage.adId)
      await create("adId", {
        path: `${account.id}/ads`,
        data: {
          name: `${job.name} · ad`,
          adset_id: stage.adsetId,
          creative: { creative_id: stage.creativeId },
          status: "PAUSED",
        },
      });
    this.checkpoint(job.id, {
      digest: createHash("sha256")
        .update(
          `${stage.digest}:${stage.campaignId}:${stage.adsetId}:${stage.creativeId}:${stage.adId}`,
        )
        .digest("hex"),
      managerUrl: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account.id.replace("act_", "")}&selected_ad_ids=${stage.adId}`,
    });
  }
  current(id: string): Stage {
    const stage = this.store.get(id).staged;
    if (!stage) throw new StudioError("stage_missing", "배포 설정이 없습니다.");
    return stage;
  }
  checkpoint(id: string, patch: Partial<Stage>): void {
    this.store.change(id, (job) => {
      if (job.staged) Object.assign(job.staged, patch);
    });
  }
}
