import type { Creative } from "../shared/planning";
import type { Job, Stage } from "../shared/schema";
import type { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { BlockedError, StudioError } from "./errors";

export type StagedVariant = Stage["variants"][number];
export type PreparedVariant = {
  readonly id: string;
  readonly artifactId: string;
  readonly creative: Creative;
  readonly bytes: Uint8Array;
};

function checkSourceVariants(job: Job): void {
  if (!job.sourceSnapshot) return;
  const plan = job.creativePlan;
  if (
    !plan ||
    !job.automation?.approvedPlanDigest ||
    plan.sourceDigest !== job.sourceSnapshot.digest ||
    contentDigest(JSON.stringify(plan)) !== job.automation.approvedPlanDigest ||
    job.creativeVariants.length !== 3 ||
    new Set(job.creativeVariants.map((variant) => variant.approvedImageId)).size !== 3 ||
    new Set(plan.hypotheses.map((item) => item.id)).size !== 3 ||
    job.creativeVariants.some((variant) => {
      const hypothesis = plan.hypotheses.find((item) => item.id === variant.id);
      return (
        !hypothesis ||
        contentDigest(JSON.stringify(hypothesis.creative)) !==
          contentDigest(JSON.stringify(variant.creative))
      );
    })
  )
    throw new StudioError(
      "review_binding",
      "승인된 근거 기획과 광고 가설 3개가 일치하지 않습니다.",
    );
}

export async function prepareVariants(job: Job, artifacts: Artifacts): Promise<PreparedVariant[]> {
  checkSourceVariants(job);
  if (
    job.creativeVariants.length !== 3 ||
    new Set(job.creativeVariants.map((v) => v.id)).size !== 3
  )
    throw new BlockedError("서로 다른 광고 가설 3개의 검토가 완료되어야 합니다.");
  return Promise.all(
    job.creativeVariants.map(async (variant) => {
      const asset = job.artifacts.find(
        (item) => item.id === variant.approvedImageId && item.kind === "image",
      );
      if (!asset) throw new BlockedError("각 광고 가설의 검토된 이미지가 필요합니다.");
      const bytes = new Uint8Array(await (await artifacts.read(job.id, asset.name)).arrayBuffer());
      if (
        variant.reviewStatus !== "pass" ||
        contentDigest(bytes) !== variant.approvedImageDigest ||
        contentDigest(JSON.stringify(variant.creative)) !== variant.approvedCreativeDigest
      )
        throw new StudioError(
          "review_binding",
          "AI가 검토한 이미지·카피와 배포 산출물이 일치하지 않습니다.",
        );
      return { id: variant.id, artifactId: asset.id, creative: variant.creative, bytes };
    }),
  );
}

export function checkVariantBindings(job: Job, stage: Stage): void {
  checkSourceVariants(job);
  if (
    stage.variants.length !== 3 ||
    job.creativeVariants.length !== 3 ||
    new Set(stage.variants.map((variant) => variant.id)).size !== 3 ||
    new Set(job.creativeVariants.map((variant) => variant.id)).size !== 3
  )
    throw new StudioError(
      "review_binding",
      "검토한 광고 가설 3개와 배포 묶음이 일치하지 않습니다.",
    );
  for (const staged of stage.variants) {
    const approved = job.creativeVariants.find((variant) => variant.id === staged.id);
    if (
      approved?.reviewStatus !== "pass" ||
      approved.approvedImageId !== staged.artifactId ||
      !approved.approvedImageDigest ||
      contentDigest(JSON.stringify(staged.creativeSnapshot)) !== approved.approvedCreativeDigest ||
      contentDigest(JSON.stringify(approved.creative)) !== approved.approvedCreativeDigest
    )
      throw new StudioError(
        "review_binding",
        "AI 검토 승인과 Meta 배포 스냅샷이 일치하지 않습니다.",
      );
  }
  const first = stage.variants[0];
  if (
    !first ||
    stage.artifactId !== first.artifactId ||
    stage.adId !== first.adId ||
    stage.creativeId !== first.creativeId ||
    stage.imageHash !== first.imageHash
  )
    throw new StudioError("review_binding", "대표 광고와 광고 묶음 스냅샷이 일치하지 않습니다.");
}

export function stageComplete(job: Job): boolean {
  const stage = job.staged;
  if (!stage || stage.pendingOperation || !stage.campaignId || !stage.adsetId || !stage.adId)
    return false;
  if (job.creativeVariants.length === 0 && !job.sourceSnapshot) return stage.variants.length === 0;
  checkVariantBindings(job, stage);
  return stage.variants.every((variant) => variant.adId && variant.creativeId && variant.imageHash);
}
