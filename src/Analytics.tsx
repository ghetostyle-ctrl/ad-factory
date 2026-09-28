import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Job } from "../shared/schema";
import { errorMessage, postJob } from "./api";
import { Button, Notice } from "./primitives";
import { MetricsSummary, VariantMetrics } from "./VariantMetrics";

export function Analytics({
  job,
  onRefresh,
}: {
  readonly job: Job | null;
  readonly onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (job?.automation?.policy.mode === "creative" && !job.staged)
    return (
      <section className="panel">
        <header className="panel-header">
          <h2>성과 분석</h2>
        </header>
        <div className="panel-body">
          <Notice>이 작업은 소재 제작 전용이므로 광고 집행 데이터가 없습니다.</Notice>
        </div>
      </section>
    );
  const metrics = job?.metrics;
  const automatic = Boolean(job?.automation || job?.sourceSnapshot);
  const canAnalyze = Boolean(job?.staged?.adId && !automatic && job?.status !== "running");
  const analyze = async () => {
    if (!job || !canAnalyze) return;
    setPending(true);
    setError(null);
    try {
      await postJob(`jobs/${job.id}/analyze`);
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="panel">
      <header className="panel-header spread">
        <div>
          <h2>성과 분석</h2>
          <p>Meta에서 반환된 실제 광고 데이터만 표시합니다.</p>
        </div>
        <Button
          disabled={!canAnalyze}
          pending={pending}
          onClick={() => {
            void analyze();
          }}
        >
          <RefreshCw size={15} />
          성과 조회
        </Button>
      </header>
      {automatic && (
        <div className="panel-body">
          <Notice>
            이 작업은 예약된 자동 분석으로 성과를 조회합니다. 다음 자동 분석:{" "}
            {job?.automation?.nextAnalysisAt
              ? new Date(job.automation.nextAnalysisAt).toLocaleString("ko-KR")
              : "예약 없음"}
            . 분석 보고서는 작업 결과물에 저장됩니다.
          </Notice>
        </div>
      )}
      {error && (
        <div className="panel-body">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {metrics ? (
        <div className="panel-body stack">
          {job?.sourceSnapshot && <h3>광고 전체 합계</h3>}
          <MetricsSummary metrics={metrics} />
        </div>
      ) : (
        <div className="empty-small">
          <ChartNoAxesCombined size={20} strokeWidth={1.75} aria-hidden="true" />
          <h3>아직 분석할 데이터가 없어요</h3>
          <p>
            자동 운영에서 예약된 시각에 성과를 조회합니다.
            <br />
            노출·클릭·구매 데이터가 이곳에 표시됩니다.
          </p>
        </div>
      )}
      {job && job.variantMetrics.length > 0 && <VariantMetrics job={job} />}
    </section>
  );
}
