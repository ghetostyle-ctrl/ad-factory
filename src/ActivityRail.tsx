import { Activity, ArrowUpRight, Radio } from "lucide-react";
import type { Job } from "../shared/schema";
import { agentMeta } from "./agentMeta";
import { timeLabel } from "./api";

export function ActivityRail({ job, live }: { readonly job: Job | null; readonly live: boolean }) {
  const events = job?.events.slice().reverse() ?? [];
  return (
    <aside className="activity-rail" aria-label="실행 기록">
      <div className="spread activity-heading">
        <h2>실행 기록</h2>
        <span className={`stream-status ${live ? "connected" : ""}`}>
          <Radio size={12} />
          {live ? "실시간" : "연결 대기"}
        </span>
      </div>
      <p className="rail-description">에이전트의 실행과 결과를 확인하세요.</p>
      {events.length > 0 ? (
        <ol className="activity-list">
          {events.map((event) => (
            <li className={`activity-item activity-${event.kind}`} key={event.id}>
              <span className="event-mark" aria-hidden="true" />
              <div>
                <div className="spread">
                  <strong>{event.agentId ? agentMeta[event.agentId].title : "작업"}</strong>
                  <time dateTime={event.at}>{timeLabel(event.at)}</time>
                </div>
                <p>{event.message}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rail-empty">
          <Activity size={30} strokeWidth={1.4} />
          <h3>아직 실행 기록이 없어요</h3>
          <p>
            작업을 실행하면 도구 호출과
            <br />
            완료된 결과가 시간순으로 쌓입니다.
          </p>
        </div>
      )}
      <div className="rail-note">
        <ArrowUpRight size={14} />
        <p>
          상태는 실제 서버 기록을 반영합니다.
          <br />
          연결이 끊기면 새로고침으로 확인하세요.
        </p>
      </div>
    </aside>
  );
}
