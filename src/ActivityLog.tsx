import { Activity } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { ActivityEvent, Job } from "../shared/schema";
import { humanizeEventMessage } from "../shared/ui-state";
import { timeLabel } from "./api";
import { Button, Segmented } from "./primitives";
import "./tabs.css";

// 같은 안내가 연달아 쌓인 것(예: "클립을 올려 주세요" ×4)을 한 줄로 묶는다.
export type EventGroup = {
  readonly id: string;
  readonly at: string;
  readonly kind: ActivityEvent["kind"];
  readonly message: string;
  readonly count: number;
};
// events 는 최신순. 묶음의 시각은 가장 최근 것.
export function groupEvents(events: readonly ActivityEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  for (const event of events) {
    const message = humanizeEventMessage(event.message);
    const last = groups[groups.length - 1];
    if (last && last.message === message && last.kind === event.kind)
      groups[groups.length - 1] = { ...last, count: last.count + 1 };
    else groups.push({ id: event.id, at: event.at, kind: event.kind, message, count: 1 });
  }
  return groups;
}
export function EventRow({ group }: { readonly group: EventGroup }) {
  return (
    <li className={`event-row event-${group.kind}`}>
      <time dateTime={group.at}>{timeLabel(group.at)}</time>
      <i className="event-dot" aria-hidden="true" />
      <p>
        {group.message}
        {group.count > 1 && <span className="event-count">×{group.count}</span>}
      </p>
    </li>
  );
}

const dayFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  weekday: "short",
});
const dayKey = (value: string) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};
const PAGE = 100;

// 기록 탭 필터. 서버 문구를 새로 만들지 않고 이벤트 종류·말투로만 가른다.
//  완성: success 이거나 '완성'이 든 안내 / 확인할 점: warning·error / 당신 차례: 사용자가 올리거나 승인해야 하는 안내.
type LogFilter = "all" | "done" | "check" | "turn";
const TURN_WORDS = /올려|업로드|승인|대기|고치거나/u;
const matchesFilter = (event: ActivityEvent, filter: LogFilter): boolean => {
  switch (filter) {
    case "done":
      return event.kind === "success" || /완성/u.test(event.message);
    case "check":
      return event.kind === "warning" || event.kind === "error";
    case "turn":
      return event.kind !== "success" && TURN_WORDS.test(event.message);
    default:
      return true;
  }
};
const videoNumberOf = (event: ActivityEvent): number | null => {
  const matched = /영상\s*(\d+)/u.exec(event.message);
  return matched?.[1] ? Number(matched[1]) : null;
};
const FILTERS: readonly (readonly [LogFilter, string])[] = [
  ["all", "전체"],
  ["done", "완성"],
  ["check", "확인할 점"],
  ["turn", "당신 차례"],
];

// 기록 탭: 전체 기록을 날짜 구분선 + ×N 묶음으로 보여 준다. 종류 필터와 영상 번호로 좁힐 수 있다.
export function ActivityLog({ job }: { readonly job: Job }) {
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [video, setVideo] = useState<number | null>(null);
  const newestFirst = useMemo(() => job.events.slice().reverse(), [job.events]);
  const counts = useMemo(() => {
    const result: Record<LogFilter, number> = { all: 0, done: 0, check: 0, turn: 0 };
    for (const event of newestFirst)
      for (const [key] of FILTERS) if (matchesFilter(event, key)) result[key] += 1;
    return result;
  }, [newestFirst]);
  const videoNumbers = useMemo(() => {
    const numbers = new Set<number>();
    for (const event of newestFirst) {
      const number = videoNumberOf(event);
      if (number !== null) numbers.add(number);
    }
    return [...numbers].sort((a, b) => a - b);
  }, [newestFirst]);
  const groups = useMemo(
    () =>
      groupEvents(
        newestFirst.filter(
          (event) =>
            matchesFilter(event, filter) && (video === null || videoNumberOf(event) === video),
        ),
      ),
    [newestFirst, filter, video],
  );
  const shown = groups.slice(0, limit);
  if (job.events.length === 0)
    return (
      <section className="panel empty-small">
        <Activity size={20} strokeWidth={1.75} aria-hidden="true" />
        <h3>아직 기록이 없어요</h3>
        <p>작업을 시작하면 만든 결과와 안내가 시간순으로 쌓여요.</p>
      </section>
    );
  const choose = (next: LogFilter) => {
    setFilter(next);
    setLimit(PAGE);
  };
  return (
    <section className="log-tab" aria-label="전체 기록">
      <header className="tab-head">
        <div>
          <h2>
            기록 <span className="count-label">{job.events.length}</span>
          </h2>
          <p>최신 기록이 위에 있어요. 같은 안내가 연달아 쌓이면 한 줄로 묶어 보여 줘요.</p>
        </div>
      </header>
      <div className="log-toolbar">
        <Segmented
          label="기록 종류"
          value={filter}
          onChange={choose}
          options={FILTERS.map(([value, label]) => ({
            value,
            label: (
              <>
                {label}
                <span className="seg-n">{counts[value]}</span>
              </>
            ),
          }))}
        />
        {videoNumbers.length > 0 && (
          <label className="field log-video">
            <span className="sr-only">영상 번호</span>
            <select
              value={video === null ? "" : String(video)}
              onChange={(event) => {
                setVideo(event.target.value === "" ? null : Number(event.target.value));
                setLimit(PAGE);
              }}
            >
              <option value="">모든 영상</option>
              {videoNumbers.map((number) => (
                <option key={number} value={number}>
                  영상 {number}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {groups.length === 0 ? (
        <section className="panel empty-small">
          <Activity size={20} strokeWidth={1.75} aria-hidden="true" />
          <h3>조건에 맞는 기록이 없어요</h3>
          <p>필터를 바꾸거나 영상을 모두 보면 다른 기록이 나와요.</p>
        </section>
      ) : (
        <div className="log-panel">
          <ol className="event-list log-list">
            {shown.map((group, index) => {
              const previous = shown[index - 1];
              const newDay = !previous || dayKey(previous.at) !== dayKey(group.at);
              return (
                <Fragment key={group.id}>
                  {newDay && (
                    <li className="event-day">{dayFormatter.format(new Date(group.at))}</li>
                  )}
                  <EventRow group={group} />
                </Fragment>
              );
            })}
          </ol>
          {groups.length > shown.length && (
            <div className="event-more">
              <Button variant="secondary" onClick={() => setLimit((value) => value + PAGE)}>
                이전 기록 더 보기 · {groups.length - shown.length}줄 남음
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
