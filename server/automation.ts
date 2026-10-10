import type { AutomationPolicy } from "../shared/automation";
import { flowImagesReady } from "../shared/flow-images";
import { flowReady } from "../shared/flow-mode";
import type { Job } from "../shared/schema";
import { scriptApprovalReady } from "../shared/script-approval";
import { AutomationEnrollment } from "./automation-enrollment";
import { AutomationGuard } from "./automation-guard";
import { type AutomationServices, automationServices } from "./automation-services";
import { BlockedError, publicError, StudioError, WaitingError } from "./errors";
import { logger } from "./logger";
import type { JobStore } from "./store";

// 완료 문구: 완성 영상 수와 그 안의 Veo 클립·정지 이미지·내레이션 문장·BGM 여부를 renders 와 산출물에서 센다.
export function completionMessage(job: Job, imageCount: number): string {
  const finals = job.renders.filter((render) => render.final);
  const clips = finals.reduce(
    (sum, render) => sum + Object.values(render.clips).filter((clip) => clip?.name).length,
    0,
  );
  const stills = finals.reduce(
    (sum, render) => sum + Object.values(render.stills).filter((still) => still?.name).length,
    0,
  );
  const voiceNames = new Set(
    job.artifacts
      .filter((asset) => asset.kind === "audio")
      .map((asset) => asset.name.replace(/-\d\.wav$/, "")),
  );
  const bgm = finals.some((render) => render.final?.bgmTrackId);
  const videos =
    finals.length > 0
      ? ` · 완성 영상 ${finals.length}개(Veo 클립 ${clips}개·정지 이미지 ${stills}장·내레이션 ${voiceNames.size}문장·BGM ${bgm ? "포함" : "없음"})`
      : "";
  return `광고소재 제작 완료 · 이미지 ${imageCount}개${videos}`;
}
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
  // Flow 모드에서 클립이 업로드될 때 부른다: 기다리던 영상의 클립이 모두 들어왔으면 곧바로 이어서 실행한다.
  // 대기(waiting)가 아니면(아직 실행 중이거나 중지 등) 아무것도 바꾸지 않는다. 실행 중이던 작업이 곧 대기에 들어가는
  // 경합은 execute 의 park 가 같은 조건(flowReady)을 다시 검사해 메운다.
  wakeImages(id: string): boolean {
    return this.wakeWaiting(
      id,
      flowImagesReady,
      "Flow 이미지 업로드가 완료되어 검토와 제작을 이어갑니다.",
    );
  }
  wakeFlow(id: string): boolean {
    return this.wakeWaiting(id, flowReady, "Flow 클립이 모두 업로드되어 제작을 이어갑니다.");
  }
  // 대본 승인이 올 때 부른다: 모든 영상 대본이 승인됐으면 곧바로 이어서 실행한다(내레이션 합성부터).
  wakeScripts(id: string): boolean {
    return this.wakeWaiting(
      id,
      (job) => job.automation?.phase === "script" && scriptApprovalReady(job),
      "영상 대본이 모두 승인되어 제작을 이어갑니다.",
    );
  }
  private wakeWaiting(id: string, ready: (job: Job) => boolean, message: string): boolean {
    const job = this.store.get(id);
    const state = job.automation;
    if (state?.status !== "waiting" || state.policy.mode !== "creative" || state.nextRunAt !== null)
      return false;
    if (!ready(job)) return false;
    this.store.change(id, (draft) => {
      if (!draft.automation) return;
      draft.automation.status = "queued";
      draft.automation.nextRunAt = new Date().toISOString();
      draft.status = "queued";
      this.store.event(draft, "production", "info", message);
    });
    this.wake();
    return true;
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
              ? completionMessage(draft, policy.imageCount ?? (draft.sourceSnapshot ? 3 : 1))
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
      if (error instanceof WaitingError) {
        this.park(id, error);
        return;
      }
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
      // 운영 오류 확인: 일반 Error 는 사용자 메시지가 "작업 처리에 실패했습니다" 뿐이라 원인을 알 수 없었다 → 이름·메시지·스택 앞부분을 남긴다(키·본문은 없음).
      logger.warn(
        {
          jobId: id,
          code: error instanceof StudioError ? error.code : "provider",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack:
            error instanceof Error
              ? (error.stack ?? "").split("\n").slice(0, 6).join(" | ")
              : undefined,
        },
        "automation.attention",
      );
      const pending = this.store.get(id).staged?.pendingOperation;
      if (pending === "publish" || pending?.startsWith("publish:")) await this.pause(id);
    }
  }
  // 사용자 작업을 기다리는 정상 대기: 실패가 아니라서 lastError 를 비우고 nextRunAt 없이 'waiting' 으로 둔다
  // (tick 은 nextRunAt 이 있는 waiting 만 실행하므로 업로드가 올 때까지 다시 돌지 않는다).
  // 대기에 들어가는 순간 이미 입력이 도착해 있으면(업로드 경합) 기다리지 않고 바로 다시 큐에 넣는다.
  private park(id: string, waiting: WaitingError): void {
    this.store.change(id, (draft) => {
      const state = draft.automation;
      if (!state) return;
      state.lastError = null;
      state.operation = null;
      if (waiting.ready(draft)) {
        state.status = "queued";
        state.nextRunAt = new Date().toISOString();
        draft.status = "queued";
        return;
      }
      state.status = "waiting";
      state.nextRunAt = null;
      draft.status = "review";
      draft.result = waiting.message;
      for (const agent of draft.agents)
        if (agent.status === "running") {
          agent.status = "review";
          agent.action = waiting.message;
          agent.finishedAt = null;
        }
      if (!draft.events.slice(-3).some((event) => event.message === waiting.message))
        this.store.event(draft, "production", "info", waiting.message);
    });
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
