import { ChevronRight, Plus, RefreshCw, Settings2 } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { nextAction } from "../shared/next-action";
import type { Job } from "../shared/schema";
import type { ProjectId } from "../shared/sources";
import type { SuiteAppId } from "../shared/suite-apps";
import { ActivityLog } from "./ActivityLog";
import { Artifacts } from "./Artifacts";
import { useAutomationActions } from "./AutomationPanel";
import type { View } from "./agentMeta";
import { errorMessage, postJob, useStudio } from "./api";
import { BottomTabBar } from "./BottomTabBar";
import { CreativeEvidence } from "./CreativeEvidence";
import { DeleteJobDialog } from "./DeleteJobDialog";
import { FinishedVideos } from "./FinishedVideos";
import { JobHeader } from "./JobHeader";
import { JobOverview, JobWelcome } from "./JobOverview";
import { isJobTabKey, JOB_PANEL_ID, type JobTabKey, JobTabs, jobTabId } from "./JobTabs";
import { MobileAppBar } from "./MobileSheet";
import { Button, Notice, Skeleton } from "./primitives";
import { Sidebar } from "./Sidebar";
import { SourceScope } from "./SourceScope";
import { StudioDialogs, type StudioModal } from "./StudioDialogs";
import { SuiteLaunchDialog } from "./SuiteLaunchDialog";
import { Toast } from "./Toast";
import { videoBoardItems } from "./VideoBoard";
import { VideoDetail } from "./VideoDetail";
import { VideoList } from "./VideoList";
import "./workspace.css";
import "./content.css";
// 모바일 셸(앱바·바텀 시트·하단 탭 바)은 위 두 파일의 ≤760px 규칙을 덮어쓰므로 마지막에 불러온다.
import "./mobile.css";

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
  artifacts: "완성 영상",
  review: "게시 검토",
  analysis: "성과 분석",
};
const viewDescriptions: Record<View, string> = {
  overview: "선택한 작업의 진행 상황과 다음 단계를 확인합니다.",
  sources: "제품 자료와 레퍼런스를 모아 두고 작업에 연결합니다.",
  "success-ai": "Success AI 광고수집기에서 모은 구글·메타 광고 레퍼런스를 프로젝트에 저장합니다.",
  artifacts: "모든 작업의 완성 영상을 모아 봅니다.",
  review: "게시 전에 소재와 설정을 최종 확인합니다.",
  analysis: "집행한 광고의 성과를 확인합니다.",
};

// 작업 화면의 위치는 URL ?job=<id>&tab=<탭>&n=<영상 번호> 로 표현한다(docs/UI-V2-2026-10-12.md 8-2절 1항).
type JobLocation = {
  readonly job: string | null;
  readonly tab: JobTabKey;
  readonly n: number | null;
};
function readLocation(): JobLocation {
  const query = new URLSearchParams(window.location.search);
  const tab = query.get("tab");
  const n = Number(query.get("n"));
  return {
    job: query.get("job"),
    tab: isJobTabKey(tab) ? tab : "overview",
    n: Number.isInteger(n) && n > 0 ? n : null,
  };
}
function writeLocation(mode: "push" | "replace", place: JobLocation) {
  const query = new URLSearchParams();
  if (place.job) query.set("job", place.job);
  query.set("tab", place.tab);
  if (place.n !== null) query.set("n", String(place.n));
  const url = `${window.location.pathname}?${query.toString()}`;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

// 작업 안내(지금 할 일)가 같은 작업 안에서 바뀌면 한 줄로 알린다. 진행 중 문구는 자주 바뀌어 알리지 않는다.
function useNextActionAnnouncement(job: Job | null): {
  readonly id: number;
  readonly text: string;
} {
  const [message, setMessage] = useState({ id: 0, text: "" });
  const last = useRef<{ readonly jobId: string; readonly title: string } | null>(null);
  const next = job ? nextAction(job) : null;
  const jobId = job?.id ?? null;
  const title = next?.title ?? "";
  const kind = next?.kind ?? null;
  useEffect(() => {
    if (!jobId || !title) {
      last.current = null;
      return;
    }
    const before = last.current;
    last.current = { jobId, title };
    if (before && before.jobId === jobId && before.title !== title && kind !== "progress")
      setMessage((current) => ({ id: current.id + 1, text: title }));
  }, [jobId, title, kind]);
  return message;
}

// 불러오는 중: 실제 화면과 비슷한 회색 막대(Notice 로 로딩을 알리지 않는다).
function LoadingSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="loading-skeleton" role="status">
      <span className="sr-only">{label}</span>
      <Skeleton width={160} height={14} />
      <Skeleton width="55%" height={28} radius={6} />
      <Skeleton height={88} radius={8} />
      <Skeleton height={176} radius={12} />
      <div className="loading-skeleton-grid">
        {["a", "b", "c", "d", "e"].map((key) => (
          <Skeleton key={key} height={160} radius={10} />
        ))}
      </div>
    </div>
  );
}

export function App() {
  const { state, error, loading, live, refresh } = useStudio();
  const [initial] = useState(readLocation);
  const [selectedId, setSelectedId] = useState<string | null>(initial.job);
  const [tab, setTab] = useState<JobTabKey>(initial.tab);
  const [videoNumber, setVideoNumber] = useState<number | null>(initial.n);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [view, setView] = useState<View>("overview");
  // 사이드바·브레드크럼은 클릭 즉시 새 view를 보여 주고, 무거운 본문은 뒤따라 렌더링한다 (SUITE-DESIGN §10.6).
  const shownView = useDeferredValue(view);
  const shownTab = useDeferredValue(tab);
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
  const [modal, setModal] = useState<StudioModal>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // 사이드바에서 고른 다른 스위트 앱(꺼져 있으면 서버가 켠 뒤 이동).
  const [launchApp, setLaunchApp] = useState<SuiteAppId | null>(null);
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
  const jobId = job?.id ?? null;
  const deleteTarget = jobs.find((item) => item.id === deleteId) ?? null;
  const refreshed = () => {
    void refresh();
  };
  const automationActions = useAutomationActions(job, refreshed, setActionError);
  const announcement = useNextActionAnnouncement(job);
  // 작업·탭·영상 번호를 한 번에 옮기고 주소창에 남긴다. 뒤로 가기는 popstate 로 같은 값을 되돌린다.
  const go = (next: Partial<JobLocation>, mode: "push" | "replace" = "push") => {
    const place: JobLocation = {
      job: next.job === undefined ? jobId : next.job,
      tab: next.tab ?? "overview",
      n: next.n ?? null,
    };
    setSelectedId(place.job);
    setTab(place.tab);
    setVideoNumber(place.n);
    setView("overview");
    writeLocation(mode, place);
  };
  useEffect(() => {
    const onPop = () => {
      const place = readLocation();
      setSelectedId(place.job);
      setTab(place.tab);
      setVideoNumber(place.n);
      setView("overview");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // 처음 열 때 선택된 작업·탭을 주소창에 맞춘다(없으면 첫 작업·개요).
  useEffect(() => {
    if (!jobId || view !== "overview" || successAiHandoff) return;
    const current = readLocation();
    if (current.job !== jobId || current.tab !== tab || current.n !== videoNumber)
      writeLocation("replace", { job: jobId, tab, n: videoNumber });
  }, [jobId, tab, videoNumber, view, successAiHandoff]);
  // 탭을 옮기거나 영상을 바꾸면 맨 위로 되돌린다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 탭·영상 번호·작업이 바뀔 때만 맨 위로 되돌린다.
  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  }, [shownTab, videoNumber, jobId]);
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
    go({ job: id });
    setActionError(null);
  };
  const changeView = (next: View) => {
    setView(next);
  };
  const created = (value: Job) => {
    setModal(null);
    go({ job: value.id });
    void refresh();
  };
  const jobWorkspace = state !== null && job !== null && shownView === "overview";
  const videoCount =
    job?.automation?.policy.mode === "creative" ? (job.automation.policy.videoCount ?? 0) : 0;
  // 대본·영상 탭에서 열 영상: URL 의 n, 없거나 범위 밖이면 첫 '당신 차례' 영상, 그것도 없으면 영상 1.
  const videoItems = job && videoCount > 0 ? videoBoardItems(job) : [];
  const activeVideo =
    videoNumber !== null && videoNumber <= videoItems.length
      ? videoNumber
      : (videoItems.find((item) => item.state.family === "yourTurn")?.number ?? 1);
  useEffect(() => {
    if (tab !== "scripts" || view !== "overview" || videoItems.length === 0) return;
    if (videoNumber !== activeVideo) setVideoNumber(activeVideo);
  }, [tab, view, videoNumber, activeVideo, videoItems.length]);
  return (
    <div className={`app-shell ${jobWorkspace ? "has-tabbar" : ""}`}>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.text && <p key={announcement.id}>{announcement.text}</p>}
      </div>
      <Sidebar
        jobs={jobs}
        selectedId={job?.id ?? null}
        view={view}
        onView={changeView}
        onSelect={changeJob}
        onCreate={() => setModal("create")}
        onDelete={setDeleteId}
        onSettings={() => setModal("settings")}
        onOpenApp={setLaunchApp}
        live={live}
      />
      <MobileAppBar
        jobs={jobs}
        selectedId={job?.id ?? null}
        view={view}
        title={view === "overview" ? (job?.name ?? viewNames.overview) : viewNames[view]}
        onView={changeView}
        onSelect={changeJob}
        onCreate={() => setModal("create")}
        onSettings={() => setModal("settings")}
        onOpenApp={setLaunchApp}
        live={live}
      />
      <main className="main-shell" id="main-content">
        <header className="topbar">
          <nav className="breadcrumbs" aria-label="현재 위치">
            <span>내 스튜디오</span>
            <ChevronRight size={14} aria-hidden="true" />
            {view === "overview" && job ? (
              <>
                <span>{viewNames[view]}</span>
                <ChevronRight size={14} aria-hidden="true" />
                <strong aria-current="page">{job.name}</strong>
              </>
            ) : (
              <strong aria-current="page">{viewNames[view]}</strong>
            )}
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
          className={`workspace-body ${jobWorkspace ? "job-workspace" : "without-rail"}`}
          aria-busy={shownView !== view ? true : undefined}
        >
          {!jobWorkspace && (
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
          )}
          {(error || actionError) && <Notice tone="error">{actionError ?? error}</Notice>}
          {!live && state && (
            <Notice>
              실시간 연결을 다시 시도하고 있습니다. 현재 화면은 마지막으로 받은 상태입니다.
            </Notice>
          )}
          {loading ? (
            <LoadingSkeleton label="작업 공간을 불러오고 있어요" />
          ) : !state ? (
            <section className="panel empty-small">
              <h2>서버에 연결할 수 없어요</h2>
              <p>AD FACTORY 서버가 실행 중인지 확인한 후 다시 시도하세요.</p>
              <Button onClick={refreshed}>다시 연결</Button>
            </section>
          ) : (
            <div className="workspace-grid">
              <div className="workspace-main stack">
                {shownView === "overview" && !job && (
                  <JobWelcome onCreate={() => setModal("create")} />
                )}
                {jobWorkspace && job && (
                  <>
                    <div className={tab === "overview" ? undefined : "job-head-compact"}>
                      <JobHeader
                        job={job}
                        resetPending={automationActions.pending === "reset"}
                        onEdit={() => setModal("edit")}
                        onDelete={() => setDeleteId(job.id)}
                        onReset={() => {
                          void automationActions.reset();
                        }}
                      />
                    </div>
                    <JobTabs job={job} tab={tab} onTab={(next) => go({ tab: next })} />
                    <div
                      className="job-panel"
                      role="tabpanel"
                      id={JOB_PANEL_ID}
                      aria-labelledby={jobTabId(shownTab)}
                      aria-busy={shownTab !== tab ? true : undefined}
                    >
                      {shownTab === "overview" && (
                        <JobOverview
                          key={job.id}
                          job={job}
                          config={state.config}
                          engine={state.engine}
                          live={live}
                          manualPending={pending}
                          actions={automationActions}
                          onCreate={() => setModal("create")}
                          onRun={() => {
                            void action("run");
                          }}
                          onCancel={() => {
                            void action("cancel");
                          }}
                          onSettings={() => setModal("settings")}
                          onRefresh={refreshed}
                          onOpenVideo={(number) => go({ tab: "scripts", n: number })}
                          onOpenLog={() => go({ tab: "log" })}
                        />
                      )}
                      {shownTab === "scripts" &&
                        (videoCount > 0 ? (
                          <div className="video-split" id="video-scripts">
                            <VideoList
                              job={job}
                              number={activeVideo}
                              onSelect={(number) => go({ tab: "scripts", n: number })}
                            />
                            <VideoDetail
                              key={`${job.id}-${activeVideo}`}
                              job={job}
                              number={activeVideo}
                              onOpenOverview={() => go({ tab: "overview" })}
                            />
                          </div>
                        ) : (
                          <section className="panel empty-small">
                            <h3>이 작업에는 영상이 없어요</h3>
                            <p>광고 이미지만 만드는 작업이라 영상 대본이 없습니다.</p>
                          </section>
                        ))}
                      {shownTab === "evidence" && (
                        <div className="stack tab-sections">
                          {job.creativePlan ? (
                            <CreativeEvidence job={job} />
                          ) : (
                            <section className="panel empty-small">
                              <h3>아직 광고안이 없어요</h3>
                              <p>자료 분석과 광고안 기획이 끝나면 여기에서 근거를 볼 수 있어요.</p>
                            </section>
                          )}
                          <SourceScope
                            job={job}
                            onLibrary={() => {
                              if (job.projectId) setProjectId(job.projectId);
                              setView("sources");
                            }}
                          />
                        </div>
                      )}
                      {shownTab === "files" && (
                        <Artifacts job={job} filter={null} onRefresh={refreshed} />
                      )}
                      {shownTab === "log" && <ActivityLog job={job} />}
                    </div>
                  </>
                )}
                {shownView === "artifacts" && (
                  <FinishedVideos
                    jobs={state.jobs}
                    onOpen={(jobId, number) => go({ job: jobId, tab: "scripts", n: number })}
                  />
                )}
                <Suspense fallback={<LoadingSkeleton label="선택한 화면을 불러오고 있어요" />}>
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
            </div>
          )}
        </div>
      </main>
      {jobWorkspace && job && (
        <BottomTabBar job={job} tab={tab} onTab={(next) => go({ tab: next })} />
      )}
      <Toast />
      {launchApp && <SuiteLaunchDialog appId={launchApp} onClose={() => setLaunchApp(null)} />}
      {deleteTarget && (
        <DeleteJobDialog
          job={deleteTarget}
          onClose={() => setDeleteId(null)}
          onDeleted={() => {
            setDeleteId(null);
            if (selectedId === deleteTarget.id) go({ job: null });
            else setView("overview");
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
