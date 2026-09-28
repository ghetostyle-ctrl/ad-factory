import { ChevronRight, Plus, RefreshCw, Settings2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AgentId, Job } from "../shared/schema";
import type { ProjectId } from "../shared/sources";

import { ActivityRail } from "./ActivityRail";
import { AgentBoard } from "./AgentBoard";

import { Artifacts } from "./Artifacts";
import { AutomationPanel } from "./AutomationPanel";
import type { View } from "./agentMeta";
import { errorMessage, postJob, useStudio } from "./api";
import { CreativeEvidence } from "./CreativeEvidence";
import { JobOverview } from "./JobOverview";
import { Button, Notice } from "./primitives";
import { Sidebar } from "./Sidebar";
import { SourceScope } from "./SourceScope";
import { StudioDialogs, type StudioModal } from "./StudioDialogs";
import { VideoScripts } from "./VideoScripts";
import "./workspace.css";
import "./content.css";

const PublishReview = lazy(() =>
  import("./PublishReview").then((module) => ({ default: module.PublishReview })),
);
const Analytics = lazy(() =>
  import("./Analytics").then((module) => ({ default: module.Analytics })),
);
const SourceLibrary = lazy(() =>
  import("./SourceLibrary").then((module) => ({ default: module.SourceLibrary })),
);
const viewNames: Record<View, string> = {
  overview: "작업 공간",
  sources: "자료 라이브러리",
  "success-ai": "Success AI 광고수집기",
  artifacts: "결과물",
  review: "게시 검토",
  analysis: "성과 분석",
};
export function App() {
  const { state, error, loading, live, refresh } = useStudio();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [view, setView] = useState<View>("overview");
  const [successAiHandoff, setSuccessAiHandoff] = useState<{
    platform: "meta";
    keyword: string;
  } | null>(() => {
    const query = new URLSearchParams(window.location.search);
    const keyword = query.get("keyword")?.trim() ?? "";
    return query.get("import") === "success-ai" &&
      query.get("platform") === "meta" &&
      keyword.length <= 120
      ? { platform: "meta", keyword }
      : null;
  });
  const handoffRouted = useRef(false);
  const [filter, setFilter] = useState<AgentId | null>(null);
  const [modal, setModal] = useState<StudioModal>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const jobs = state?.jobs ?? [];
  useEffect(() => {
    if (!successAiHandoff || !state || handoffRouted.current) return;
    handoffRouted.current = true;
    setView("sources");
    window.history.replaceState(null, "", window.location.pathname);
  }, [successAiHandoff, state]);
  const job = jobs.find((item) => item.id === selectedId) ?? jobs[0] ?? null;
  const action = async (kind: "run" | "cancel") => {
    if (!job) return;
    setPending(true);
    setActionError(null);
    setView("overview");
    try {
      await postJob(`jobs/${job.id}/${kind}`);
      await refresh();
    } catch (cause) {
      setActionError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const changeJob = (id: string) => {
    setSelectedId(id);
    setView("overview");
    setFilter(null);
    setActionError(null);
  };
  const changeView = (next: View) => {
    setView(next);
    setFilter(null);
  };
  const created = (value: Job) => {
    setSelectedId(value.id);
    setModal(null);
    setView("overview");
    setFilter(null);
    void refresh();
  };
  const refreshed = () => {
    void refresh();
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <Sidebar
        jobs={jobs}
        selectedId={job?.id ?? null}
        view={view}
        onView={changeView}
        onSelect={changeJob}
        onCreate={() => setModal("create")}
        onSettings={() => setModal("settings")}
        onSuccessAi={() => {
          window.location.href = "http://127.0.0.1:3001/";
        }}
        live={live}
      />
      <main className="main-shell" id="main-content">
        <header className="topbar">
          <nav className="breadcrumbs" aria-label="현재 위치">
            <span>내 스튜디오</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong aria-current="page">{viewNames[view]}</strong>
          </nav>
          <div className="cluster">
            <span className={`local-badge ${live ? "connected" : ""}`}>로컬</span>
            <Button variant="ghost" size="icon" aria-label="상태 새로고침" onClick={refreshed}>
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="연결 설정"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={16} aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div className="workspace-body">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === "success-ai" ? "레퍼런스 수집" : "광고 스튜디오"}
              </div>
              <h1>{viewNames[view]}</h1>
              <p>
                {view === "success-ai"
                  ? "Success AI 광고수집기에서 모은 구글·메타 광고 레퍼런스를 프로젝트에 저장합니다."
                  : "아이디어에서 광고까지, 모든 과정이 보이는 스튜디오."}
              </p>
            </div>
            <Button
              variant={view === "overview" && job ? "primary" : "secondary"}
              onClick={() => setModal("create")}
            >
              <Plus size={16} aria-hidden="true" />새 작업 만들기
            </Button>
          </div>
          {(error || actionError) && <Notice tone="error">{actionError ?? error}</Notice>}
          {!live && state && (
            <Notice>
              실시간 연결을 다시 시도하고 있습니다. 현재 화면은 마지막으로 받은 상태입니다.
            </Notice>
          )}
          {loading ? (
            <div className="loading-state">
              <RefreshCw size={24} className="spin" />
              <h2>작업 공간을 불러오고 있어요</h2>
              <p>로컬 서버에서 실제 작업 상태를 확인합니다.</p>
            </div>
          ) : !state ? (
            <section className="panel empty-small">
              <h2>서버에 연결할 수 없어요</h2>
              <p>AD FACTORY 서버가 실행 중인지 확인한 후 다시 시도하세요.</p>
              <Button onClick={refreshed}>다시 연결</Button>
            </section>
          ) : (
            <div className="workspace-grid">
              <div className="workspace-main stack">
                {view === "overview" && (
                  <>
                    <JobOverview
                      job={job}
                      pending={pending}
                      onCreate={() => setModal("create")}
                      onRun={() => {
                        void action("run");
                      }}
                      onCancel={() => {
                        void action("cancel");
                      }}
                      onEdit={() => setModal("edit")}
                    />
                    {job && (
                      <AutomationPanel
                        key={job.id}
                        job={job}
                        config={state.config}
                        engine={state.engine}
                        onSettings={() => setModal("settings")}
                        onRefresh={refreshed}
                        onCreate={() => setModal("create")}
                      />
                    )}
                    {job && (
                      <SourceScope
                        job={job}
                        onLibrary={() => {
                          if (job.projectId) setProjectId(job.projectId);
                          setView("sources");
                        }}
                      />
                    )}
                    <AgentBoard
                      job={job}
                      selected={filter}
                      onSelect={(id) => setFilter(filter === id ? null : id)}
                    />
                    <Artifacts job={job} filter={filter} onRefresh={refreshed} />
                    {job?.creativePlan && <CreativeEvidence job={job} />}
                    {job && <VideoScripts job={job} />}
                  </>
                )}
                {view === "artifacts" && (
                  <>
                    <div className="section-context">
                      {job ? `${job.name}의 결과물` : "선택한 작업 없음"}
                    </div>
                    <Artifacts job={job} filter={null} onRefresh={refreshed} />
                  </>
                )}
                <Suspense fallback={<Notice>선택한 화면을 불러오고 있습니다…</Notice>}>
                  {(view === "sources" || view === "success-ai") && (
                    <SourceLibrary
                      projects={state.projects}
                      selectedId={projectId}
                      successAiHandoff={successAiHandoff}
                      successAiIntent={view === "success-ai"}
                      onHandoffDone={() => setSuccessAiHandoff(null)}
                      onSelect={setProjectId}
                      onRefresh={refreshed}
                      onCreateJob={(id) => {
                        setProjectId(id);
                        setModal("create");
                      }}
                    />
                  )}
                  {view === "review" && (
                    <PublishReview
                      job={job}
                      onRefresh={refreshed}
                      onAccount={() => setModal("account")}
                    />
                  )}
                  {view === "analysis" && <Analytics job={job} onRefresh={refreshed} />}
                </Suspense>
                <footer className="workspace-footer">
                  <span>
                    {job?.staged || (job?.automation && job.automation.policy.mode !== "creative")
                      ? "전략 → 기획 → 제작 → 게시 → 분석"
                      : "전략 → 기획 → 제작"}
                  </span>
                  <span>작업 데이터는 이 컴퓨터에 저장됩니다.</span>
                </footer>
              </div>
              <ActivityRail job={job} live={live} />
            </div>
          )}
        </div>
      </main>
      <StudioDialogs
        modal={modal}
        state={state}
        job={job}
        projectId={
          projectId ??
          (view === "sources" || view === "success-ai" ? (state?.projects[0]?.id ?? null) : null)
        }
        onClose={() => setModal(null)}
        onCreated={created}
        onSaved={refreshed}
      />
    </div>
  );
}
