import { ArrowDown, Check, Layers3 } from "lucide-react";
import type { AgentId, Job } from "../shared/schema";
import { agentIds } from "../shared/schema";
import { agentMeta } from "./agentMeta";
import { StatusBadge } from "./primitives";

function productionCompleted(job: Job | null): boolean {
  return job?.agents.find((agent) => agent.id === "production")?.status === "completed";
}

export function AgentBoard({
  job,
  selected,
  onSelect,
}: {
  readonly job: Job | null;
  readonly selected: AgentId | null;
  readonly onSelect: (id: AgentId) => void;
}) {
  const ids =
    job?.staged || (job?.automation && job.automation.policy.mode !== "creative")
      ? agentIds
      : agentIds.slice(0, 3);
  const completeCount =
    job?.agents.filter((agent) => ids.includes(agent.id) && agent.status === "completed").length ??
    0;
  const stageCount = ids.includes("production") ? ids.length + 1 : ids.length;
  const completedStages =
    ids.includes("production") && productionCompleted(job) ? completeCount + 1 : completeCount;
  const renderRow = (id: AgentId, label?: string) => {
    const meta = agentMeta[id];
    const agent = job?.agents.find((item) => item.id === id);
    const Icon = meta.icon;
    return (
      <button
        type="button"
        className={`agent-row ${selected === id ? "selected" : ""}`}
        key={`${id}-${label ?? ""}`}
        onClick={() => onSelect(id)}
        aria-pressed={selected === id}
      >
        <div className="agent-path">
          <span className={`agent-icon ${agent?.status === "completed" ? "done" : ""}`}>
            {agent?.status === "completed" ? <Check size={19} /> : <Icon size={19} />}
          </span>
        </div>
        <div className="agent-main">
          <strong>{label ?? `${meta.title} 에이전트`}</strong>
          <p>{agent?.action || meta.description}</p>
        </div>
        <StatusBadge status={agent?.status ?? "idle"} />
      </button>
    );
  };
  return (
    <section className="panel agent-board">
      <header className="panel-header spread">
        <div className="cluster">
          <Layers3 size={17} />
          <h2>에이전트 워크플로</h2>
          <span className="muted small-copy">{stageCount}단계</span>
        </div>
        <span className="workflow-count">
          {completedStages}
          <span> / {stageCount} 완료</span>
        </span>
      </header>
      <div className="agent-rows">
        {ids
          .filter((id) => id !== "production")
          .map((id, index) => {
            const meta = agentMeta[id];
            const agent = job?.agents.find((item) => item.id === id);
            const Icon = meta.icon;
            return (
              <button
                type="button"
                className={`agent-row ${selected === id ? "selected" : ""}`}
                key={id}
                onClick={() => onSelect(id)}
                aria-pressed={selected === id}
              >
                <div className="agent-path">
                  <span className={`agent-icon ${agent?.status === "completed" ? "done" : ""}`}>
                    {agent?.status === "completed" ? <Check size={19} /> : <Icon size={19} />}
                  </span>
                  {index < ids.length - 1 && <ArrowDown size={12} className="path-arrow" />}
                </div>
                <div className="agent-main">
                  <strong>{meta.title} 에이전트</strong>
                  <p>{agent?.action || meta.description}</p>
                </div>
                <StatusBadge status={agent?.status ?? "idle"} />
              </button>
            );
          })}
        {ids.includes("production") && (
          <>
            <div className="workflow-lane-title">이미지 제작 워크플로</div>
            {renderRow("production", "이미지 제작 에이전트")}
            <div className="workflow-lane-title">영상 제작 워크플로</div>
            {renderRow("production", "영상 제작 에이전트")}
          </>
        )}
      </div>
      <div className="board-caption">
        <span className="tiny-dot" />
        {job
          ? "단계를 선택하면 해당 결과물을 확인할 수 있어요."
          : "브리프를 만들면 전략부터 순서대로 작업을 시작합니다."}
      </div>
    </section>
  );
}
