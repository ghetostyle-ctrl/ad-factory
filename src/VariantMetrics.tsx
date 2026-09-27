import type { Job, Metrics } from "../shared/schema";
import { moneyLabel } from "./api";
import { Notice } from "./primitives";

export function MetricsSummary({ metrics }: { readonly metrics: Metrics }) {
  const values = [
    ["광고비", moneyLabel(metrics.spend, metrics.currency)],
    ["노출", metrics.impressions.toLocaleString("ko-KR")],
    ["클릭", metrics.clicks.toLocaleString("ko-KR")],
    ["구매", metrics.purchases.toLocaleString("ko-KR")],
    ["ROAS", metrics.roas === null ? "계산 불가" : `${metrics.roas.toFixed(2)}×`],
    ["클릭률", metrics.ctr === null ? "계산 불가" : `${metrics.ctr.toFixed(2)}%`],
  ];
  return (
    <div className="stack">
      <div className="metric-grid">
        {values.map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="muted small-copy">
        {metrics.dateStart} — {metrics.dateStop} · 조회{" "}
        {new Date(metrics.fetchedAt).toLocaleString("ko-KR")}
      </p>
    </div>
  );
}

export function VariantMetrics({ job }: { readonly job: Job }) {
  return (
    <div className="panel-body stack">
      <h3>광고안별 실제 성과</h3>
      {job.variantMetrics.map((entry) => (
        <section className="hypothesis-card stack" key={entry.variantId}>
          <div>
            <h3>
              {job.creativeVariants.find((variant) => variant.id === entry.variantId)?.creative
                .headline ?? entry.variantId}
            </h3>
            <p className="muted small-copy">광고 ID {entry.adId}</p>
          </div>
          {entry.metrics ? (
            <MetricsSummary metrics={entry.metrics} />
          ) : (
            <Notice>
              이 광고에서 반환된 성과 데이터가 없습니다. 값이 없는 항목을 0으로 표시하지 않습니다.
            </Notice>
          )}
        </section>
      ))}
    </div>
  );
}
