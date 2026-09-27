import { createHash } from "node:crypto";
import type { AutomationPolicy, AutomationState } from "../shared/automation";
import { CreateJobSchema, type Job } from "../shared/schema";
import { MissingConnectionError, StudioError } from "./errors";
import { budgetMinorUnits } from "./meta-client";
import { factualSources } from "./source-evidence";
import type { JobStore } from "./store";

export function contentDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scopeDigest(job: Job, policy: AutomationPolicy): string {
  const brief = CreateJobSchema.parse(
    Object.fromEntries(
      Object.keys(CreateJobSchema.shape).map((key) => [key, Reflect.get(job, key)]),
    ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        brief: Object.fromEntries(
          Object.entries(brief).filter(([key, value]) => key !== "projectId" || value !== null),
        ),
        selection: job.selection,
        accountId: job.accountId,
        models: job.executionModels,
        ...(job.sourceSnapshot ? { sourceSnapshot: job.sourceSnapshot } : {}),
        policy,
      }),
    )
    .digest("hex");
}
export function validatePolicy(job: Job, policy: AutomationPolicy): void {
  if (policy.mode === "creative") {
    if (!job.sourceSnapshot && (policy.videoCount ?? 0) > 0)
      throw new StudioError(
        "video_project",
        "영상 소재는 제품 자료가 있는 프로젝트에서 제작하세요.",
        400,
      );
    if (!job.sourceSnapshot && (policy.imageCount ?? 1) !== 1)
      throw new StudioError(
        "image_count",
        "여러 이미지 소재를 만들려면 제품 사실이 담긴 프로젝트를 선택하세요.",
        400,
      );
    return;
  }
  if (
    job.sourceSnapshot &&
    factualSources(job.sourceSnapshot).some(
      (source) =>
        source.expiresAt !== null && Date.parse(source.expiresAt) < Date.parse(policy.endAt),
    )
  )
    throw new StudioError(
      "source_expiry",
      "운영 종료 시각은 제품 사실·오퍼 자료의 유효기간 이내여야 합니다. 자료를 갱신한 새 작업을 만들거나 종료 시각을 조정하세요.",
      400,
    );
  if (!job.selection?.pageId || job.accountId !== job.selection.accountId || !job.dailyBudget)
    throw new StudioError("scope", "자동 운영 전 광고 계정, 페이지와 일일 예산을 명시하세요.", 400);
  if (job.objective === "sales" && !job.selection.pixelId)
    throw new StudioError("scope", "판매 목표에는 Pixel ID가 필요합니다.", 400);
  if (policy.maxTotalSpend < job.dailyBudget)
    throw new StudioError("scope", "전체 지출 한도는 일일 예산 이상이어야 합니다.", 400);
  const duration = Date.parse(policy.endAt) - Date.now();
  if (duration <= 0 || duration > 366 * 86400000)
    throw new StudioError("expiry", "종료 시각은 현재 이후, 1년 이내로 설정하세요.", 400);
  budgetMinorUnits(policy.maxTotalSpend, job.currency);
  budgetMinorUnits(job.dailyBudget, job.currency);
}
export class AutomationGuard {
  constructor(readonly store: JobStore) {}
  check(id: string, signal: AbortSignal): Job {
    signal.throwIfAborted();
    const job = this.store.get(id);
    const state = job.automation;
    if (!state || state.status === "stopped" || state.status === "completed")
      throw new StudioError("stopped", "자동 운영이 중지되었습니다.");
    if (state.scopeDigest !== scopeDigest(job, state.policy))
      throw new StudioError(
        "scope_changed",
        "승인한 제품·계정·예산·모델·운영 범위가 변경되어 자동 운영을 차단했습니다.",
      );
    if (
      state.approvedPlanDigest &&
      (!job.creativePlan ||
        state.approvedPlanDigest !== contentDigest(JSON.stringify(job.creativePlan)) ||
        job.creativeVariants.length !==
          (state.policy.mode === "creative" ? (state.policy.imageCount ?? 3) : 3) ||
        job.creativePlan.hypotheses.some((hypothesis) => {
          const variant = job.creativeVariants.find((item) => item.id === hypothesis.id);
          return (
            !variant || JSON.stringify(variant.creative) !== JSON.stringify(hypothesis.creative)
          );
        }))
    )
      throw new StudioError(
        "plan_changed",
        "검토한 기획·가설·카피가 변경되어 자동 운영을 차단했습니다.",
      );
    if (state.policy.mode !== "creative" && Date.parse(state.policy.endAt) <= Date.now())
      throw new StudioError("expired", "승인한 자동 운영 종료 시각에 도달했습니다.");
    return job;
  }
  async operation<T>(
    id: string,
    request: {
      readonly phase: AutomationState["phase"];
      readonly signal: AbortSignal;
      readonly run: () => Promise<T>;
    },
  ): Promise<T> {
    this.check(id, request.signal);
    this.store.change(id, (job) => {
      if (job.automation) {
        job.automation.phase = request.phase;
        job.automation.operation = request.phase;
      }
    });
    try {
      const value = await request.run();
      this.store.change(id, (job) => {
        if (job.automation) job.automation.operation = null;
      });
      this.check(id, request.signal);
      return value;
    } catch (error) {
      if (error instanceof MissingConnectionError && !this.store.get(id).staged?.pendingOperation)
        this.store.change(id, (job) => {
          if (job.automation) job.automation.operation = null;
        });
      throw error;
    }
  }
}
