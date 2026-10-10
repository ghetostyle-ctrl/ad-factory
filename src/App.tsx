import { ChevronRight, Plus, RefreshCw, Settings2 } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import type { AgentId, Job } from "../shared/schema";
import type { ProjectId } from "../shared/sources";
import { ActivityRail } from "./ActivityRail";
import { AgentBoard } from "./AgentBoard";
import { Artifacts } from "./Artifacts";
import { AutomationPanel } from "./AutomationPanel";
import type { View } from "./agentMeta";
import { errorMessage, postJob, useStudio } from "./api";
import { CreativeEvidence } from "./CreativeEvidence";
import { DeleteJobDialog } from "./DeleteJobDialog";
import { FlowImagesPanel } from "./FlowImagesPanel";
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
const viewDescriptions: Record<View, string> = {
  overview: "선택한 작업의 진행 상황과 다음 단계를 확인합니다.",
  sources: "제품 자료와 레퍼런스를 모아 두고 작업에 연결합니다.",
  "success-ai": "Success AI 광고수집기에서 모은 구글·메타 광고 레퍼런스를 프로젝트에 저장합니다.",
  artifacts: "에이전트가 만든 문서·이미지·영상을 확인하고 내려받습니다.",
  review: "게시 전에 소재와 설정을 최종 확인합니다.",
  analysis: "집행한 광고의 성과를 확인합니다.",
};
export function App() {
  const { state, error, loading, live, refresh } = useStudio();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [view, setView] = useState<View>("overview");
  // 사이드바·브레드크럼은 클릭 즉시 새 view를 보여 주고, 무거운 본문은 뒤따라 렌더링한다 (SUITE-DESIGN §10.6).
  const shownView = useDeferredValue(view);
  const withRail = shownView === "overview";
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
  const [deleteId, setDeleteId] = useState<string | null>(null);
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
  const deleteTarget = jobs.find((item) => item.id === deleteId) ?? null;
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
        onDelete={setDeleteId}
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
        <div
          className={`workspace-body ${withRail ? "" : "without-rail"}`}
          aria-busy={shownView !== view ? true : undefined}
        >
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {shownView === "success-ai" ? "레퍼런스 수집" : "광고 스튜디오"}
              </div>
              <h1>{viewNames[shownView]}</h1>
              <p>{viewDescriptions[shownView]}</p>
            </div>
            <Button
              variant={shownView === "overview" && job ? "primary" : "secondary"}
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
                {shownView === "overview" && (
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
                      onDelete={() => job && setDeleteId(job.id)}
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
                    {job && <FlowImagesPanel job={job} onRefresh={refreshed} />}
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
                {shownView === "artifacts" && (
                  <>
                    <div className="section-context">
                      {job ? `${job.name}의 결과물` : "선택한 작업 없음"}
                    </div>
                    <Artifacts job={job} filter={null} onRefresh={refreshed} />
                  </>
                )}
                <Suspense fallback={<Notice>선택한 화면을 불러오고 있습니다…</Notice>}>
                  {(shownView === "sources" || shownView === "success-ai") && (
                    <SourceLibrary
                      projects={state.projects}
                      selectedId={projectId}
                      successAiHandoff={successAiHandoff}
                      successAiIntent={shownView === "success-ai"}
                      onHandoffDone={() => setSuccessAiHandoff(null)}
                      onSelect={setProjectId}
                      onRefresh={refreshed}
                      onCreateJob={(id) => {
                        setProjectId(id);
                        setModal("create");
                      }}
                    />
                  )}
                  {shownView === "review" && (
                    <PublishReview
                      job={job}
                      onRefresh={refreshed}
                      onAccount={() => setModal("account")}
                    />
                  )}
                  {shownView === "analysis" && <Analytics job={job} onRefresh={refreshed} />}
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
              {withRail && <ActivityRail job={job} live={live} />}
            </div>
          )}
        </div>
      </main>
      {deleteTarget && (
        <DeleteJobDialog
          job={deleteTarget}
          onClose={() => setDeleteId(null)}
          onDeleted={() => {
            if (selectedId === deleteTarget.id) setSelectedId(null);
            setDeleteId(null);
            setView("overview");
            void refresh();
          }}
        />
      )}
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
