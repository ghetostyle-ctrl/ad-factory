import { FileCheck, List } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Job } from "../shared/schema";
import {
  type ScriptApprovalSummary,
  ScriptApprovalSummarySchema,
  ScriptBatchResultSchema,
} from "../shared/script-batch-approval";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";

function showScript(number?: number) {
  const target = document.getElementById(number ? `video-script-${number}` : "video-scripts");
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}
export function ScriptBatchApproval({
  job,
  onRefresh,
  onShowScript = showScript,
}: {
  readonly job: Job;
  readonly onRefresh: () => void;
  // 대본 카드는 대본·영상 탭에만 있다. 개요 탭에서는 호출한 쪽이 탭을 옮겨 해당 대본을 연다.
  readonly onShowScript?: (number?: number) => void;
}) {
  const [summary, setSummary] = useState<ScriptApprovalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [revision, setRevision] = useState(0);
  const postingRef = useRef(false);
  const base = `jobs/${job.id}/scripts`;
  const summaryUrl = `${base}/approval-summary?version=${encodeURIComponent(job.updatedAt)}&retry=${revision}`;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void api
      .get(summaryUrl, { signal: abort.signal })
      .json<unknown>()
      .then((value) => {
        if (!abort.signal.aborted) {
          setSummary(ScriptApprovalSummarySchema.parse(value));
          setError(null);
        }
      })
      .catch(async (cause: unknown) => {
        if (!abort.signal.aborted) setError(await errorMessage(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [summaryUrl]);
  const eligible = summary?.items.filter((item) => item.state === "pending") ?? [];
  const blocked = summary?.items.filter((item) => item.state === "blocked") ?? [];
  const approved = summary?.items.filter((item) => item.state === "approved").length ?? 0;
  const missing = summary?.items.filter((item) => item.state === "missing").length ?? 0;
  const approve = async () => {
    if (postingRef.current || loading || !summary || summary.busy || !eligible.length || missing)
      return;
    postingRef.current = true;
    setPosting(true);
    setError(null);
    setNotice(null);
    try {
      const value = await api
        .post(`${base}/approve`, {
          json: {
            confirmation: true,
            scripts: eligible.map((item) => ({ number: item.number, digest: item.digest })),
          },
        })
        .json<unknown>();
      const result = ScriptBatchResultSchema.parse(value);
      setSummary(result.summary);
      setNotice(
        `${result.approved.length}개 대본을 승인했습니다.${result.summary.items.some((item) => item.state === "blocked") ? " 수정이 필요한 대본은 아래에서 확인해 주세요." : " 모두 승인되면 기존 설정으로 제작이 이어집니다."}`,
      );
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
      onRefresh();
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };
  return (
    <section className="stack" aria-label="대본 일괄 승인">
      <div className="cluster" aria-live="polite">
        <strong>대본 승인</strong>
        {summary && (
          <span>
            승인 {approved}/{summary.total} · 승인 가능 {eligible.length}개 · 수정 필요{" "}
            {blocked.length}개{missing ? ` · 미작성 ${missing}개` : ""}
          </span>
        )}
        {loading && <span className="muted">승인 상태 확인 중…</span>}
      </div>
      <p className="muted small-copy">
        저장된 대본을 승인합니다. 수정 중인 내용은 먼저 저장하세요. 모두 승인되면 이미지·음성 등
        기존 설정의 유료 제작이 이어집니다.
      </p>
      <div className="cluster operation-actions">
        <Button
          variant="primary"
          pending={posting}
          disabled={
            loading || Boolean(error) || !eligible.length || missing > 0 || summary?.busy === true
          }
          onClick={() => {
            void approve();
          }}
        >
          <FileCheck size={15} aria-hidden="true" />
          {posting
            ? "대본 승인 중…"
            : `모든 대본 승인${eligible.length ? ` (${eligible.length}개)` : ""}`}
        </Button>
        <Button onClick={() => onShowScript()}>
          <List size={15} aria-hidden="true" />
          대본 목록 보기
        </Button>
        {error && (
          <Button disabled={posting || loading} onClick={() => setRevision((value) => value + 1)}>
            승인 상태 다시 불러오기
          </Button>
        )}
      </div>
      {summary?.busy && (
        <p className="muted small-copy">대본 작성이나 제작이 끝난 뒤 승인할 수 있습니다.</p>
      )}
      {blocked.length > 0 && (
        <Notice tone="warning">
          <div className="stack">
            <p>
              수정 필요 {blocked.length}개는 승인하지 않습니다. 나머지 대본은 일괄 승인할 수
              있습니다.
            </p>
            {blocked.map((item) => (
              <div key={item.number} className="stack">
                <strong>{item.number}번 대본</strong>
                {item.problems.map((problem) => (
                  <p key={problem}>{problem}</p>
                ))}
                <Button size="sm" onClick={() => onShowScript(item.number)}>
                  {item.number}번 대본 보기
                </Button>
              </div>
            ))}
          </div>
        </Notice>
      )}
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
