import { ExternalLink, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Job } from "../shared/schema";
import { errorMessage, moneyLabel, postJob } from "./api";
import { Button, Notice } from "./primitives";

export function PublishReview({
  job,
  onRefresh,
  onAccount,
}: {
  readonly job: Job | null;
  readonly onRefresh: () => void;
  readonly onAccount: () => void;
}) {
  const [approvedDigest, setApprovedDigest] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (job?.automation?.policy.mode === "creative" && !job.staged)
    return (
      <section className="panel">
        <header className="panel-header">
          <h2>광고 설정과 게시 상태</h2>
        </header>
        <div className="panel-body">
          <Notice>
            이 작업은 소재 기획·제작·검토 전용입니다. Meta 광고 계정 연결과 게시 설정은 별도 광고
            운영 영역에서 진행합니다. 여기서 광고가 자동으로 등록되거나 집행되지 않습니다.
          </Notice>
        </div>
      </section>
    );
  const staged = job?.staged;
  const automatic = Boolean(job?.automation);
  const prepared = Boolean(
    staged?.adId &&
      staged.campaignId &&
      staged.adsetId &&
      staged.creativeId &&
      (!job?.sourceSnapshot ||
        (staged.variants.length === 3 &&
          staged.variants.every((variant) => variant.adId && variant.creativeId))) &&
      !staged.publishedAt &&
      !staged.pendingOperation,
  );
  const ready = prepared && !automatic && job?.status !== "running";
  const publish = async () => {
    if (!job || !staged || !ready || approvedDigest !== staged.digest) return;
    setPending(true);
    setError(null);
    try {
      await postJob(`jobs/${job.id}/publish`, { confirmation: true, digest: staged.digest });
      setApprovedDigest(null);
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="cluster">
          <ShieldCheck size={18} />
          <h2>광고 설정과 게시 상태</h2>
        </div>
        <p>실제 계정·예산·소재와 Meta 게시 상태를 확인합니다.</p>
      </header>
      <div className="panel-body stack">
        {automatic && (
          <Notice>
            이 작업의 게시는 최초에 승인한 자동 운영 정책을 따릅니다. 수동 게시 승인을 사용할 수
            없습니다.
          </Notice>
        )}
        <div className="review-banner">
          <LockKeyhole size={21} />
          <div>
            <strong>
              {staged?.publishedAt
                ? "게시가 승인된 광고입니다"
                : prepared
                  ? "광고 게시 준비를 마쳤어요"
                  : "게시 준비가 필요합니다"}
            </strong>
            <p>
              {prepared
                ? "아래 설정으로 활성화하면 광고비가 집행될 수 있습니다."
                : staged?.publishedAt
                  ? `Meta 전달 상태: ${staged.deliveryStatus ?? "확인 대기"}`
                  : automatic
                    ? "자동 운영의 현재 단계와 다음 작업을 작업 공간에서 확인하세요."
                    : "광고 준비 상태와 계정 설정을 작업 공간에서 확인하세요."}
            </p>
          </div>
        </div>
        {staged?.pendingOperation && (
          <Notice tone="warning">
            Meta 처리 결과를 확인해야 합니다: {staged.pendingOperation}. 중복 게시를 막기 위해
            승인이 잠겼습니다.
          </Notice>
        )}
        {job && (
          <dl className="definition-list">
            <div>
              <dt>광고 계정</dt>
              <dd>{staged?.accountId ?? job.accountId ?? "선택 전"}</dd>
            </div>
            <div>
              <dt>일 예산</dt>
              <dd>
                {staged
                  ? moneyLabel(staged.dailyBudget, staged.currency)
                  : job.dailyBudget === null
                    ? "미정"
                    : moneyLabel(job.dailyBudget, job.currency)}
              </dd>
            </div>
            <div>
              <dt>목표 · 국가</dt>
              <dd>
                {(staged?.objective ?? job.objective) === "sales" ? "구매 전환" : "사이트 방문"} ·{" "}
                {staged?.country ?? job.country}
              </dd>
            </div>
            {job.sourceSnapshot && (
              <div>
                <dt>광고안 · 예산 범위</dt>
                <dd>
                  광고안 3개가 하나의 캠페인·광고 세트에서{" "}
                  <span className="text-phrase">일 예산</span>을{" "}
                  <span className="text-phrase">함께 사용합니다.</span>
                </dd>
              </div>
            )}
            <div>
              <dt>Facebook 페이지</dt>
              <dd>{staged?.pageId ?? job.selection?.pageId ?? "지정 전"}</dd>
            </div>
            <div>
              <dt>도착 페이지</dt>
              <dd>
                <a href={job.productUrl} target="_blank" rel="noreferrer">
                  {job.productUrl}
                </a>
              </dd>
            </div>
            {staged && (
              <>
                <div>
                  <dt>캠페인 / 광고 세트</dt>
                  <dd className="mono">
                    {staged.campaignId ?? "준비 전"} / {staged.adsetId ?? "준비 전"}
                  </dd>
                </div>
                <div>
                  <dt>소재 / 광고 ID</dt>
                  <dd className="mono">
                    {staged.creativeId ?? "준비 전"} / {staged.adId ?? "준비 전"}
                  </dd>
                </div>
                <div>
                  <dt>소재 파일</dt>
                  <dd>
                    {job.artifacts.find((artifact) => artifact.id === staged.artifactId)?.name ??
                      staged.artifactId}
                  </dd>
                </div>
                <div>
                  <dt>설정 식별값</dt>
                  <dd className="mono digest">{staged.digest}</dd>
                </div>
                {staged.variants.map((variant) => (
                  <div key={variant.id}>
                    <dt>광고안 {variant.id}</dt>
                    <dd>
                      <strong>{variant.creativeSnapshot.headline}</strong>
                      <br />
                      소재 {variant.creativeId ?? "준비 전"} / 광고 {variant.adId ?? "준비 전"}
                      <br />
                      {job.artifacts.find((artifact) => artifact.id === variant.artifactId)?.name ??
                        variant.artifactId}
                      <br />
                      전달 상태 {variant.deliveryStatus ?? "확인 대기"}
                    </dd>
                  </div>
                ))}
              </>
            )}
          </dl>
        )}
        {job && !staged && !job.automation && <Button onClick={onAccount}>광고 계정 설정</Button>}
        {staged?.managerUrl && (
          <a
            href={staged.managerUrl}
            target="_blank"
            rel="noreferrer"
            className="button button-secondary"
          >
            <ExternalLink size={15} />
            Meta에서 광고 확인
          </a>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {staged?.publishedAt ? (
          <Notice>승인 시각: {new Date(staged.publishedAt).toLocaleString("ko-KR")}</Notice>
        ) : (
          !automatic && (
            <details className="settings-details">
              <summary>선택 사항 · 수동 게시 승인</summary>
              <label className="approval-check">
                <input
                  type="checkbox"
                  checked={Boolean(staged && approvedDigest === staged.digest)}
                  disabled={!ready}
                  onChange={(event) =>
                    setApprovedDigest(event.target.checked && staged ? staged.digest : null)
                  }
                />
                <span>위 계정·예산·소재를 확인했으며 이 광고의 게시를 승인합니다.</span>
              </label>
              <Button
                variant="primary"
                disabled={!ready || approvedDigest !== staged?.digest}
                pending={pending}
                onClick={() => {
                  void publish();
                }}
              >
                <ShieldCheck size={16} />
                확인한 설정으로 게시 승인
              </Button>
            </details>
          )
        )}
      </div>
    </section>
  );
}
