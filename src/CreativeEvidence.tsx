import { Lightbulb } from "lucide-react";
import type { Job } from "../shared/schema";
import { Notice } from "./primitives";
import { VariantStatus } from "./VariantStatus";
import "./sources.css";

const angles = {
  problem_solution: "문제 해결",
  usage_context: "사용 상황",
  objection_answer: "구매 망설임 해소",
} as const;

export function CreativeEvidence({ job }: { readonly job: Job }) {
  const plan = job.creativePlan;
  if (!plan) return null;
  const sourceName = (id: string) =>
    job.sourceSnapshot?.sources.find((source) => source.id === id)?.title ?? id;
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="cluster">
          <Lightbulb size={18} />
          <h2>자료에서 설계한 광고별 타깃과 소재</h2>
        </div>
        <p>가설은 실제 성과로 검증할 아이디어입니다. 제작과 검토는 자동으로 이어집니다.</p>
      </header>
      <div className="panel-body stack">
        <div className="evidence-summary stack">
          <h3>세 광고안이 다른 이유</h3>
          <p>{plan.diversityRationale}</p>
        </div>
        <details className="evidence-details">
          <summary>
            실제로 사용한 자료 · 제품 근거 {plan.sourceCoverage.factsUsed.length}개 · 레퍼런스{" "}
            {plan.sourceCoverage.referencesUsed.length}개 · 고객 언어{" "}
            {plan.sourceCoverage.voicesUsed.length}개
          </summary>
          <div className="stack">
            <p className="muted small-copy">
              제품 근거는 최대 {plan.sourceCoverage.limits.maxFactSources}개·
              {plan.sourceCoverage.limits.maxFactCharacters.toLocaleString()}자, 레퍼런스는 최대{" "}
              {plan.sourceCoverage.limits.maxReferenceSources}개·각{" "}
              {plan.sourceCoverage.limits.maxReferenceCharacters.toLocaleString()}자까지 사용합니다.
              자료는 원문 단위로 선택합니다.
            </p>
            <EvidenceList title="제품 근거" items={plan.sourceCoverage.factsUsed.map(sourceName)} />
            <EvidenceList
              title="고객 언어 · 제품 사실의 증거로 사용하지 않음"
              items={plan.sourceCoverage.voicesUsed.map(sourceName)}
            />
            <p className="muted small-copy">
              고객 언어는 후기 최대 {plan.sourceCoverage.limits.maxVoiceSources}개·
              {plan.sourceCoverage.limits.maxVoiceCharacters.toLocaleString()}자 범위에서
              참고합니다.
            </p>
            <EvidenceList
              title="참고한 레퍼런스"
              items={plan.sourceCoverage.referencesUsed.map(sourceName)}
            />
            <EvidenceList
              title="사용하지 않은 자료와 이유"
              items={plan.sourceCoverage.excluded.map(
                (item) => `${sourceName(item.sourceId)}: ${item.reason}`,
              )}
            />
          </div>
        </details>
        <details className="evidence-details">
          <summary>
            레퍼런스 역분석 {plan.referenceAnalyses.length}개 · 관측·추론·확인 불가 구분
          </summary>
          <div className="stack">
            {plan.referenceAnalyses.length === 0 ? (
              <p className="muted">
                분석할 본문이 있는 레퍼런스가 없습니다. 링크 내용이나 성과를 추정하지 않습니다.
              </p>
            ) : (
              plan.referenceAnalyses.map((reference) => (
                <section className="stack hypothesis-card" key={reference.sourceId}>
                  <h3>{sourceName(reference.sourceId)}</h3>
                  <EvidenceList
                    title="저장된 자료에서 관측한 구조"
                    items={reference.observedStructure}
                  />
                  <EvidenceList title="구조를 바탕으로 한 추론" items={reference.inferences} />
                  <EvidenceList title="확인할 수 없는 내용" items={reference.unknowns} />
                </section>
              ))
            )}
          </div>
        </details>
        {plan.hypotheses.map((hypothesis, index) => {
          const variant = job.creativeVariants.find((item) => item.id === hypothesis.id);
          const image = variant?.approvedImageId
            ? job.artifacts.find((artifact) => artifact.id === variant.approvedImageId)
            : null;
          const staged = job.staged?.variants.find((item) => item.id === hypothesis.id);
          return (
            <article className="hypothesis-card stack" key={hypothesis.id}>
              <div className="hypothesis-heading">
                <span className="hypothesis-number">{index + 1}</span>
                <div>
                  <span className="eyebrow">{angles[hypothesis.angle]}</span>
                  <h3>{hypothesis.creative.concept}</h3>
                  <p>{hypothesis.difference}</p>
                </div>
              </div>
              <dl className="definition-list operation-definition">
                <div>
                  <dt>소재 타깃 오디언스</dt>
                  <dd>{hypothesis.targetAudience}</dd>
                </div>
                <div>
                  <dt>고객의 상황</dt>
                  <dd>{hypothesis.customerSituation}</dd>
                </div>
                <div>
                  <dt>타깃 선정 근거 · 추론</dt>
                  <dd>{hypothesis.targetReason}</dd>
                </div>
                <div>
                  <dt>해결할 문제</dt>
                  <dd>{hypothesis.problem}</dd>
                </div>
                <div>
                  <dt>첫 문장 · 후킹</dt>
                  <dd>{hypothesis.hook}</dd>
                </div>
                <div>
                  <dt>전달할 메시지</dt>
                  <dd>{hypothesis.message}</dd>
                </div>
                <div>
                  <dt>시각적 표현</dt>
                  <dd>{hypothesis.visualMechanism}</dd>
                </div>
              </dl>
              <details className="evidence-details">
                <summary>제품 근거 {hypothesis.claimCitations.length}개와 참고 구조 확인</summary>
                <div className="stack">
                  {hypothesis.claimCitations.map((citation) => (
                    <blockquote
                      key={`${citation.sourceId}-${citation.quote}`}
                      className="source-citation"
                    >
                      <p>“{citation.quote}”</p>
                      <cite>{sourceName(citation.sourceId)}</cite>
                    </blockquote>
                  ))}
                  <p className="muted small-copy">
                    참고한 광고 구조:{" "}
                    {hypothesis.referenceSourceIds.length
                      ? hypothesis.referenceSourceIds.map(sourceName).join(" · ")
                      : "없음"}
                  </p>
                </div>
              </details>
              <section className="copy-preview">
                <span className="eyebrow">실제 광고 카피</span>
                <p>{hypothesis.creative.primaryText}</p>
                <div>
                  <h3>{hypothesis.creative.headline}</h3>
                  <p>{hypothesis.creative.description}</p>
                  <span className="copy-cta">
                    {hypothesis.creative.callToAction === "SHOP_NOW"
                      ? "지금 쇼핑하기"
                      : "더 알아보기"}
                  </span>
                </div>
              </section>
              <VariantStatus variant={variant} job={job} />
              {image && (
                <a href={image.url} target="_blank" rel="noreferrer">
                  <img
                    className="variant-preview"
                    src={image.url}
                    alt={`${hypothesis.creative.concept} 검토 통과 이미지`}
                    loading="lazy"
                    width={1024}
                    height={1024}
                  />
                </a>
              )}
              {staged && (
                <p className="muted small-copy">
                  Meta 광고 ID {staged.adId ?? "준비 중"} · 전달 상태{" "}
                  {staged.deliveryStatus ?? "확인 대기"}
                </p>
              )}
            </article>
          );
        })}
        <EvidenceList title="근거와 분석의 한계" items={plan.limitations} />
        <Notice>
          고객 후기는 개별 경험이며 제품 전체의 효능을{" "}
          <span className="text-phrase">증명하지 않습니다.</span> 레퍼런스의 노출·등록 정보만으로
          성공 광고라고 판단하지 않습니다.
        </Notice>
      </div>
    </section>
  );
}

function EvidenceList({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  return (
    <section className="stack">
      <h3>{title}</h3>
      {items.length ? (
        <ul className="evidence-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">기록된 항목 없음</p>
      )}
    </section>
  );
}
