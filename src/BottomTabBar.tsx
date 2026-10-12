import { Clock, FileText, Film, House, ScrollText } from "lucide-react";
import type { Job } from "../shared/schema";
import { JOB_TAB_KEYS, type JobTabKey, jobTabInfo } from "./JobTabs";

const TAB_ICONS = {
  overview: House,
  scripts: Film,
  evidence: ScrollText,
  files: FileText,
  log: Clock,
} as const satisfies Record<JobTabKey, unknown>;

// 모바일(≤760px) 하단 고정 탭 바 60px: 작업 화면 탭 5개를 JobTabs 와 같은 값으로 옮긴다.
// 작업이 선택된 작업 공간 화면에서만 그려지고, 넓은 화면에서는 CSS 로 숨는다.
export function BottomTabBar({
  job,
  tab,
  onTab,
}: {
  readonly job: Job;
  readonly tab: JobTabKey;
  readonly onTab: (tab: JobTabKey) => void;
}) {
  return (
    <nav className="bottom-tabbar" aria-label="작업 화면 하단 탭">
      {JOB_TAB_KEYS.map((key) => {
        const Icon = TAB_ICONS[key];
        return (
          <button
            key={key}
            type="button"
            className="bottom-tab"
            aria-current={key === tab ? "page" : undefined}
            onClick={() => onTab(key)}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>{jobTabInfo(key, job).label}</span>
          </button>
        );
      })}
    </nav>
  );
}
