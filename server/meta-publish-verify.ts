import { z } from "zod";
import type { Job, Stage } from "../shared/schema";
import { contentDigest } from "./automation-guard";
import { StudioError } from "./errors";
import { budgetMinorUnits, type MetaClient } from "./meta-client";
import { checkVariantBindings } from "./meta-stage-variants";

export type ApprovedStage = Stage & {
  campaignId: string;
  adsetId: string;
  creativeId: string;
  adId: string;
};
const CampaignSchema = z.object({
  status: z.literal("PAUSED"),
  account_id: z.string(),
  objective: z.string(),
  spend_cap: z.string().optional(),
});
const AdsetSchema = z.object({
  status: z.literal("PAUSED"),
  campaign_id: z.string(),
  daily_budget: z.string(),
  end_time: z.string().optional(),
  targeting: z.object({ geo_locations: z.object({ countries: z.array(z.string()) }) }),
  promoted_object: z.object({ pixel_id: z.string(), custom_event_type: z.string() }).optional(),
});
const AdSchema = z.object({
  status: z.literal("PAUSED"),
  adset_id: z.string(),
  creative: z.object({ id: z.string() }),
});
const CreativeSchema = z.object({
  object_story_spec: z.object({
    page_id: z.string(),
    instagram_user_id: z.string().optional(),
    link_data: z.object({
      image_hash: z.string(),
      link: z.string(),
      message: z.string(),
      name: z.string(),
      description: z.string(),
      call_to_action: z.object({ type: z.string(), value: z.object({ link: z.string() }) }),
    }),
  }),
});

export function stageAds(stage: ApprovedStage) {
  if (stage.variants.length === 0)
    return [
      {
        id: "legacy",
        artifactId: stage.artifactId,
        creativeSnapshot: stage.creativeSnapshot,
        creativeId: stage.creativeId,
        adId: stage.adId,
        imageHash: stage.imageHash,
      },
    ];
  return stage.variants.map((variant) => {
    if (!variant.adId || !variant.creativeId || !variant.imageHash)
      throw new StudioError("approval", "모든 광고 가설의 Meta 준비가 완료되어야 합니다.");
    return { ...variant, adId: variant.adId, creativeId: variant.creativeId };
  });
}

export async function verifyRemoteStage(
  job: Job,
  stage: ApprovedStage,
  client: MetaClient,
): Promise<void> {
  const ads = stageAds(stage);
  const [campaign, adset, remoteAds] = await Promise.all([
    client
      .get(stage.campaignId, { fields: "status,account_id,objective,spend_cap" })
      .then((value) => CampaignSchema.parse(value)),
    client
      .get(stage.adsetId, {
        fields: "status,campaign_id,daily_budget,targeting,end_time,promoted_object",
      })
      .then((value) => AdsetSchema.parse(value)),
    Promise.all(
      ads.map(async (variant) => {
        const [ad, creative] = await Promise.all([
          client
            .get(variant.adId, { fields: "status,adset_id,creative{id}" })
            .then((value) => AdSchema.parse(value)),
          client
            .get(variant.creativeId, { fields: "object_story_spec" })
            .then((value) => CreativeSchema.parse(value)),
        ]);
        return { variant, ad, creative };
      }),
    ),
  ]);
  if (
    campaign.account_id !== stage.accountId.replace("act_", "") ||
    campaign.objective !== (job.objective === "sales" ? "OUTCOME_SALES" : "OUTCOME_TRAFFIC") ||
    adset.campaign_id !== stage.campaignId ||
    Number(adset.daily_budget) !== budgetMinorUnits(stage.dailyBudget, stage.currency) ||
    adset.targeting.geo_locations.countries.join(",") !== job.country ||
    (job.objective === "sales" &&
      (adset.promoted_object?.pixel_id !== job.selection?.pixelId ||
        adset.promoted_object?.custom_event_type !== "PURCHASE"))
  )
    throw new StudioError(
      "remote_changed",
      "Meta 설정이 승인 범위와 다릅니다. 광고 관리자에서 확인하세요.",
    );
  if (
    job.automation &&
    (job.automation.policy.mode !== "activate" ||
      Number(campaign.spend_cap) !==
        budgetMinorUnits(job.automation.policy.maxTotalSpend, job.currency) ||
      stage.maxTotalSpend !== job.automation.policy.maxTotalSpend ||
      stage.spendCapMinorUnits !==
        budgetMinorUnits(job.automation.policy.maxTotalSpend, job.currency) ||
      !adset.end_time ||
      Date.parse(adset.end_time) !== Date.parse(job.automation.policy.endAt) ||
      stage.endAt !== job.automation.policy.endAt)
  )
    throw new StudioError(
      "remote_limits",
      "Meta 전체 지출 한도와 종료 시각이 승인 범위와 일치하지 않아 활성화를 차단했습니다.",
    );
  for (const { variant, ad, creative } of remoteAds) {
    const story = creative.object_story_spec;
    const link = story.link_data;
    if (
      ad.adset_id !== stage.adsetId ||
      ad.creative.id !== variant.creativeId ||
      story.page_id !== stage.pageId ||
      story.instagram_user_id !== job.selection?.instagramAccountId ||
      link.link !== job.productUrl ||
      link.image_hash !== variant.imageHash
    )
      throw new StudioError(
        "remote_changed",
        "Meta 설정이 승인 범위와 다릅니다. 광고 관리자에서 확인하세요.",
      );
    const snapshot = variant.creativeSnapshot;
    if (
      snapshot &&
      (link.message !== snapshot.primaryText ||
        link.name !== snapshot.headline ||
        link.description !== snapshot.description ||
        link.call_to_action.type !== snapshot.callToAction ||
        link.call_to_action.value.link !== job.productUrl)
    )
      throw new StudioError(
        "remote_copy",
        "Meta 카피가 검토한 카피와 일치하지 않아 활성화를 차단했습니다.",
      );
  }
  if (stage.variants.length > 0) checkVariantBindings(job, stage);
  else if (
    job.automation &&
    (stage.artifactId !== job.automation.approvedImageId ||
      !stage.creativeSnapshot ||
      contentDigest(JSON.stringify(stage.creativeSnapshot)) !==
        job.automation.approvedCreativeDigest)
  )
    throw new StudioError("review_binding", "AI 검토 승인과 Meta 배포 스냅샷이 일치하지 않습니다.");
}
