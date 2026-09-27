import type { AutomationPolicy } from "../shared/automation";
import type { Job } from "../shared/schema";
import { AutomationEnrollment } from "./automation-enrollment";
import { AutomationGuard } from "./automation-guard";
import { type AutomationServices, automationServices } from "./automation-services";
import { BlockedError, publicError, StudioError } from "./errors";
import { logger } from "./logger";
import type { JobStore } from "./store";

export class AutomationEngine {
  readonly active = new Map<
    string,
    { readonly controller: AbortController; readonly promise: Promise<void> }
  >();
  readonly services: AutomationServices;
  readonly guard: AutomationGuard;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: string | null = null;
  constructor(
    readonly store: JobStore,
    services?: AutomationServices,
  ) {
    this.services = services ?? automationServices(store);
    this.guard = new AutomationGuard(store);
  }
  state() {
    return {
      running: this.timer !== null,
      activeJobs: this.active.size,
      lastTickAt: this.lastTickAt,
    };
  }
  open(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 1000);
    this.wake();
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.active.values()) task.controller.abort();
  }
  wake(): void {
    void this.tick().catch((error) => {
      logger.error(
        { code: error instanceof StudioError ? error.code : "worker" },
        "automation.tick.failed",
      );
    });
  }
  start(id: string, policy: AutomationPolicy): Job {
    const job = new AutomationEnrollment(this.store).start(id, policy);
    this.wake();
    return job;
  }
  resume(id: string): Job {
    const job = new AutomationEnrollment(this.store).resume(id);
    this.wake();
    return job;
  }
  wakeBlocked(): void {
    new AutomationEnrollment(this.store).wakeBlocked();
    this.wake();
  }
  async stop(id: string): Promise<Job> {
    const job = this.store.get(id);
    if (!job.automation) throw new StudioError("automation", "자동 운영 작업이 아닙니다.");
    if (job.automation.status === "stopped") return job;
    this.markStopped(id, "사용자가 자동 운영을 중지했습니다.");
    const active = this.active.get(id);
    active?.controller.abort();
    await active?.promise;
    await this.pause(id);
    return this.store.get(id);
  }
  async tick(): Promise<void> {
    this.lastTickAt = new Date().toISOString();
    const pending: Promise<void>[] = [];
    for (const job of this.store.list()) {
      const state = job.automation;
      if (!state || this.active.has(job.id) || ["stopped", "completed"].includes(state.status))
        continue;
      const expired =
        state.policy.mode !== "creative" && Date.parse(state.policy.endAt) <= Date.now();
      if (
        !expired &&
        (!state.nextRunAt ||
          Date.parse(state.nextRunAt) > Date.now() ||
          !["queued", "waiting"].includes(state.status))
      )
        continue;
      if (!this.store.claimAutomation(job.id)) continue;
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => this.execute(job.id, controller.signal))
        .finally(() => this.active.delete(job.id));
      this.active.set(job.id, { controller, promise });
      pending.push(promise);
    }
    await Promise.all(pending);
  }
  private async execute(id: string, signal: AbortSignal): Promise<void> {
    try {
      const initial = this.store.get(id);
      if (
        initial.automation?.policy.mode !== "creative" &&
        initial.automation &&
        Date.parse(initial.automation.policy.endAt) <= Date.now()
      ) {
        this.markStopped(id, "승인한 자동 운영 종료 시각에 도달했습니다.");
        await this.pause(id);
        return;
      }
      let job = this.guard.check(id, signal);
      this.store.change(id, (draft) => {
        if (draft.automation) {
          draft.automation.status = "running";
          draft.automation.lastError = null;
        }
        draft.status = "running";
      });
      if (job.automation?.policy.mode === "creative") {
        await this.services.produce(id, signal);
        this.guard.check(id, signal);
        this.store.change(id, (draft) => {
          if (draft.automation) {
            draft.automation.status = "completed";
            draft.automation.phase = "finished";
            draft.automation.nextRunAt = null;
          }
          draft.status = "completed";
          const policy = draft.automation?.policy;
          draft.result =
            policy?.mode === "creative"
              ? `광고소재 제작 완료 · 이미지 ${policy.imageCount ?? (draft.sourceSnapshot ? 3 : 1)}개 · Veo 원본 클립 ${policy.videoCount ?? 0}개 · 최종 영상 편집 별도`
              : "광고소재 제작 완료";
          this.store.event(draft, null, "success", draft.result);
        });
        return;
      }
      if (!job.staged?.publishedAt) {
        await this.services.prepare(id, signal);
        job = this.guard.check(id, signal);
        if (job.automation?.policy.mode === "prepare") {
          this.store.change(id, (draft) => {
            if (draft.automation) {
              draft.automation.status = "completed";
              draft.automation.phase = "finished";
              draft.automation.nextRunAt = null;
            }
          });
          return;
        }
        await this.services.activate(job, signal);
      }
      job = this.guard.check(id, signal);
      await this.services.analyze(job, signal);
      job = this.guard.check(id, signal);
      if (
        job.metrics &&
        job.automation &&
        job.automation.policy.mode !== "creative" &&
        job.metrics.spend >= job.automation.policy.maxTotalSpend
      ) {
        this.markStopped(id, "승인한 전체 지출 한도에 도달했습니다.");
        await this.pause(id);
        return;
      }
      this.store.change(id, (draft) => {
        if (!draft.automation) return;
        if (draft.automation.policy.mode === "creative") return;
        const next = new Date(
          Math.min(
            Date.now() + draft.automation.policy.analysisIntervalMinutes * 60000,
            Date.parse(draft.automation.policy.endAt),
          ),
        ).toISOString();
        draft.automation.status = "waiting";
        draft.automation.phase = "insights";
        draft.automation.nextRunAt = next;
        draft.automation.nextAnalysisAt = next;
        draft.status = "completed";
        draft.result = "자동 운영 중 · 다음 실제 성과 조회 대기";
      });
    } catch (error) {
      if (signal.aborted || this.store.get(id).automation?.status === "stopped") return;
      if (error instanceof StudioError && error.code === "expired") {
        this.markStopped(id, error.message);
        await this.pause(id);
        return;
      }
      const message = publicError(error);
      this.store.change(id, (draft) => {
        if (!draft.automation) return;
        const uncertain = Boolean(draft.automation.operation || draft.staged?.pendingOperation);
        draft.automation.status =
          error instanceof BlockedError && !uncertain ? "blocked" : "attention";
        draft.automation.lastError = message;
        draft.automation.nextRunAt = null;
        draft.status = "blocked";
        draft.result = message;
        for (const agent of draft.agents)
          if (agent.status === "running") {
            agent.status = "blocked";
            agent.action = message;
            agent.finishedAt = new Date().toISOString();
          }
        this.store.event(draft, null, "error", message);
      });
      logger.warn(
        { jobId: id, code: error instanceof StudioError ? error.code : "provider" },
        "automation.attention",
      );
      const pending = this.store.get(id).staged?.pendingOperation;
      if (pending === "publish" || pending?.startsWith("publish:")) await this.pause(id);
    }
  }
  private markStopped(id: string, message: string): void {
    this.store.change(id, (draft) => {
      if (draft.automation) {
        draft.automation.status = "stopped";
        draft.automation.stoppedAt = new Date().toISOString();
        draft.automation.nextRunAt = null;
        draft.automation.nextAnalysisAt = null;
      }
      draft.status = "cancelled";
      draft.result = `${message} · 자동 실행 중지`;
      for (const agent of draft.agents)
        if (agent.status === "running") {
          agent.status = "cancelled";
          agent.action = draft.result;
          agent.finishedAt = new Date().toISOString();
        }
      this.store.event(draft, null, "warning", draft.result);
    });
  }
  private async pause(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job.staged?.campaignId || job.staged.pendingOperation === "pause") return;
    try {
      await this.services.pause(job);
    } catch (error) {
      const message = `자동 실행은 중지됨 · Meta PAUSED 확인 실패: ${publicError(error)} 광고 관리자에서 직접 확인하세요.`;
      this.store.change(id, (draft) => {
        draft.result = message;
        if (draft.automation) draft.automation.lastError = message;
        this.store.event(draft, "deployment", "error", message);
      });
      logger.warn(
        { jobId: id, code: error instanceof StudioError ? error.code : "pause" },
        "automation.pause.failed",
      );
    }
  }
}
