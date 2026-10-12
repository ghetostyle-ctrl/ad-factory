import { Activity, Radio } from "lucide-react";
import type { ActivityEvent, Job } from "../shared/schema";
import { EventRow, groupEvents } from "./ActivityLog";

const RAIL_ROWS = 7;
// 레일에는 완성·확인할 점·당신 차례 신호만 올린다. 진행 로그(info)는 사용자가 움직일 일이 있는 말만 통과한다.
const ACTION_WORDS = /완성|올려|업로드|승인|대기/u;
export function isRailEvent(event: ActivityEvent): boolean {
  return event.kind !== "info" || ACTION_WORDS.test(event.message);
}

export function ActivityRail({
  job,
  live,
  onOpenLog,
}: {
  readonly job: Job;
  readonly live: boolean;
  readonly onOpenLog: () => void;
}) {
  const recent = groupEvents(job.events.filter(isRailEvent).reverse()).slice(0, RAIL_ROWS);
  return (
    <aside className="activity-rail" aria-label="최근 기록">
      <div className="rail-head">
        <h2>최근 기록</h2>
        <span className={`stream-status ${live ? "connected" : ""}`}>
          <Radio size={14} strokeWidth={1.75} aria-hidden="true" />
          {live ? "실시간" : "연결 대기"}
        </span>
      </div>
      <p className="rail-description">완성·확인할 점·당신 차례만 보여 주고 같은 안내는 묶습니다.</p>
      {recent.length > 0 ? (
        <ol className="event-list">
          {recent.map((group) => (
            <EventRow key={group.id} group={group} />
          ))}
        </ol>
      ) : (
        <div className="rail-empty">
          <Activity size={20} strokeWidth={1.75} aria-hidden="true" />
          <h3>아직 기록이 없어요</h3>
          <p>완성·확인할 점·당신 차례가 생기면 여기에 쌓여요.</p>
        </div>
      )}
      <button type="button" className="rail-more" onClick={onOpenLog}>
        전체 기록 보기 <span>{job.events.length}건</span>
      </button>
    </aside>
  );
}
