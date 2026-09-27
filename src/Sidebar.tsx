import {
  ChartNoAxesCombined,
  ChevronDown,
  Circle,
  Command,
  FolderOpen,
  Layers3,
  Library,
  Plus,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { Fragment, useState } from "react";
import type { Job } from "../shared/schema";
import type { View } from "./agentMeta";

type SidebarProps = {
  readonly jobs: readonly Job[];
  readonly selectedId: string | null;
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onSettings: () => void;
  readonly onSuccessAi: () => void;
};
export function Sidebar({
  jobs,
  selectedId,
  view,
  onView,
  onSelect,
  onCreate,
  onSettings,
  onSuccessAi,
}: SidebarProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
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
      <a className="brand" href="/">
        <span className="brand-symbol">
          <Command size={19} strokeWidth={2.2} />
        </span>
        <span>
          AD FACTORY<small>광고가 만들어지는 곳</small>
        </span>
      </a>
      <button type="button" className="mobile-settings" aria-label="연결 설정" onClick={onSettings}>
        <Settings2 size={19} />
      </button>
      <div className="workspace-switcher">
        <button
          type="button"
          className="workspace-label"
          aria-expanded={workspaceOpen}
          onClick={() => setWorkspaceOpen((open) => !open)}
        >
          <span className="workspace-avatar">{view === "success-ai" ? "S" : "A"}</span>
          <span>
            <strong>{view === "success-ai" ? "Success AI 광고수집기" : "AD FACTORY"}</strong>
            <small>
              {view === "success-ai" ? "구글·메타 광고 레퍼런스" : "광고 설계·제작 스튜디오"}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        {workspaceOpen && (
          <div className="workspace-menu" role="menu" aria-label="앱 선택">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setWorkspaceOpen(false);
                window.location.href = "http://127.0.0.1:3000/";
              }}
            >
              <span className="workspace-avatar">K</span>
              <span>
                <strong>키워드워처</strong>
                <small>검색량·시장 트렌드 추적</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setWorkspaceOpen(false);
                onSuccessAi();
              }}
            >
              <span className="workspace-avatar">S</span>
              <span>
                <strong>Success AI 광고수집기</strong>
                <small>구글·메타 광고 레퍼런스 수집</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setWorkspaceOpen(false);
                onView("overview");
              }}
            >
              <span className="workspace-avatar">A</span>
              <span>
                <strong>AD FACTORY</strong>
                <small>광고소재 설계·제작</small>
              </span>
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
              <link.icon size={17} />
              <span>{link.label}</span>
              {link.count !== null && <small>{link.count}</small>}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-section-heading">
        <span>내 작업</span>
        <button type="button" aria-label="새 작업 만들기" title="새 작업 만들기" onClick={onCreate}>
          <Plus size={17} />
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
            <button
              type="button"
              className={`sidebar-job ${selectedId === job.id ? "selected" : ""}`}
              key={job.id}
              onClick={() => onSelect(job.id)}
              aria-pressed={selectedId === job.id}
            >
              <Circle size={10} className={`job-dot ${job.status}`} />
              <span>{job.name}</span>
            </button>
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
          <Settings2 size={17} />
          <span>연결 설정</span>
        </button>
        <div className="local-note">
          <span />이 컴퓨터에서 실행 중
        </div>
      </div>
    </aside>
  );
}
