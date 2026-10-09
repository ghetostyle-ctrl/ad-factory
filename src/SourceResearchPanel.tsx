import { ArrowRight } from "lucide-react";
import type { Project, ProjectId, ProjectSource } from "../shared/sources";
import { Button, Notice } from "./primitives";
import { SourceRecord } from "./SourceRecord";

export function SourceResearchPanel({
  project,
  sources,
  waiting,
  error,
  revision,
  onCreateJob,
  onRefresh,
  onEdit,
  onAdd,
  onQuestionnaire,
}: {
  readonly project: Project;
  readonly sources: readonly ProjectSource[];
  readonly waiting: boolean;
  readonly error: string | null;
  readonly revision: number | undefined;
  readonly onCreateJob: (id: ProjectId) => void;
  readonly onRefresh: () => void;
  readonly onEdit: (source: ProjectSource) => void;
  readonly onAdd: () => void;
  readonly onQuestionnaire: () => void;
}) {
  return (
    <section className="panel">
      <header className="panel-header spread">
        <div>
          <h2>{project.name}의 자료</h2>
          <p>
            {waiting ? (
              "자료를 불러오는 중…"
            ) : error ? (
              <>
                최신 자료 목록을 <span className="text-phrase">확인하지 못했습니다.</span>
              </>
            ) : (
              `${sources.length}개 등록 · 프로젝트 버전 ${revision}`
            )}
          </p>
        </div>
        <div className="cluster">
          <Button onClick={onQuestionnaire}>판매자 질문지</Button>
          <Button onClick={() => onCreateJob(project.id)}>
            이 프로젝트로 작업 만들기 <ArrowRight size={15} />
          </Button>
        </div>
      </header>
      {waiting ? (
        <div className="panel-body">
          <Notice>실제 저장된 자료를 불러오고 있습니다…</Notice>
        </div>
      ) : error ? (
        <div className="empty-small">
          <h3>자료를 불러오지 못했어요</h3>
          <p>새로고침해 최신 자료를 다시 확인하세요.</p>
          <Button onClick={onRefresh}>자료 다시 불러오기</Button>
        </div>
      ) : sources.length ? (
        <div className="source-ledger">
          {sources.map((source) => (
            <SourceRecord key={source.id} source={source} projectId={project.id} onEdit={onEdit} />
          ))}
        </div>
      ) : (
        <div className="empty-small">
          <h3>아직 등록된 자료가 없어요</h3>
          <p>
            제품 사실부터 추가하세요. 레퍼런스만으로 제품의 효능이나 혜택을 만들어내지 않습니다.
          </p>
          <Button variant="primary" onClick={onAdd}>
            내 상품 정보 등록
          </Button>
        </div>
      )}
    </section>
  );
}
