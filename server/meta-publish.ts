import { z } from "zod";
import type { Job } from "../shared/schema";
import { AutomationGuard } from "./automation-guard";
import { StudioError } from "./errors";
import { MetaClient } from "./meta-client";
import { type ApprovedStage, stageAds, verifyRemoteStage } from "./meta-publish-verify";
import { stageComplete } from "./meta-stage-variants";
import type { JobStore } from "./store";

export function approvedStage(job: Job, digest: string): ApprovedStage {
  const stage = job.staged;
  if (
    job.status !== "review" ||
    !stage ||
    stage.digest !== digest ||
    stage.publishedAt ||
    stage.pendingOperation ||
    !stage.campaignId ||
    !stage.adsetId ||
    !stage.creativeId ||
    !stage.adId ||
    !stageComplete(job)
  )
    throw new StudioError("approval", "현재 배포 설정과 일치하는 검토 승인이 필요합니다.");
  if (
    job.accountId !== stage.accountId ||
    job.dailyBudget !== stage.dailyBudget ||
    job.currency !== stage.currency ||
    job.country !== stage.country ||
    job.objective !== stage.objective ||
    job.selection?.pageId !== stage.pageId
  )
    throw new StudioError("approval_changed", "승인 대상 설정이 변경되었습니다.");
  return {
    ...stage,
    campaignId: stage.campaignId,
    adsetId: stage.adsetId,
    creativeId: stage.creativeId,
    adId: stage.adId,
  };
}

export async function publishJob(
  store: JobStore,
  approval: {
    readonly id: string;
    readonly digest: string;
    readonly signal?: AbortSignal;
    readonly client?: MetaClient;
  },
): Promise<Job> {
  const job = store.get(approval.id);
  const stage = approvedStage(job, approval.digest);
  const ads = stageAds(stage);
  const client = approval.client ?? new MetaClient();
  const signal = approval.signal ?? new AbortController().signal;
  const check = () => {
    signal.throwIfAborted();
    if (job.automation) new AutomationGuard(store).check(job.id, signal);
  };
  check();
  await verifyRemoteStage(job, stage, client);
  check();
  approvedStage(store.get(job.id), approval.digest);
  store.change(job.id, (draft) => {
    draft.status = "running";
    if (draft.staged) draft.staged.pendingOperation = "publish";
    store.event(
      draft,
      "deployment",
      "info",
      "승인 범위와 Meta 한도를 확인했습니다. 광고 → 광고 세트 → 캠페인을 활성화합니다.",
    );
  });
  for (const id of [...ads.map((variant) => variant.adId), stage.adsetId, stage.campaignId]) {
    check();
    store.change(job.id, (draft) => {
      if (draft.staged) draft.staged.pendingOperation = `publish:${id}`;
    });
    z.object({ success: z.literal(true) }).parse(await client.post(id, { status: "ACTIVE" }));
    store.change(job.id, (draft) => {
      if (draft.staged) {
        draft.staged.pendingOperation = "publish";
        const variant = draft.staged.variants.find((item) => item.adId === id);
        if (variant) variant.deliveryStatus = "ACTIVE_REQUESTED";
      }
    });
  }
  const deliveries = await Promise.all(
    ads.map(async (variant) => ({
      id: variant.id,
      status: z
        .object({ effective_status: z.string() })
        .parse(await client.get(variant.adId, { fields: "effective_status" })).effective_status,
    })),
  );
  check();
  store.agent(job.id, "deployment", {
    status: "completed",
    action: "Meta 활성화 요청 완료 · 심사와 실제 게재는 Meta에서 결정합니다.",
  });
  return store.change(job.id, (draft) => {
    draft.status = "completed";
    draft.result = "게시 요청 완료 · 자동 성과 분석 대기";
    if (draft.staged) {
      draft.staged.pendingOperation = null;
      draft.staged.publishedAt = new Date().toISOString();
      draft.staged.deliveryStatus = deliveries[0]?.status ?? null;
      for (const variant of draft.staged.variants)
        variant.deliveryStatus = deliveries.find((item) => item.id === variant.id)?.status ?? null;
    }
  });
}

export async function pauseJob(store: JobStore, job: Job, client?: MetaClient): Promise<void> {
  if (!job.staged?.campaignId) return;
  const meta = client ?? new MetaClient();
  store.change(job.id, (draft) => {
    if (draft.staged) draft.staged.pendingOperation = "pause";
  });
  z.object({ success: z.literal(true) }).parse(
    await meta.post(job.staged.campaignId, { status: "PAUSED" }),
  );
  const remote = z
    .object({ status: z.literal("PAUSED") })
    .parse(await meta.get(job.staged.campaignId, { fields: "status" }));
  store.change(job.id, (draft) => {
    if (draft.staged) {
      draft.staged.deliveryStatus = remote.status;
      draft.staged.pendingOperation = null;
      for (const variant of draft.staged.variants) variant.deliveryStatus = remote.status;
    }
    draft.result = "자동 운영 중지 · Meta 캠페인 PAUSED 확인 완료";
    store.event(draft, "deployment", "success", draft.result);
  });
}
