import {
  ChartNoAxesCombined,
  Check,
  ChevronsUpDown,
  Clapperboard,
  Hand,
  Layers3,
  Library,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { jobProgress } from "../shared/next-action";
import type { Job } from "../shared/schema";
import {
  SUITE_APPS,
  type SuiteAppId,
  type SuiteAppStatus,
  SuiteAppsResponseSchema,
} from "../shared/suite-apps";
import { jobUiState } from "../shared/ui-state";
import type { View } from "./agentMeta";
import { api } from "./api";
import { ProgressSegments, StatusDot } from "./primitives";

// 게시·성과는 이번 범위 밖이라 '준비 중' 그룹으로 낮추되 누를 수는 있다.
const LATER_LINKS = [
  { id: "review", label: "게시 검토", icon: ShieldCheck },
  { id: "analysis", label: "성과 분석", icon: ChartNoAxesCombined },
] as const;

// 앱 전환 카드 + 메뉴(AD 스위트의 세 앱). 데스크톱 사이드바와 모바일 메뉴 시트가 함께 쓴다.
// 키보드: 열기 ↓/↑ · 항목 이동 ↑↓ Home End · 닫기 Esc(트리거로 포커스 복귀) · Tab 은 메뉴를 닫고 다음으로.
export function AppSwitcher({
  view,
  onView,
  onOpenApp,
  inline = false,
  onPick,
}: {
  readonly view: View;
  readonly onView: (view: View) => void;
  // 다른 스위트 앱(키워드와처·Success AI)을 고르면 부른다. 앱이 꺼져 있으면 서버가 켠 뒤 이동한다(SuiteLaunchDialog).
  readonly onOpenApp: (id: SuiteAppId) => void;
  // 메뉴를 카드 아래에 펼쳐 두는 방식(모바일 시트). false 면 카드 위에 뜨는 팝오버.
  readonly inline?: boolean;
  // 항목을 고른 뒤 부른다(시트 닫기 등).
  readonly onPick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // 메뉴를 열 때마다 다른 앱이 켜져 있는지 묻는다(실패해도 메뉴는 그대로).
  const [suite, setSuite] = useState<readonly SuiteAppStatus[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const inSuccessAi = view === "success-ai";
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSuite(null);
    api
      .get("suite/apps")
      .json()
      .then((body) => {
        if (!cancelled) setSuite(SuiteAppsResponseSchema.parse(body).apps);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);
  const suiteHint = (id: SuiteAppId) => {
    const status = suite?.find((item) => item.id === id);
    if (!status) return SUITE_APPS[id].summary;
    if (status.up) return "켜져 있음 · 바로 열기";
    return status.dir ? "꺼져 있음 · 누르면 켭니다" : "꺼져 있음 · 폴더를 찾지 못함";
  };
  const entries = [
    {
      id: "keyword-watcher",
      letter: "K",
      tone: "app-trendwatch",
      name: SUITE_APPS["keyword-watcher"].name,
      hint: suiteHint("keyword-watcher"),
      current: false,
      run: () => onOpenApp("keyword-watcher"),
    },
    {
      id: "success-ai",
      letter: "S",
      tone: "app-successai",
      name: SUITE_APPS["success-ai"].name,
      hint: suiteHint("success-ai"),
      current: inSuccessAi,
      run: () => onOpenApp("success-ai"),
    },
    {
      id: "adfactory",
      letter: "A",
      tone: "app-adfactory",
      name: "AD FACTORY",
      hint: "광고소재 설계·제작",
      current: !inSuccessAi,
      run: () => onView("overview"),
    },
  ] as const;
  const last = entries.length - 1;
  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);
  useEffect(() => {
    if (!open || inline) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, inline]);
  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(
        Math.max(
          0,
          entries.findIndex((entry) => entry.current),
        ),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(last);
    }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index >= last ? 0 : index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index <= 0 ? last : index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Escape") {
      // 시트 안에서는 시트가 함께 닫히지 않게 여기서 끝낸다.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  };
  const currentEntry = entries.find((entry) => entry.current) ?? entries[2];
  return (
    <div className={`workspace-switcher ${inline ? "is-inline" : ""}`} ref={root}>
      <button
        type="button"
        ref={trigger}
        className="workspace-label"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt(entries.findIndex((entry) => entry.current)))}
        onKeyDown={onTriggerKey}
      >
        <span className={`workspace-avatar ${currentEntry.tone}`}>{currentEntry.letter}</span>
        <span>
          <strong>{currentEntry.name}</strong>
          <small>{inSuccessAi ? "구글·메타 광고 레퍼런스" : "광고 설계·제작 스튜디오"}</small>
        </span>
        <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="workspace-menu"
          id={menuId}
          role="menu"
          aria-label="AD 스위트 앱 선택"
          onKeyDown={onMenuKey}
        >
          <div className="workspace-menu-title" aria-hidden="true">
            AD 스위트
          </div>
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              tabIndex={index === active ? 0 : -1}
              aria-current={entry.current ? "true" : undefined}
              onClick={() => {
                close(false);
                entry.run();
                onPick?.();
              }}
            >
              <span className={`workspace-avatar ${entry.tone}`}>{entry.letter}</span>
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.hint}</small>
              </span>
              {entry.current && <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 1차 내비: 작업 공간(당신 차례 작업 수) · 자료 라이브러리 · 완성 영상(모든 작업의 현재 완성본 수)
export function PrimaryNav({
  jobs,
  view,
  onView,
  onPick,
}: {
  readonly jobs: readonly Job[];
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onPick?: () => void;
}) {
  // 작업 공간 칩 = 지금 내 손이 필요한 작업 수(0이면 숨김)
  const yourTurnJobs = jobs.filter((job) => jobUiState(job).family === "yourTurn").length;
  const finished = jobs.reduce((sum, job) => sum + jobProgress(job).done, 0);
  const links = [
    { id: "overview", label: "작업 공간", icon: Layers3, count: yourTurnJobs, turn: true },
    { id: "sources", label: "자료 라이브러리", icon: Library, count: null, turn: false },
    { id: "artifacts", label: "완성 영상", icon: Clapperboard, count: finished, turn: false },
  ] as const;
  return (
    <nav className="main-nav" aria-label="작업 공간 탐색">
      {links.map((link) => (
        <button
          key={link.id}
          type="button"
          className={`nav-item ${view === link.id ? "active" : ""}`}
          aria-current={view === link.id ? "page" : undefined}
          onClick={() => {
            onView(link.id);
            onPick?.();
          }}
        >
          <link.icon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{link.label}</span>
          {link.count !== null && link.count > 0 && (
            <small className={link.turn ? "is-turn" : undefined}>
              {link.turn && <Hand size={14} strokeWidth={1.75} aria-hidden="true" />}
              {link.count}
              {link.turn && <span className="sr-only">개 작업이 당신 차례</span>}
            </small>
          )}
        </button>
      ))}
    </nav>
  );
}

// 준비 중 묶음(게시 검토·성과 분석): 작게 낮추되 누를 수는 있다.
export function LaterNav({
  view,
  onView,
  onPick,
}: {
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onPick?: () => void;
}) {
  return (
    <div className="nav-later">
      <span className="nav-later-label">준비 중</span>
      {LATER_LINKS.map((link) => (
        <button
          key={link.id}
          type="button"
          className={`nav-item is-later ${view === link.id ? "active" : ""}`}
          aria-current={view === link.id ? "page" : undefined}
          onClick={() => {
            onView(link.id);
            onPick?.();
          }}
        >
          <link.icon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{link.label}</span>
        </button>
      ))}
    </div>
  );
}

// 내 작업 목록: 점 + 이름 + n/total + 3px 미니 막대. onDelete 가 있을 때만 휴지통 버튼을 둔다.
export function JobRows({
  jobs,
  selectedId,
  onSelect,
  onDelete,
}: {
  readonly jobs: readonly Job[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onDelete?: (id: string) => void;
}) {
  if (jobs.length === 0)
    return (
      <p className="sidebar-empty">
        첫 작업을 만들고
        <br />
        광고 제작을 시작하세요.
      </p>
    );
  return jobs.map((job) => {
    const state = jobUiState(job);
    const progress = jobProgress(job);
    return (
      <div className={`sidebar-job-row ${selectedId === job.id ? "selected" : ""}`} key={job.id}>
        <button
          type="button"
          className={`sidebar-job ${selectedId === job.id ? "selected" : ""} ${onDelete ? "" : "no-delete"}`}
          onClick={() => onSelect(job.id)}
          aria-pressed={selectedId === job.id}
        >
          <span className="job-line">
            <StatusDot state={state} hideLabel />
            <span className="job-name">{job.name}</span>
            {progress.total > 0 && (
              <span className={`job-count ${progress.yourTurn > 0 ? "is-turn" : ""}`}>
                {progress.done}/{progress.total}
              </span>
            )}
          </span>
          {progress.total > 0 && (
            <ProgressSegments
              total={progress.total}
              done={progress.done}
              yourTurn={progress.yourTurn}
              height={3}
              label={`${job.name} 완성 ${progress.done} / ${progress.total}편`}
            />
          )}
        </button>
        {onDelete && (
          <button
            type="button"
            className="sidebar-job-delete"
            aria-label={`${job.name} 삭제`}
            title="작업 삭제"
            onClick={() => onDelete(job.id)}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  });
}

type SidebarProps = {
  readonly jobs: readonly Job[];
  readonly selectedId: string | null;
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (id: string) => void;
  readonly onSettings: () => void;
  readonly onOpenApp: (id: SuiteAppId) => void;
  readonly live: boolean;
};
// 데스크톱 사이드바(≥761px). 좁은 화면에서는 숨기고 MobileSheet 의 앱바·메뉴 시트가 같은 구성을 대신한다.
export function Sidebar({
  jobs,
  selectedId,
  view,
  onView,
  onSelect,
  onCreate,
  onDelete,
  onSettings,
  onOpenApp,
  live,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="AD 스위트">
        <span className="brand-symbol" aria-hidden="true">
          AD
        </span>
        <span>AD 스위트</span>
      </a>
      <AppSwitcher view={view} onView={onView} onOpenApp={onOpenApp} />
      <PrimaryNav jobs={jobs} view={view} onView={onView} />
      <div className="sidebar-section-heading">
        <span>내 작업</span>
        <button type="button" aria-label="새 작업 만들기" title="새 작업 만들기" onClick={onCreate}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-jobs">
        <JobRows jobs={jobs} selectedId={selectedId} onSelect={onSelect} onDelete={onDelete} />
      </div>
      <div className="sidebar-footer">
        <button className="nav-item" type="button" onClick={onSettings}>
          <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>연결 설정</span>
        </button>
        <LaterNav view={view} onView={onView} />
        <div className="local-note">
          <span className={live ? "connected" : undefined} />이 컴퓨터에서 실행 중
        </div>
      </div>
    </aside>
  );
}
