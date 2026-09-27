import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentId,
  type AgentState,
  agentIds,
  type CreateJob,
  type Job,
  JobIdSchema,
  JobSchema,
} from "../shared/schema";
import { StudioError } from "./errors";
import { captureProductionSources } from "./production-snapshot";
import { ProjectStore } from "./project-store";

const names = {
  strategy: "전략 에이전트",
  creative: "기획 에이전트",
  production: "제작 에이전트",
  deployment: "배포 에이전트",
  analysis: "분석 에이전트",
} as const;
const RowSchema = z.object({ body: z.string() });
export class JobStore {
  readonly db: Database;
  readonly listeners = new Set<() => void>();
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(join(root, "studio.sqlite"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    for (const job of this.list()) {
      if (job.automation && ["running", "queued", "waiting"].includes(job.automation.status))
        this.change(job.id, (draft) => {
          const state = draft.automation;
          if (!state) return;
          const uncertain = Boolean(state.operation || draft.staged?.pendingOperation);
          state.status = uncertain ? "attention" : "queued";
          state.lastError = uncertain
            ? "서버 재시작 전 외부 요청 결과가 불확실합니다. 자동 재요청은 차단됩니다."
            : null;
          state.nextRunAt = uncertain ? null : (state.nextRunAt ?? new Date().toISOString());
          draft.status = uncertain ? "blocked" : "queued";
          draft.result = state.lastError;
          for (const agent of draft.agents)
            if (agent.status === "running") {
              agent.status = uncertain ? "blocked" : "queued";
              agent.action = state.lastError ?? "서버 재시작 · 자동 운영 재개 대기";
            }
          this.event(
            draft,
            null,
            "warning",
            uncertain ? (state.lastError ?? "요청 확인 필요") : "저장된 자동 운영을 재개합니다.",
          );
        });
      else if (
        job.automation?.status === "attention" &&
        job.agents.some((agent) => agent.status === "running")
      )
        this.change(job.id, (draft) => {
          for (const agent of draft.agents)
            if (agent.status === "running") {
              agent.status = "blocked";
              agent.action =
                draft.automation?.lastError ?? "서버 재시작 · 외부 요청 결과 확인 필요";
            }
        });
      else if (job.status === "running")
        this.change(job.id, (draft) => {
          draft.status = "blocked";
          draft.result = "서버 재시작으로 중단되었습니다. 외부 작업 결과를 확인한 후 재개하세요.";
          for (const agent of draft.agents)
            if (agent.status === "running") {
              agent.status = "blocked";
              agent.action = draft.result;
            }
          this.event(draft, null, "warning", draft.result);
        });
    }
  }
  list(): Job[] {
    return this.db
      .query("SELECT body FROM jobs ORDER BY rowid DESC")
      .all()
      .map((row) => JobSchema.parse(JSON.parse(RowSchema.parse(row).body)));
  }
  get(id: string): Job {
    const row = this.db.query("SELECT body FROM jobs WHERE id = ?").get(JobIdSchema.parse(id));
    if (!row) throw new StudioError("not_found", "작업을 찾을 수 없습니다.", 404);
    return JobSchema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  create(input: CreateJob): Job {
    const now = new Date().toISOString();
    const job: Job = {
      ...input,
      id: JobIdSchema.parse(crypto.randomUUID()),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      agents: agentIds.map((id) => ({
        id,
        name: names[id],
        status: "idle",
        action: "선행 단계 대기",
        startedAt: null,
        finishedAt: null,
      })),
      events: [],
      artifacts: [],
      accountId: null,
      selection: null,
      staged: null,
      metrics: null,
      result: null,
      executionModels: null,
      automation: null,
      sourceSnapshot: input.projectId ? new ProjectStore(this.db).snapshot(input.projectId) : null,
      productionSourceSnapshot: input.projectId
        ? captureProductionSources(new ProjectStore(this.db), this.root, input.projectId)
        : null,
      creativePlan: null,
      videoScripts: [],
      creativeVariants: [],
      variantMetrics: [],
    };
    this.event(
      job,
      null,
      "info",
      "브리프가 저장되었습니다. 실행하면 실제 공급자 작업을 시작합니다.",
    );
    this.save(job);
    return job;
  }
  change(id: string, mutate: (job: Job) => void): Job {
    const job = this.get(id);
    mutate(job);
    job.updatedAt = new Date().toISOString();
    this.save(job);
    return job;
  }
  claimAutomation(id: string): boolean {
    return this.db.transaction(() => {
      const job = this.get(id);
      const state = job.automation;
      if (!state || ["running", "stopped", "completed"].includes(state.status)) return false;
      const expired =
        state.policy.mode !== "creative" && Date.parse(state.policy.endAt) <= Date.now();
      if (
        !expired &&
        (!["queued", "waiting"].includes(state.status) ||
          !state.nextRunAt ||
          Date.parse(state.nextRunAt) > Date.now())
      )
        return false;
      state.status = "running";
      job.status = "running";
      job.updatedAt = new Date().toISOString();
      this.save(job);
      return true;
    })();
  }
  event(
    job: Job,
    agentId: AgentId | null,
    kind: Job["events"][number]["kind"],
    message: string,
  ): void {
    job.events.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      agentId,
      kind,
      message,
    });
  }
  agent(id: string, agentId: AgentId, state: Pick<AgentState, "status" | "action">): Job {
    return this.change(id, (job) => {
      const agent = job.agents.find((item) => item.id === agentId);
      if (!agent) throw new StudioError("agent_missing", "에이전트 상태가 유효하지 않습니다.");
      Object.assign(agent, state);
      if (state.status === "running") {
        agent.startedAt = new Date().toISOString();
        agent.finishedAt = null;
      }
      if (["completed", "blocked", "failed", "cancelled"].includes(state.status))
        agent.finishedAt = new Date().toISOString();
      this.event(
        job,
        agentId,
        state.status === "completed" ? "success" : state.status === "blocked" ? "warning" : "info",
        state.action,
      );
    });
  }
  private save(job: Job): void {
    this.db
      .query("INSERT OR REPLACE INTO jobs (id, body) VALUES (?, ?)")
      .run(job.id, JSON.stringify(job));
    for (const listener of this.listeners) listener();
  }
  close(): void {
    this.db.close();
  }
}
