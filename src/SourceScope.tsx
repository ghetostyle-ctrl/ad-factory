import { Library, LockKeyhole } from "lucide-react";
import type { Job } from "../shared/schema";
import { Button, Notice } from "./primitives";
import { SourceRecord } from "./SourceRecord";
import "./sources.css";

export function SourceScope({
  job,
  onLibrary,
}: {
  readonly job: Job;
  readonly onLibrary: () => void;
}) {
  const snapshot = job.sourceSnapshot;
  if (!snapshot)
    return (
      <section className="panel source-empty">
        <div className="panel-body spread">
          <div>
            <h2>프로젝트 자료 없이 만든 작업</h2>
            <p className="muted small-copy">
              현재 브리프로 작업합니다. 새 작업에는 프로젝트 자료를 연결할 수 있습니다.
            </p>
          </div>
          <Button onClick={onLibrary}>
            <Library size={15} />
            자료 라이브러리
          </Button>
        </div>
      </section>
    );
  const proof = snapshot.sources.filter(
    (source) =>
      source.contentStatus === "content" &&
      source.evidence === "observed" &&
      ["product_fact", "offer"].includes(source.kind),
  );
  const references = snapshot.sources.filter(
    (source) => source.kind === "reference" && source.contentStatus === "content",
  );
  const links = snapshot.sources.filter((source) => source.contentStatus === "metadata_only");
  return (
    <section className="panel source-snapshot">
      <header className="panel-header spread">
        <div>
          <div className="cluster">
            <LockKeyhole size={16} />
            <h2>이 작업에 고정된 자료</h2>
          </div>
          <p>
            {snapshot.projectName} · 프로젝트 버전 {snapshot.revision}
          </p>
        </div>
        <Button variant="ghost" onClick={onLibrary}>
          라이브러리 열기
        </Button>
      </header>
      <div className="panel-body stack">
        <p>
          제품 근거 {proof.length}개 · 본문 있는 레퍼런스 {references.length}개 · 링크만 보관{" "}
          {links.length}개
        </p>
        <p className="muted small-copy">
          저장 시각 {new Date(snapshot.capturedAt).toLocaleString("ko-KR")}. 사용이 꺼졌거나 이
          시각에 만료된 자료는 제외했습니다. 이 작업은 저장된 버전을 사용합니다.
        </p>
        {job.productionSourceSnapshot && job.productionSourceSnapshot.assets.length > 0 && (
          <div className="evidence-summary stack">
            <h3>고정된 제작 소스 · 영상 {job.productionSourceSnapshot.assets.length}개</h3>
            <p className="muted small-copy">
              사용 구간·배치·적용 대상·원본 소리 설정을 함께 저장했습니다. 실제 영상 삽입은 영상
              제작 기능 연결 후 적용됩니다.
            </p>
            <a href={`/api/jobs/${job.id}/production-plan`} download="production-plan.json">
              이 작업의 제작 지시서 다운로드
            </a>
          </div>
        )}
        {proof.length === 0 && (
          <Notice tone="warning">
            관측된 제품 사실이나 유효한 혜택 본문이 없습니다. 제품 주장을 뒷받침할 자료를 추가한 뒤
            새 작업을 만드세요.
          </Notice>
        )}
        <details className="evidence-details">
          <summary>저장된 자료 {snapshot.sources.length}개와 식별값 확인</summary>
          <div className="stack">
            <p className="mono digest">{snapshot.digest}</p>
            {snapshot.sources.map((source) => (
              <SourceRecord key={source.id} source={source} at={snapshot.capturedAt} />
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
