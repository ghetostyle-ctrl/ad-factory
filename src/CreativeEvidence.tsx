import type { LearningSignal } from "../shared/creative-plan";
import type { Job } from "../shared/schema";
import { AdGrid, PlanSummary, STAGE_LABELS, StageSummary, stageCounts } from "./EvidenceTab";
import { PlanTargetsSection } from "./PlanTargets";
import { Disclosure, Notice } from "./primitives";
import "./sources.css";

const questionKinds = {
  buying_reason: "사는 이유",
  hesitation: "망설이는 이유",
  decision_criterion: "확인하고 싶은 기준",
} as const;
const questionBases = {
  customer_voice: "고객 후기 표현",
  product_fact: "제품 자료",
  inferred: "추정 · 검증 필요",
} as const;

function Title({ children, sub }: { readonly children: string; readonly sub?: string }) {
  return (
    <>
      <span className="ds-title">{children}</span>
      {sub && <span className="ds-sub">{sub}</span>}
    </>
  );
}

// 기획 근거 탭: 광고안 요약 카드 격자가 먼저, 광고안 사이를 가르는 근거(고객 질문·자료·레퍼런스·한계)는 접어 둔다.
export function CreativeEvidence({ job }: { readonly job: Job }) {
  const plan = job.creativePlan;
  if (!plan) return null;
  const sourceName = (id: string) =>
    job.sourceSnapshot?.sources.find((source) => source.id === id)?.title ?? id;
  const counts = stageCounts(plan);
  const staged = plan.hypotheses.some((item) => item.decisionRole);
  return (
    <section className="evidence-tab" aria-label="기획 근거">
      <header className="tab-head">
        <div>
          <h2>
            광고안 <span className="count-label">{plan.hypotheses.length}</span>
          </h2>
          <p>광고안은 타겟 한 명·고통 하나·메시지 하나입니다. 제작과 검토는 자동으로 이어집니다.</p>
        </div>
        <StageSummary plan={plan} />
      </header>
      <PlanSummary job={job} plan={plan} />
      <AdGrid job={job} plan={plan} />
      <div className="evidence-more">
        <Disclosure
          summary={
            <Title sub="같은 근거 안에서 서로 다른 설득을 검증합니다">
              광고안이 서로 다른 이유
            </Title>
          }
        >
          <div className="stack">
            <p>{plan.diversityRationale}</p>
            {staged && (
              <p className="muted small-copy">
                한 세트 편성 · {STAGE_LABELS.need_awareness} {counts.need_awareness}개 ·{" "}
                {STAGE_LABELS.comparison} {counts.comparison}개 · {STAGE_LABELS.final_decision}{" "}
                {counts.final_decision}개. 같은 오디언스 안에도 인식 단계가 다른 사람이 섞여 있어,
                단계별 소재를 함께 둡니다.
              </p>
            )}
          </div>
        </Disclosure>
        <PlanTargetsSection plan={plan} />
        {plan.customerQuestions.length > 0 && (
          <Disclosure
            summary={
              <Title sub="왜 사고, 왜 망설이고, 무엇을 확인하면 사는가">
                {`고객 질문 ${plan.customerQuestions.length}개`}
              </Title>
            }
          >
            <div className="stack">
              {plan.customerQuestions.map((question) => {
                const answeredBy = plan.hypotheses
                  .map((item, index) => (item.customerQuestionId === question.id ? index + 1 : 0))
                  .filter(Boolean);
                return (
                  <section className="stack hypothesis-card" key={question.id}>
                    <span className="eyebrow">
                      {questionKinds[question.kind]} · {questionBases[question.basis]}
                    </span>
                    <h3>“{question.question}”</h3>
                    <dl className="definition-list operation-definition">
                      <div>
                        <dt>설득에 필요한 증거</dt>
                        <dd>{question.proofNeeded}</dd>
                      </div>
                      <div>
                        <dt>근거 자료</dt>
                        <dd>
                          {question.sourceIds.length
                            ? question.sourceIds.map(sourceName).join(" · ")
                            : "없음 · 추정"}
                        </dd>
                      </div>
                      <div>
                        <dt>이미 답한 레퍼런스</dt>
                        <dd>
                          {question.answeredByReferences.length
                            ? question.answeredByReferences.map(sourceName).join(" · ")
                            : "없음"}
                        </dd>
                      </div>
                      <div>
                        <dt>이 질문에 답하는 광고안</dt>
                        <dd>
                          {answeredBy.length
                            ? answeredBy.map((n) => `광고안 ${n}`).join(", ")
                            : "없음"}
                        </dd>
                      </div>
                    </dl>
                  </section>
                );
              })}
            </div>
          </Disclosure>
        )}
        {plan.learningSignal && (
          <Disclosure summary={<Title>학습에 쓸 신호가 충분한가</Title>}>
            <LearningSignalNote signal={plan.learningSignal} />
          </Disclosure>
        )}
        <Disclosure
          summary={
            <Title
              sub={`제품 근거 ${plan.sourceCoverage.factsUsed.length}개 · 레퍼런스 ${plan.sourceCoverage.referencesUsed.length}개 · 고객 언어 ${plan.sourceCoverage.voicesUsed.length}개`}
            >
              실제로 사용한 자료
            </Title>
          }
        >
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
        </Disclosure>
        <Disclosure
          summary={
            <Title sub="관측·추론·확인 불가 구분">{`레퍼런스 역분석 ${plan.referenceAnalyses.length}개`}</Title>
          }
        >
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
        </Disclosure>
        <Disclosure summary={<Title>근거와 분석의 한계</Title>}>
          <div className="stack">
            {plan.limitations.length ? (
              <ul className="evidence-list">
                {plan.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">기록된 항목 없음</p>
            )}
            <Notice>
              고객 후기는 개별 경험이며 제품 전체의 효능을{" "}
              <span className="text-phrase">증명하지 않습니다.</span> 레퍼런스의 노출·등록
              정보만으로 성공 광고라고 판단하지 않습니다.
            </Notice>
          </div>
        </Disclosure>
      </div>
    </section>
  );
}

function LearningSignalNote({ signal }: { readonly signal: LearningSignal }) {
  const money = (value: number) => `${Math.round(value).toLocaleString()} ${signal.currency}`;
  const result = signal.optimizationResult === "purchase" ? "구매" : "링크 클릭";
  return (
    <div className="stack">
      <p>
        일 예산 {money(signal.dailyBudget)} × 7일 = 주 {money(signal.weeklyBudget)}. 광고 세트가 주{" "}
        {signal.weeklyResultsReference}건 전후의 {result}를 얻으려면 {result} 1건당 비용이{" "}
        <strong>{money(signal.maxCostPerResultFor50)} 이하</strong>여야 합니다.
      </p>
      <p className="muted small-copy">
        권장 예산이 아닌 단순 계산입니다. 주 50건은 Meta 도움말의 일반적인 학습 안정 기준이며 보장이
        아닙니다. 광고안 {signal.conceptCount}개는 같은 예산을 나눠 쓰므로 광고안을 늘려도 학습
        데이터가 늘지 않습니다.
      </p>
    </div>
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
