import { Library, Plus, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Project,
  type ProjectDetail,
  ProjectDetailSchema,
  type ProjectId,
  type ProjectSource,
} from "../shared/sources";
import { api, errorMessage } from "./api";
import { ProductionLibrary } from "./ProductionLibrary";
import { ProjectDialog } from "./ProjectDialog";
import { Button, Field, Notice } from "./primitives";
import { SellerQuestionnaire } from "./SellerQuestionnaire";
import { SourceForm } from "./SourceForm";
import { SourceImport } from "./SourceImport";
import { SourceResearchPanel } from "./SourceResearchPanel";
import "./sources.css";

type SourceModal = "project" | "source" | "import" | "questionnaire";
type SourceDraftKind = "product_fact" | "review" | "offer" | "reference";

export function SourceLibrary({
  projects,
  selectedId,
  successAiHandoff,
  successAiIntent,
  onHandoffDone,
  onSelect,
  onRefresh,
  onCreateJob,
}: {
  readonly projects: readonly Project[];
  readonly selectedId: ProjectId | null;
  readonly successAiHandoff: { readonly platform: "meta"; readonly keyword: string } | null;
  readonly successAiIntent: boolean;
  readonly onHandoffDone: () => void;
  readonly onSelect: (id: ProjectId) => void;
  readonly onRefresh: () => void;
  readonly onCreateJob: (id: ProjectId) => void;
}) {
  const project = projects.find((item) => item.id === selectedId) ?? projects[0] ?? null;
  const projectId = project?.id ?? null;
  const revision = project?.revision;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<SourceModal | null>(null);
  const [editing, setEditing] = useState<ProjectSource | null>(null);
  const [draftKind, setDraftKind] = useState<SourceDraftKind>("product_fact");
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"research" | "production">("research");
  const successAiIntentHandled = useRef(false);
  useEffect(() => {
    if (!successAiHandoff && !successAiIntent) {
      successAiIntentHandled.current = false;
      return;
    }
    if (successAiIntentHandled.current && !successAiHandoff) return;
    successAiIntentHandled.current = true;
    setTab("research");
    setModal(projects.length ? "import" : "project");
  }, [successAiHandoff, successAiIntent, projects.length]);
  useEffect(() => {
    if (!projectId) {
      setDetail(null);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .get(`projects/${projectId}`, {
        signal: abort.signal,
        searchParams: { revision: revision ?? 0, refresh: reload },
      })
      .json()
      .then((value) => {
        if (!abort.signal.aborted) setDetail(ProjectDetailSchema.parse(value));
      })
      .catch(async (cause: unknown) => {
        const message = await errorMessage(cause);
        if (!abort.signal.aborted) setError(message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, revision, reload]);
  const refresh = useCallback(() => {
    setReload((value) => value + 1);
    onRefresh();
  }, [onRefresh]);
  const currentDetail =
    detail?.project.id === projectId && detail.project.revision === revision ? detail : null;
  const sources = currentDetail?.sources ?? [];
  const waiting = loading || (!error && !currentDetail);
  const openSource = (kind: SourceDraftKind, source: ProjectSource | null = null) => {
    setEditing(source);
    setDraftKind(kind);
    setModal("source");
  };
  return (
    <div className="stack source-library">
      <section className="panel">
        <header className="panel-header spread">
          <div>
            <div className="cluster">
              <Library size={18} />
              <h2>프로젝트 자료</h2>
            </div>
            <p>상품 근거와 광고 레퍼런스, 직접 촬영한 제작 영상을 프로젝트별로 관리합니다.</p>
          </div>
          <Button onClick={() => setModal("project")}>
            <Plus size={15} />새 프로젝트
          </Button>
        </header>
        <div className="panel-body stack">
          {projects.length ? (
            <>
              <Field label="자료를 관리할 프로젝트">
                <select
                  value={projectId ?? ""}
                  onChange={(event) => {
                    const next = projects.find((item) => item.id === event.target.value);
                    if (next) onSelect(next.id);
                  }}
                >
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              {project?.description && <p className="muted">{project.description}</p>}
              <fieldset className="cluster source-library-tabs" aria-label="프로젝트 자료 종류">
                <Button aria-pressed={tab === "research"} onClick={() => setTab("research")}>
                  상품·레퍼런스
                </Button>
                <Button aria-pressed={tab === "production"} onClick={() => setTab("production")}>
                  제작 소스
                </Button>
              </fieldset>
              {tab === "research" && (
                <>
                  <div className="cluster">
                    <Button variant="primary" onClick={() => openSource("product_fact")}>
                      <Plus size={15} />내 상품 정보 등록
                    </Button>
                    <Button onClick={() => openSource("offer")}>
                      <Plus size={15} />
                      가격·혜택 등록
                    </Button>
                    <Button onClick={() => setModal("import")}>
                      <Upload size={15} />
                      Success AI 광고수집기에서 가져오기
                    </Button>
                    <Button variant="ghost" onClick={() => openSource("review")}>
                      고객 후기 추가
                    </Button>
                    <Button variant="ghost" onClick={refresh} aria-label="프로젝트 자료 새로고침">
                      <RefreshCw size={15} />
                    </Button>
                  </div>
                  <Notice>
                    새 작업을 만들 때 이 프로젝트의 자료 버전을 고정합니다. 이후 라이브러리를
                    수정해도 진행 중인 광고의 근거는 바뀌지 않습니다.
                  </Notice>
                </>
              )}
            </>
          ) : (
            <div className="empty-small">
              <Library size={20} strokeWidth={1.75} aria-hidden="true" />
              <h3>첫 프로젝트에 자료를 모아 보세요</h3>
              <p>
                프로젝트를 만들면 <strong>Success AI 광고수집기에서 가져오기</strong>가 나타납니다.
                같은 컴퓨터의 Success AI 광고수집기에 저장된 구글·메타 광고를 이 프로젝트의
                레퍼런스로 선택해 가져올 수 있습니다.
              </p>
              <Button variant="primary" onClick={() => setModal("project")}>
                프로젝트 만들기
              </Button>
            </div>
          )}
          {tab === "research" && error && <Notice tone="error">{error}</Notice>}
        </div>
      </section>
      {project && tab === "research" && (
        <SourceResearchPanel
          project={project}
          sources={sources}
          waiting={waiting}
          error={error}
          revision={currentDetail?.project.revision}
          onCreateJob={onCreateJob}
          onRefresh={refresh}
          onEdit={(item) => openSource(item.kind, item)}
          onAdd={() => openSource("product_fact")}
          onQuestionnaire={() => setModal("questionnaire")}
        />
      )}
      {project && tab === "production" && <ProductionLibrary key={project.id} project={project} />}
      {modal === "project" && (
        <ProjectDialog
          onClose={() => {
            setModal(null);
            onHandoffDone();
          }}
          onCreated={(created) => {
            onSelect(created.id);
            setModal(successAiHandoff ? "import" : null);
            refresh();
          }}
        />
      )}
      {modal === "questionnaire" && projectId && (
        <SellerQuestionnaire
          projectId={projectId}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal === "source" && projectId && (
        <SourceForm
          projectId={projectId}
          source={editing}
          initialKind={draftKind}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal === "import" && projectId && (
        <SourceImport
          projectId={projectId}
          {...(successAiHandoff
            ? {
                initialKeyword: successAiHandoff.keyword,
                projects,
                onProjectSelect: onSelect,
              }
            : {})}
          onClose={() => {
            setModal(null);
            onHandoffDone();
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
