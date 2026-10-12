import {
  ChartNoAxesCombined,
  Check,
  ChevronsUpDown,
  Circle,
  FolderOpen,
  Layers3,
  Library,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { Job } from "../shared/schema";
import {
  SUITE_APPS,
  type SuiteAppId,
  type SuiteAppStatus,
  SuiteAppsResponseSchema,
} from "../shared/suite-apps";
import type { View } from "./agentMeta";
import { api } from "./api";

type SidebarProps = {
  readonly jobs: readonly Job[];
  readonly selectedId: string | null;
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (id: string) => void;
  readonly onSettings: () => void;
  // 다른 스위트 앱(키워드와처·Success AI)을 고르면 부른다. 앱이 꺼져 있으면 서버가 켠 뒤 이동한다(SuiteLaunchDialog).
  readonly onOpenApp: (id: SuiteAppId) => void;
  readonly live: boolean;
};
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // 메뉴를 열 때마다 다른 앱이 켜져 있는지 묻는다(실패해도 메뉴는 그대로).
  const [suite, setSuite] = useState<readonly SuiteAppStatus[] | null>(null);
  useEffect(() => {
    if (!workspaceOpen) return;
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
  }, [workspaceOpen]);
  const suiteHint = (id: SuiteAppId) => {
    const status = suite?.find((item) => item.id === id);
    if (!status) return SUITE_APPS[id].summary;
    if (status.up) return "켜져 있음 · 바로 열기";
    return status.dir ? "꺼져 있음 · 누르면 켭니다" : "꺼져 있음 · 폴더를 찾지 못함";
  };
  const inSuccessAi = view === "success-ai";
  const links = [
    { id: "overview", label: "작업 공간", icon: Layers3, count: jobs.length },
    { id: "sources", label: "자료 라이브러리", icon: Library, count: null },
    {
      id: "artifacts",
      label: "결과물",
      icon: FolderOpen,
      count: jobs.reduce((sum, job) => sum + job.artifacts.length, 0),
    },
    {
      id: "review",
      label: "게시 검토",
      icon: ShieldCheck,
      count: jobs.filter((job) => job.status === "review" && job.staged).length,
    },
    { id: "analysis", label: "성과 분석", icon: ChartNoAxesCombined, count: null },
  ] as const;
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="AD 스위트">
        <span className="brand-symbol" aria-hidden="true">
          AD
        </span>
        <span>AD 스위트</span>
      </a>
      <span className={`mobile-status ${live ? "connected" : ""}`}>로컬</span>
      <button type="button" className="mobile-settings" aria-label="연결 설정" onClick={onSettings}>
        <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className="workspace-switcher">
        <button
          type="button"
          className="workspace-label"
          aria-expanded={workspaceOpen}
          onClick={() => setWorkspaceOpen((open) => !open)}
        >
          <span className={`workspace-avatar ${inSuccessAi ? "app-successai" : "app-adfactory"}`}>
            {view === "success-ai" ? "S" : "A"}
          </span>
          <span>
            <strong>{view === "success-ai" ? "Success AI 광고수집기" : "AD FACTORY"}</strong>
            <small>
              {view === "success-ai" ? "구글·메타 광고 레퍼런스" : "광고 설계·제작 스튜디오"}
            </small>
          </span>
          <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {workspaceOpen && (
          <div className="workspace-menu" role="menu" aria-label="AD 스위트 앱 선택">
            <div className="workspace-menu-title" aria-hidden="true">
              AD 스위트
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setWorkspaceOpen(false);
                onOpenApp("keyword-watcher");
              }}
            >
              <span className="workspace-avatar app-trendwatch">K</span>
              <span>
                <strong>{SUITE_APPS["keyword-watcher"].name}</strong>
                <small>{suiteHint("keyword-watcher")}</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-current={inSuccessAi ? "true" : undefined}
              onClick={() => {
                setWorkspaceOpen(false);
                onOpenApp("success-ai");
              }}
            >
              <span className="workspace-avatar app-successai">S</span>
              <span>
                <strong>{SUITE_APPS["success-ai"].name}</strong>
                <small>{suiteHint("success-ai")}</small>
              </span>
              {inSuccessAi && <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-current={inSuccessAi ? undefined : "true"}
              onClick={() => {
                setWorkspaceOpen(false);
                onView("overview");
              }}
            >
              <span className="workspace-avatar app-adfactory">A</span>
              <span>
                <strong>AD FACTORY</strong>
                <small>광고소재 설계·제작</small>
              </span>
              {!inSuccessAi && <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>
      <nav className="main-nav" aria-label="작업 공간 탐색">
        {links.map((link, index) => (
          <Fragment key={link.id}>
            {index === 3 && <span className="nav-group-label">광고 운영 · 별도</span>}
            <button
              type="button"
              className={`nav-item ${view === link.id ? "active" : ""}`}
              aria-current={view === link.id ? "page" : undefined}
              onClick={() => onView(link.id)}
            >
              <link.icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{link.label}</span>
              {link.count !== null && link.count > 0 && <small>{link.count}</small>}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-section-heading">
        <span>내 작업</span>
        <button type="button" aria-label="새 작업 만들기" title="새 작업 만들기" onClick={onCreate}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-jobs">
        {jobs.length === 0 ? (
          <p className="sidebar-empty">
            첫 작업을 만들고
            <br />
            광고 제작을 시작하세요.
          </p>
        ) : (
          jobs.map((job) => (
            <div
              className={`sidebar-job-row ${selectedId === job.id ? "selected" : ""}`}
              key={job.id}
            >
              <button
                type="button"
                className={`sidebar-job ${selectedId === job.id ? "selected" : ""}`}
                onClick={() => onSelect(job.id)}
                aria-pressed={selectedId === job.id}
              >
                <Circle size={8} className={`job-dot ${job.status}`} aria-hidden="true" />
                <span>{job.name}</span>
              </button>
              <button
                type="button"
                className="sidebar-job-delete"
                aria-label={`${job.name} 삭제`}
                title="작업 삭제"
                onClick={() => onDelete(job.id)}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="mobile-job-picker">
        <label htmlFor="mobile-job">선택한 작업</label>
        <select
          id="mobile-job"
          value={selectedId ?? ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          {jobs.length === 0 && <option value="">아직 작업이 없어요</option>}
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.name}
            </option>
          ))}
        </select>
      </div>
      <div className="sidebar-footer">
        <button className="nav-item" type="button" onClick={onSettings}>
          <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>연결 설정</span>
        </button>
        <div className="local-note">
          <span className={live ? "connected" : undefined} />이 컴퓨터에서 실행 중
        </div>
      </div>
    </aside>
  );
}
