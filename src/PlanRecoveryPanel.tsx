import { Play, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type PlanRecovery, PlanRecoverySchema } from "../shared/plan-recovery";
import type { Job } from "../shared/schema";
import { api, errorMessage, postJob } from "./api";
import { Button, Notice } from "./primitives";

export function PlanRecoveryPanel({
  job,
  onRefresh,
}: {
  readonly job: Job;
  readonly onRefresh: () => void;
}) {
  const titleId = useId();
  const [view, setView] = useState<PlanRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"use" | "replan" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision triggers an explicit read-only refresh requested by the user.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setView(null);
    setError(null);
    void api
      .get(`jobs/${job.id}/plan-recovery`, { signal: controller.signal })
      .json()
      .then((response) => {
        if (!controller.signal.aborted) setView(PlanRecoverySchema.nullable().parse(response));
      })
      .catch(async (cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = await errorMessage(cause);
        if (!controller.signal.aborted) setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [job.id, revision]);
  async function choose(action: "use" | "replan") {
    if (!view || pending) return;
    setPending(action);
    setError(null);
    try {
      await postJob(`jobs/${job.id}/plan-recovery`, {
        confirmation: true,
        action,
        draftName: view.draftName,
        draftDigest: view.draftDigest,
      });
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  }
  return (
    <section
      className="plan-choice stack"
      aria-labelledby={titleId}
      aria-busy={loading || pending !== null}
    >
      <h3 id={titleId}>기획을 확인하고 다음 단계를 선택하세요</h3>
      {loading && <p role="status">저장된 기획을 확인하고 있습니다.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      {!loading && !view && !error && (
        <Notice>선택할 기획이 없습니다. 작업 상태를 다시 확인하세요.</Notice>
      )}
      {!loading && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RotateCcw size={14} aria-hidden="true" /> 기획 다시 확인
        </Button>
      )}
      {view && (
        <>
          <Notice tone="warning">
            {view.canUse
              ? "구성 경고를 남기고 이 기획으로 제작하거나, 부족한 부분을 반영해 다시 기획할 수 있습니다."
              : "자료·구조 오류가 있어 현재 기획으로 제작할 수 없습니다. 내용을 확인하고 다시 기획하세요."}
            {view.warnings.length > 0 && (
              <ul>
                {view.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {view.blockingIssues.length > 0 && (
              <ul>
                {view.blockingIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </Notice>
          <ul className="cluster plan-stage-counts" aria-label="광고안 구성">
            <li>관심 끌기 {view.stageCounts.need_awareness}개</li>
            <li>제품 비교 {view.stageCounts.comparison}개</li>
            <li>구매 결정 {view.stageCounts.final_decision}개</li>
          </ul>
          <details className="evidence-details">
            <summary>저장된 광고안 {view.hypotheses.length}개 확인</summary>
            <div className="stack">
              {view.hypotheses.map((hypothesis, index) => (
                <article className="source-citation stack-tight" key={hypothesis.id}>
                  <h4>
                    {index + 1}. {hypothesis.creative.headline}
                  </h4>
                  <p className="source-content">{hypothesis.creative.primaryText}</p>
                  {hypothesis.creative.description && <p>{hypothesis.creative.description}</p>}
                  <details className="evidence-details">
                    <summary>이미지 기획 확인</summary>
                    <p className="source-content">{hypothesis.creative.imagePrompt}</p>
                  </details>
                </article>
              ))}
              <a href={`/api/artifacts/${job.id}/${view.draftName}`} download>
                기획 원본 내려받기
              </a>
            </div>
          </details>
          <div className="cluster operation-actions">
            <Button
              variant="primary"
              pending={pending === "use"}
              disabled={!view.canUse || pending !== null}
              onClick={() => {
                void choose("use");
              }}
            >
              <Play size={14} aria-hidden="true" /> 현재 기획으로 제작
            </Button>
            <Button
              pending={pending === "replan"}
              disabled={pending !== null}
              onClick={() => {
                void choose("replan");
              }}
            >
              <RotateCcw size={14} aria-hidden="true" /> 다시 기획
            </Button>
          </div>
          <p className="muted">
            현재 기획으로 제작하면 다음 제작 단계부터, 다시 기획하면 기획 단계부터 기존 설정의 API
            비용이 발생합니다.
          </p>
        </>
      )}
    </section>
  );
}
