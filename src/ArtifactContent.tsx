import { z } from "zod";
import {
  AnalysisReportSchema,
  CreativeSchema,
  ImageReviewSchema,
  StrategySchema,
} from "../shared/planning";
import type { Artifact } from "../shared/schema";
import { JobSchema, MetricsSchema } from "../shared/schema";
import { Notice } from "./primitives";
import { MetricsSummary } from "./VariantMetrics";

const StoredAnalysisSchema = z
  .object({
    metrics: MetricsSchema,
    variantMetrics: JobSchema.shape.variantMetrics.optional(),
    report: AnalysisReportSchema,
  })
  .strict();

export function ArtifactContent({
  artifact,
  content,
}: {
  readonly artifact: Artifact;
  readonly content: string | null;
}) {
  if (content === null) return <Notice>파일을 불러오고 있습니다…</Notice>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    if (cause instanceof SyntaxError) return <div className="document-prose">{content}</div>;
    throw cause;
  }
  const strategy = StrategySchema.safeParse(parsed);
  if (strategy.success) {
    const result = strategy.data;
    return (
      <div className="document-content stack">
        <div className="document-heading">
          <span className="eyebrow">전략 문서</span>
          <h3>광고 전략</h3>
          <p>제품과 고객을 연결하는 메시지의 방향</p>
        </div>
        <DocumentSection title="제품 포지셔닝" content={result.positioning} />
        <DocumentSection title="타깃 고객 인사이트" content={result.audienceInsight} />
        <DocumentSection title="핵심 가치 제안" content={result.valueProposition} />
        <DocumentSection title="메시지 방향" content={result.messageAngles} />
        <DocumentSection title="확인할 사항" content={result.risks} />
        <DocumentSection title="성과 측정 계획" content={result.measurementPlan} />
      </div>
    );
  }
  const creative = CreativeSchema.safeParse(parsed);
  if (creative.success) {
    const result = creative.data;
    return (
      <div className="document-content stack">
        <div className="document-heading">
          <span className="eyebrow">소재 기획</span>
          <h3>크리에이티브 기획</h3>
          <p>{result.concept}</p>
        </div>
        <section className="copy-preview">
          <span className="eyebrow">광고 카피</span>
          <p>{result.primaryText}</p>
          <div>
            <h3>{result.headline}</h3>
            <p>{result.description}</p>
            <span className="copy-cta">
              {result.callToAction === "SHOP_NOW" ? "지금 쇼핑하기" : "더 알아보기"}
            </span>
          </div>
        </section>
        <DocumentSection title="제작 의도" content={result.rationale} />
        <DocumentSection title="이미지 제작 방향" content={result.imagePrompt} />
        <DocumentSection title="제작 체크리스트" content={result.checks} />
      </div>
    );
  }
  const review = ImageReviewSchema.safeParse(parsed);
  if (review.success) {
    return (
      <div className="document-content stack">
        <div className="document-heading">
          <span className="eyebrow">AI 소재 검토</span>
          <h3>{review.data.status === "pass" ? "이미지·카피 검토 통과" : "이미지 수정 요청"}</h3>
          <p>{review.data.summary}</p>
        </div>
        <DocumentSection title="확인한 문제" content={review.data.issues} />
        {review.data.revisionPrompt && (
          <DocumentSection title="자동 수정 방향" content={review.data.revisionPrompt} />
        )}
        <Notice>
          AI 검토 결과이며 Meta 정책 심사나 실제 상품 외형의 정확성을 보장하지 않습니다.
        </Notice>
      </div>
    );
  }
  const analysis = StoredAnalysisSchema.safeParse(parsed);
  if (analysis.success) {
    const { metrics, report } = analysis.data;
    return (
      <div className="document-content stack">
        <div className="document-heading">
          <span className="eyebrow">성과 리포트</span>
          <h3>AI 성과 분석</h3>
          <p>{report.summary}</p>
          <p className="muted small-copy">
            관측 기간 {metrics.dateStart} — {metrics.dateStop} · 조회{" "}
            {new Date(metrics.fetchedAt).toLocaleString("ko-KR")}
          </p>
        </div>
        <DocumentSection title="데이터에서 관측한 내용" content={report.observations} />
        <DocumentSection title="검증이 필요한 가설" content={report.hypotheses} />
        <DocumentSection title="다음 운영 제안" content={report.recommendations} />
        <DocumentSection title="분석의 한계" content={report.limitations} />
        {analysis.data.variantMetrics?.map((entry) => (
          <section className="stack hypothesis-card" key={entry.variantId}>
            <h3>광고안 {entry.variantId}</h3>
            <p className="muted small-copy">광고 ID {entry.adId}</p>
            {entry.metrics ? (
              <MetricsSummary metrics={entry.metrics} />
            ) : (
              <Notice>이 광고에서 반환된 성과 데이터가 없습니다.</Notice>
            )}
          </section>
        ))}
        <Notice>제안은 참고 사항입니다. 예산 변경이나 광고 재제작을 자동 실행하지 않습니다.</Notice>
      </div>
    );
  }
  return (
    <div className="stack">
      <Notice>{artifact.name} 파일을 아래 원본 링크에서 확인할 수 있습니다.</Notice>
      <details>
        <summary>원본 데이터 보기</summary>
        <pre className="text-preview">{content}</pre>
      </details>
    </div>
  );
}
function DocumentSection({
  title,
  content,
}: {
  readonly title: string;
  readonly content: string | readonly string[];
}) {
  return (
    <section className="document-section">
      <h3>{title}</h3>
      {typeof content === "string" ? (
        <p>{content}</p>
      ) : content.length ? (
        <ul>
          {content.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">추가 항목 없음</p>
      )}
    </section>
  );
}
