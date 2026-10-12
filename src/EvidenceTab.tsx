import { useEffect, useState } from "react";
import { type CreativePlan, targetFitScore } from "../shared/creative-plan";
import { StrategySchema } from "../shared/planning";
import type { Artifact, Job } from "../shared/schema";
import { firstSentence, stripEnumPrefix, variantUiState } from "../shared/ui-state";
import { ArtifactContent } from "./ArtifactContent";
import { api } from "./api";
import { ChainView, entryPoints, SolutionPathView } from "./PlanTargets";
import { Button, Dialog, Disclosure, StatusDot, Tag } from "./primitives";
import "./tabs.css";

type Hypothesis = CreativePlan["hypotheses"][number];

// 기획 근거 탭의 조각: 전략·기획 2줄 요약, 광고안 요약 카드 격자(카드 안 Disclosure 에 기존 상세 전부).
export const angles = {
  problem_solution: "문제 해결",
  usage_context: "사용 상황",
  objection_answer: "구매 망설임 해소",
} as const;
export const formats = {
  problem_empathy: "문제 제기형",
  mechanism_explainer: "메커니즘 설명형 카드뉴스",
  review_proof: "사용자 리뷰·비포애프터",
  benefit_offer: "혜택 강조형",
  risk_reversal: "리스크 제거 강조",
} as const;
export const mechanismModes = {
  unique_mechanism: "고유 메커니즘",
  cause_reframe: "원인 재해석",
  social_proof: "고객 후기 증거",
} as const;
export const offerTypes = {
  none: "오퍼 없음",
  value_bundle: "가치 더하기(번들·보너스)",
  free_trial: "무료 체험",
  discount: "할인",
  urgency: "기한·수량 한정",
  risk_reversal: "환불·보증",
} as const;
// 구매 여정 단계(docs/UI-V2 6절): TOFU/MOFU/BOFU 대신 사용자 말.
export const STAGE_LABELS = {
  need_awareness: "처음 알리기",
  comparison: "비교 중",
  final_decision: "구매 직전",
} as const;
const STAGES = ["need_awareness", "comparison", "final_decision"] as const;

// 모델이 붙인 enum 접두("mechanism_explainer | 맛 접촉 경로", "mechanism_explainer: …")를 벗긴다.
export function cleanConcept(text: string): string {
  return stripEnumPrefix(text)
    .replace(/^[a-z_]+:\s+/u, "")
    .trim();
}
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

export function stageCounts(plan: CreativePlan): Record<(typeof STAGES)[number], number> {
  return {
    need_awareness: plan.hypotheses.filter((item) => item.decisionRole === "need_awareness").length,
    comparison: plan.hypotheses.filter((item) => item.decisionRole === "comparison").length,
    final_decision: plan.hypotheses.filter((item) => item.decisionRole === "final_decision").length,
  };
}
export function StageSummary({ plan }: { readonly plan: CreativePlan }) {
  if (!plan.hypotheses.some((item) => item.decisionRole)) return null;
  const counts = stageCounts(plan);
  return (
    <ul className="stage-summary" aria-label="구매 여정 단계별 광고안 수">
      {STAGES.map((stage) => (
        <li key={stage} className={counts[stage] === 0 ? "is-zero" : undefined}>
          {STAGE_LABELS[stage]} <b>{counts[stage]}</b>
        </li>
      ))}
    </ul>
  );
}

function useArtifactText(url: string | undefined): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!url) return;
    const request = new AbortController();
    api
      .get(url.replace(/^\/api\//u, ""), { signal: request.signal })
      .text()
      .then((value) => {
        if (!request.signal.aborted) setText(value);
      })
      .catch(() => undefined);
    return () => request.abort();
  }, [url]);
  return text;
}
function strategyLine(text: string | null): string {
  if (!text) return "";
  try {
    const parsed = StrategySchema.safeParse(JSON.parse(text));
    return parsed.success ? firstSentence(parsed.data.positioning, 130) : "";
  } catch (cause) {
    if (cause instanceof SyntaxError) return "";
    throw cause;
  }
}
const lastNamed = (artifacts: readonly Artifact[], pattern: RegExp) =>
  artifacts.findLast((artifact) => pattern.test(artifact.name));

function DocumentDialog({
  artifact,
  title,
  content,
  onClose,
}: {
  readonly artifact: Artifact;
  readonly title: string;
  readonly content: string | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="stack">
        <ArtifactContent artifact={artifact} content={content} />
        <a className="button button-secondary" href={artifact.url} target="_blank" rel="noreferrer">
          원본 열기
        </a>
      </div>
    </Dialog>
  );
}

// 전략·기획 한 줄씩. 전략은 전략 문서의 첫 문장, 기획은 광고안이 서로 다른 이유의 첫 문장이다.
export function PlanSummary({ job, plan }: { readonly job: Job; readonly plan: CreativePlan }) {
  const strategy = lastNamed(job.artifacts, /^strategy(?:-auto|-\d+)?\.json$/u);
  const planDoc =
    lastNamed(job.artifacts, /^source-plan-auto\.json$/u) ??
    lastNamed(job.artifacts, /^creative(?:-auto|-\d+)?\.json$/u);
  const text = useArtifactText(strategy?.url);
  const [open, setOpen] = useState(false);
  const strategyText = strategyLine(text);
  const planText = firstSentence(plan.diversityRationale, 130);
  if (!strategy && !planText) return null;
  return (
    <section className="plan-summary" aria-label="전략과 기획 요약">
      <dl>
        {strategy && (
          <div>
            <dt>전략</dt>
            <dd>{strategyText || "자료를 분석해 만든 광고 전략 문서가 있어요."}</dd>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              전략 문서 보기
            </Button>
          </div>
        )}
        {planText && (
          <div>
            <dt>기획</dt>
            <dd>{planText}</dd>
            {planDoc ? (
              <a
                className="button button-ghost button-sm"
                href={planDoc.url}
                target="_blank"
                rel="noreferrer"
              >
                기획 원본 열기
              </a>
            ) : (
              <span />
            )}
          </div>
        )}
      </dl>
      {open && strategy && (
        <DocumentDialog
          artifact={strategy}
          title="광고 전략"
          content={text}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

// 광고안 상세: 요약 카드를 펼치면 보이는 기존 상세(사슬·근거·신호·타겟 점수·카피·이미지)
function AdDetail({
  job,
  plan,
  hypothesis,
}: {
  readonly job: Job;
  readonly plan: CreativePlan;
  readonly hypothesis: Hypothesis;
}) {
  const sourceName = (id: string) =>
    job.sourceSnapshot?.sources.find((source) => source.id === id)?.title ?? id;
  const variant = job.creativeVariants.find((item) => item.id === hypothesis.id);
  const image = variant?.approvedImageId
    ? job.artifacts.find((artifact) => artifact.id === variant.approvedImageId)
    : null;
  const staged = job.staged?.variants.find((item) => item.id === hypothesis.id);
  const target = plan.targets?.find((item) => item.id === hypothesis.targetId);
  return (
    <div className="ad-detail stack">
      <p className="ad-difference">
        <span className="eyebrow">{angles[hypothesis.angle]}</span>
        {hypothesis.difference}
      </p>
      <dl className="definition-list operation-definition">
        {hypothesis.targetId && (
          <div>
            <dt>타겟</dt>
            <dd>{target?.label ?? hypothesis.targetId}</dd>
          </div>
        )}
        {target?.fit && (
          <div>
            <dt>타겟 점수</dt>
            <dd>
              {targetFitScore(target.fit)} (고통 {target.fit.painStrength} × 우리 상품의 답{" "}
              {target.fit.productAnswer} × 차이 {target.fit.distinctness})
            </dd>
          </div>
        )}
        {hypothesis.entryPoint && (
          <div>
            <dt>앞에 세우는 것</dt>
            <dd>{entryPoints[hypothesis.entryPoint]}</dd>
          </div>
        )}
        {hypothesis.chain && (
          <div>
            <dt>설득 사슬 (이 영상의 메시지 하나)</dt>
            <dd>
              <ChainView chain={hypothesis.chain} />
            </dd>
          </div>
        )}
        {hypothesis.solutionPath && (
          <div>
            <dt>
              해결 과정 ·{" "}
              {hypothesis.solutionPath.flow === "cause_reframe" ? "원인 재해석" : "기준 선점"}
            </dt>
            <dd>
              <SolutionPathView path={hypothesis.solutionPath} />
            </dd>
          </div>
        )}
        {hypothesis.customerQuestionId && (
          <div>
            <dt>답하는 고객 질문</dt>
            <dd>
              {plan.customerQuestions.find((item) => item.id === hypothesis.customerQuestionId)
                ?.question ?? hypothesis.customerQuestionId}
            </dd>
          </div>
        )}
        {hypothesis.decisionRole && (
          <div>
            <dt>구매 여정의 단계</dt>
            <dd>{STAGE_LABELS[hypothesis.decisionRole]}</dd>
          </div>
        )}
        {hypothesis.proofShown && (
          <div>
            <dt>보여 줄 증거</dt>
            <dd>{hypothesis.proofShown}</dd>
          </div>
        )}
        {hypothesis.signals && (
          <>
            <div>
              <dt>소재 유형</dt>
              <dd>{formats[hypothesis.signals.format]}</dd>
            </div>
            <div>
              <dt>신호 1 · 부르는 대상</dt>
              <dd>{hypothesis.signals.avatarCallout}</dd>
            </div>
            <div>
              <dt>신호 2 · 페인포인트</dt>
              <dd>{hypothesis.signals.painPoint}</dd>
            </div>
            <div>
              <dt>신호 3 · {mechanismModes[hypothesis.signals.mechanism.mode]}</dt>
              <dd>{hypothesis.signals.mechanism.statement}</dd>
            </div>
            <div>
              <dt>신호 4 · {offerTypes[hypothesis.signals.offer.type]}</dt>
              <dd>{hypothesis.signals.offer.statement || "이 단계에서는 오퍼를 쓰지 않음"}</dd>
            </div>
          </>
        )}
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
      <Disclosure
        variant="plain"
        summary={`제품 근거 ${hypothesis.claimCitations.length}개와 참고 구조 확인`}
      >
        <div className="stack">
          {hypothesis.claimCitations.map((citation) => (
            <blockquote key={`${citation.sourceId}-${citation.quote}`} className="source-citation">
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
      </Disclosure>
      <section className="copy-preview">
        <span className="eyebrow">실제 광고 카피</span>
        <p>{hypothesis.creative.primaryText}</p>
        <div>
          <h3>{hypothesis.creative.headline}</h3>
          <p>{hypothesis.creative.description}</p>
          <span className="copy-cta">
            {hypothesis.creative.callToAction === "SHOP_NOW" ? "지금 쇼핑하기" : "더 알아보기"}
          </span>
        </div>
      </section>
      <div className="cluster">
        <StatusDot state={variantUiState(variant, job)} />
        <span className="muted small-copy">실제 이미지 생성 {variant?.imageAttempts ?? 0}/2회</span>
      </div>
      {image && (
        <a href={image.url} target="_blank" rel="noreferrer">
          <img
            className="variant-preview"
            src={image.url}
            alt={`${cleanConcept(hypothesis.creative.concept)} 검토 통과 이미지`}
            loading="lazy"
            width={1024}
            height={1024}
          />
        </a>
      )}
      {hypothesis.cardSlides.length > 0 && (
        <div className="stack">
          <span className="eyebrow">
            카드뉴스 {hypothesis.cardSlides.length + 1}장 · 1장은 위 대표 이미지
          </span>
          <ol className="card-slides">
            {hypothesis.cardSlides.map((slide, slideIndex) => {
              const cardId = variant?.cardImageIds[slideIndex];
              const card = cardId ? job.artifacts.find((artifact) => artifact.id === cardId) : null;
              return (
                <li key={`${hypothesis.id}-card-${slide.headline}`}>
                  {card ? (
                    <a href={card.url} target="_blank" rel="noreferrer">
                      <img
                        src={card.url}
                        alt={`카드뉴스 ${slideIndex + 2}장: ${slide.headline}`}
                        loading="lazy"
                        width={1024}
                        height={1024}
                      />
                    </a>
                  ) : (
                    <div className="card-slide-pending">제작 대기</div>
                  )}
                  <strong>
                    {slideIndex + 2}. {slide.headline}
                  </strong>
                  {slide.body && <span className="muted">{slide.body}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {staged && (
        <p className="muted small-copy">
          Meta 광고 ID {staged.adId ?? "준비 중"} · 전달 상태 {staged.deliveryStatus ?? "확인 대기"}
        </p>
      )}
    </div>
  );
}

// 광고안 요약 카드(≤240px): 번호 · 제목 · 단계 칩 / 타겟 / 메시지 / 근거 2개. 상세는 카드 안 Disclosure.
function AdCard({
  job,
  plan,
  hypothesis,
  index,
}: {
  readonly job: Job;
  readonly plan: CreativePlan;
  readonly hypothesis: Hypothesis;
  readonly index: number;
}) {
  const variant = job.creativeVariants.find((item) => item.id === hypothesis.id);
  const image = variant?.approvedImageId
    ? job.artifacts.find((artifact) => artifact.id === variant.approvedImageId)
    : null;
  const target =
    plan.targets?.find((item) => item.id === hypothesis.targetId)?.label ??
    hypothesis.targetAudience;
  const message =
    hypothesis.message || hypothesis.chain?.outcome.content || hypothesis.creative.headline;
  const title = cleanConcept(hypothesis.creative.concept);
  return (
    <li className="ad-card">
      <div className="ad-card-face">
        <div className="ad-card-top">
          <span className="ad-no">{index + 1}</span>
          <h3 title={title}>{title}</h3>
          {hypothesis.decisionRole && <Tag>{STAGE_LABELS[hypothesis.decisionRole]}</Tag>}
        </div>
        <div className="ad-card-main">
          <div className="ad-card-text">
            <p className="ad-line">
              <span>타겟</span>
              {target}
            </p>
            <p className="ad-line is-message">
              <span>메시지</span>
              {message}
            </p>
          </div>
          {image && (
            <img
              className="ad-thumb"
              src={image.url}
              alt={`광고안 ${index + 1} 대표 이미지`}
              loading="lazy"
              decoding="async"
              width={56}
              height={56}
            />
          )}
        </div>
        {hypothesis.claimCitations.length > 0 && (
          <ul className="ad-cites" aria-label="제품 근거">
            {hypothesis.claimCitations.slice(0, 2).map((citation) => (
              <li key={`${citation.sourceId}-${citation.quote}`}>
                “{truncate(citation.quote, 60)}”
              </li>
            ))}
          </ul>
        )}
      </div>
      <Disclosure
        variant="plain"
        summary={
          <>
            <span>자세히 보기</span>
            <span className="ad-status">
              <StatusDot state={variantUiState(variant, job)} />
            </span>
          </>
        }
      >
        <AdDetail job={job} plan={plan} hypothesis={hypothesis} />
      </Disclosure>
    </li>
  );
}

export function AdGrid({ job, plan }: { readonly job: Job; readonly plan: CreativePlan }) {
  return (
    <ul className="ad-grid" aria-label="광고안">
      {plan.hypotheses.map((hypothesis, index) => (
        <AdCard key={hypothesis.id} job={job} plan={plan} hypothesis={hypothesis} index={index} />
      ))}
    </ul>
  );
}
