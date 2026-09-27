import {
  ArrowRight,
  ArrowUpRight,
  FilePlus2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Target,
} from "lucide-react";
import type { Job } from "../shared/schema";
import { Button, Notice, StatusBadge } from "./primitives";

type OverviewProps = {
  readonly job: Job | null;
  readonly pending: boolean;
  readonly onCreate: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onEdit: () => void;
};
export function JobOverview({ job, pending, onCreate, onRun, onCancel, onEdit }: OverviewProps) {
  if (!job)
    return (
      <section className="welcome-panel">
        <div className="welcome-copy">
          <span className="eyebrow">YOUR NEXT CAMPAIGN</span>
          <h2>
            좋은 광고의 시작,
            <br />
            하나의 제품 브리프.
          </h2>
          <p>
            전략부터 기획, 소재 제작까지.
            <br />세 에이전트의 작업을 한곳에서 확인하세요.
          </p>
          <Button variant="primary" onClick={onCreate}>
            <PlusMark />첫 작업 만들기
            <ArrowRight size={16} />
          </Button>
        </div>
        <div className="welcome-paper" aria-hidden="true">
          <div className="paper-back" />
          <div className="paper-front">
            <FilePlus2 size={30} strokeWidth={1.3} />
            <span>PRODUCT BRIEF</span>
            <i />
            <i />
            <i />
            <div>
              <span className="tiny-dot" />
              Ready when you are
            </div>
          </div>
        </div>
      </section>
    );
  const canEdit = !job.staged && !job.automation && job.status !== "running";
  const isRetry = ["blocked", "cancelled", "failed"].includes(job.status);
  return (
    <section className="panel brief-panel">
      <div className="brief-top">
        <div className="cluster">
          <span className="eyebrow">SELECTED TASK</span>
          <StatusBadge status={job.status} />
        </div>
        <div className="brief-title">
          <h2>{job.name}</h2>
          {canEdit && (
            <Button variant="ghost" onClick={onEdit}>
              <Pencil size={14} />
              수정
            </Button>
          )}
        </div>
        <p className="brief-description">
          {job.sourceSnapshot
            ? `${job.sourceSnapshot.projectName}의 제품 자료를 분석해 소재를 설계합니다.`
            : job.productDescription}
        </p>
        <a href={job.productUrl} target="_blank" rel="noreferrer" className="product-link">
          제품 페이지 열기
          <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="brief-details">
        <div>
          <span>타깃 고객</span>
          <p>
            {job.sourceSnapshot ? "광고 소재별로 타깃 오디언스와 상황을 설계합니다." : job.audience}
          </p>
        </div>
      </div>
      {!job.automation && !job.sourceSnapshot && (
        <details className="manual-actions">
          <summary>선택 사항 · 수동 단계 실행</summary>
          <div className="brief-actions">
            <p>
              <Target size={14} />
              {job.status === "running"
                ? "실제 작업 상태를 아래에서 확인하세요."
                : job.status === "review"
                  ? "수동으로 준비한 광고는 게시 검토에서 확인할 수 있습니다."
                  : "필요한 경우에만 개별 단계를 수동으로 실행합니다."}
            </p>
            {job.status === "running" ? (
              <Button variant="danger" pending={pending} onClick={onCancel}>
                <Square size={13} />
                작업 중지
              </Button>
            ) : (
              <Button
                variant="primary"
                pending={pending}
                disabled={job.status === "review" || job.status === "completed"}
                onClick={onRun}
              >
                {isRetry ? <RotateCcw size={15} /> : <Play size={15} />}
                {isRetry ? "이어서 실행" : "에이전트 실행"}
              </Button>
            )}
          </div>
        </details>
      )}
      {job.result && ["blocked", "failed"].includes(job.status) && (
        <div className="brief-alert">
          <Notice tone={job.status === "failed" ? "error" : "warning"}>{job.result}</Notice>
        </div>
      )}
    </section>
  );
}
function PlusMark() {
  return (
    <span className="plus-mark" aria-hidden="true">
      +
    </span>
  );
}
