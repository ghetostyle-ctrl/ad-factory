import type { AutomationPolicy } from "../shared/automation";
import type { Job } from "../shared/schema";
import { AutomationGuard, scopeDigest, validatePolicy } from "./automation-guard";
import { StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { snapshotModels } from "./model-settings";
import type { JobStore } from "./store";

export class AutomationEnrollment {
  constructor(readonly store: JobStore) {}
  start(id: string, policy: AutomationPolicy): Job {
    const job = this.store.get(id);
    if (job.automation || job.staged || job.status === "running" || job.artifacts.length > 0)
      throw new StudioError(
        "enrolled",
        "산출물이나 실행 이력이 없는 새 작업에서 자동 운영 범위를 승인하세요.",
      );
    validatePolicy(job, policy);
    if (job.sourceSnapshot && evidencePack(job.sourceSnapshot).facts.length === 0)
      throw new StudioError(
        "source_facts",
        "확인된 제품 사실 또는 오퍼 본문 자료가 있는 프로젝트로 새 작업을 만드세요.",
        400,
      );
    const models = job.executionModels ?? snapshotModels(this.store.root);
    if (
      models.textProvider === "none" ||
      (models.textProvider === "codex" && models.codexModel === null)
    )
      throw new StudioError(
        "model",
        "자동 운영에는 명시적인 텍스트 공급자와 모델 ID가 필요합니다. 모델 설정에서 선택하세요.",
        400,
      );
    const now = new Date().toISOString();
    const result = this.store.change(id, (draft) => {
      draft.executionModels = models;
      draft.automation = {
        policy,
        status: "queued",
        phase: "strategy",
        nextRunAt: now,
        nextAnalysisAt: null,
        lastError: null,
        authorizedAt: now,
        scopeDigest: scopeDigest(draft, policy),
        imageAttempts: 0,
        operation: null,
        videoOperation: null,
        stoppedAt: null,
        approvedImageId: null,
        approvedImageDigest: null,
        approvedCreativeDigest: null,
        approvedPlanDigest: null,
        lastAnalysisDigest: null,
      };
      draft.status = "queued";
      this.store.event(
        draft,
        null,
        "info",
        policy.mode === "creative"
          ? "소재 자동 제작 시작 · Meta 광고 계정 연결·게시·성과 조회 없음"
          : `자동 운영 범위 승인 완료 · ${policy.mode === "activate" ? "활성화 포함" : "PAUSED 준비만"} · 한도 ${policy.maxTotalSpend} ${draft.currency} · 종료 ${policy.endAt}`,
      );
      if (draft.sourceSnapshot)
        this.store.event(
          draft,
          null,
          "info",
          policy.mode === "creative"
            ? `자료 스냅샷 고정 · 이미지 ${policy.imageCount ?? 3}개 · 영상 ${policy.videoCount ?? 0}개 · 이미지 각 최대 2회 · Meta 전송 없음`
            : "자료 스냅샷 고정 · 가설 3개 · 이미지 각 최대 2회(총 최대 6회) · 하나의 캠페인/광고 세트 예산 공유",
        );
    });
    return result;
  }
  resume(id: string): Job {
    const job = this.store.get(id);
    const videoRecovery =
      job.automation?.status === "attention" &&
      job.automation.operation === "video" &&
      job.automation.videoOperation !== null;
    const retryableAiFailure =
      job.automation?.lastError?.startsWith("공급자 요청 실패 (HTTP ") === true ||
      job.automation?.lastError?.startsWith("AI 응답이 완료되지 않았습니다") === true ||
      job.automation?.lastError === "입력 또는 공급자 응답이 지원 형식과 일치하지 않습니다." ||
      job.automation?.lastError === "제품 주장 인용이 확인된 사실 자료 본문과 일치하지 않습니다.";
    const creativeStoppedRecovery =
      job.automation?.status === "stopped" && job.automation.policy.mode === "creative";
    const creativeReviewRecovery =
      job.automation?.status === "attention" && job.automation.policy.mode === "creative";
    if (
      (!videoRecovery &&
        !creativeStoppedRecovery &&
        !creativeReviewRecovery &&
        !retryableAiFailure &&
        !["blocked", "stopped"].includes(job.automation?.status ?? "")) ||
      (job.automation?.operation &&
        !videoRecovery &&
        !retryableAiFailure &&
        !creativeStoppedRecovery &&
        !creativeReviewRecovery) ||
      job.staged?.pendingOperation
    )
      throw new StudioError(
        "reconcile",
        "안전한 설정 대기 작업만 재개할 수 있습니다. 불확실한 외부 요청은 광고 관리자에서 확인하세요.",
      );
    if (job.automation && (job.automation.status === "stopped" || creativeReviewRecovery)) {
      if (
        (retryableAiFailure || creativeStoppedRecovery || creativeReviewRecovery) &&
        job.automation.operation
      ) {
        this.store.change(id, (draft) => {
          if (draft.automation) draft.automation.operation = null;
        });
      }
      if (job.automation.scopeDigest !== scopeDigest(job, job.automation.policy))
        throw new StudioError("scope_changed", "중지 후 작업 범위가 변경되어 재개할 수 없습니다.");
    } else {
      new AutomationGuard(this.store).check(id, new AbortController().signal);
    }
    const result = this.store.change(id, (draft) => {
      if (draft.automation) {
        if (videoRecovery) draft.automation.operation = null;
        draft.automation.status = "queued";
        draft.automation.lastError = null;
        draft.automation.nextRunAt = new Date().toISOString();
      }
      draft.status = "queued";
    });
    return result;
  }
  reset(id: string): Job {
    const job = this.store.get(id);
    if (job.status === "running")
      throw new StudioError("busy", "실행 중인 작업은 먼저 중지한 뒤 초기화하세요.");
    if (job.automation?.operation || job.staged?.pendingOperation)
      throw new StudioError("reconcile", "확인되지 않은 외부 작업이 있어 초기화할 수 없습니다.");
    return this.store.change(id, (draft) => {
      draft.status = "queued";
      draft.automation = null;
      draft.executionModels = null;
      draft.creativePlan = null;
      draft.videoScripts = [];
      draft.creativeVariants = [];
      draft.variantMetrics = [];
      draft.result = null;
      draft.metrics = null;
      draft.artifacts = draft.artifacts.filter((asset) => asset.name.startsWith("uploaded-"));
      for (const agent of draft.agents) {
        agent.status = "idle";
        agent.action = "초기화 완료 · 실행 대기";
        agent.startedAt = null;
        agent.finishedAt = null;
      }
      this.store.event(
        draft,
        null,
        "warning",
        "자동 운영과 생성 결과물을 초기화했습니다. 새로 시작할 수 있습니다.",
      );
    });
  }
  wakeBlocked(): void {
    for (const job of this.store.list())
      if (
        job.automation?.status === "blocked" &&
        !job.automation.operation &&
        !job.staged?.pendingOperation &&
        job.automation.scopeDigest === scopeDigest(job, job.automation.policy) &&
        (job.automation.policy.mode === "creative" ||
          Date.parse(job.automation.policy.endAt) > Date.now())
      ) {
        this.store.change(job.id, (draft) => {
          if (draft.automation) {
            draft.automation.status = "queued";
            draft.automation.nextRunAt = new Date().toISOString();
          }
        });
      }
  }
}
