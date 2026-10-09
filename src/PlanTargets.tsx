import {
  CHAIN_STEP_KEYS,
  type CreativePlan,
  type MarketFragment,
  type PersuasionChain,
  type SolutionPath,
  targetFitScore,
} from "../shared/creative-plan";

const experiences = {
  tried_failed: "해 봤는데 실패한 경험이 있음 · 원인 재해석",
  first_time: "처음 알아보는 중 · 기준 먼저 알려 주기",
} as const;
const origins = {
  customer_review: "고객 후기",
  reference_ad: "광고 레퍼런스 문구",
  reference_video: "레퍼런스 영상",
  inferred: "추정 · 근거 없음",
} as const satisfies Record<MarketFragment["origin"], string>;
export const entryPoints = {
  pain: "불편함 먼저 (문제 공감)",
  alternative: "지금 쓰는 방법과 비교",
  doubt: "의심 먼저 (품질 증명)",
  price: "가격·가치 먼저",
  desire: "원하는 모습 먼저",
} as const;
const stages = {
  past_attempt: "해 봤던 것",
  believed_cause: "고객이 생각한 이유",
  real_cause: "진짜 원인",
  criteria: "봐야 할 기준",
  mechanism: "우리 상품이 푸는 방식",
  verification: "직접 확인하는 방법",
  outcome: "얻게 되는 모습",
} as const satisfies Record<SolutionPath["steps"][number]["stage"], string>;
const bases = {
  product_fact: "제품 사실",
  customer_voice: "고객 후기",
  reference: "레퍼런스",
  general_knowledge: "일반 정보",
  inferred: "추정",
} as const satisfies Record<SolutionPath["steps"][number]["basis"], string>;

function FragmentLine({ fragment }: { readonly fragment: MarketFragment }) {
  const parts = [
    ["상황", fragment.situation],
    ["원하는 것", fragment.desire],
    ["불편", fragment.pain],
    ["지금 방법", fragment.alternative],
    ["실패 경험", fragment.failedAttempt],
    ["고객이 생각한 이유", fragment.believedCause],
    ["망설임", fragment.hesitation],
  ] as const;
  return (
    <li>
      <div className="stack-tight">
        {parts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <p key={label}>
              <strong>{label}:</strong> {value}
            </p>
          ))}
        {fragment.quote ? <p className="small-copy">“{fragment.quote}”</p> : null}
        <p className="muted small-copy">{origins[fragment.origin]}</p>
      </div>
    </li>
  );
}

/** 리뷰·레퍼런스에서 뽑은 장면 조각과 그것을 묶은 타겟. 예전 기획(타겟 없음)에는 표시하지 않는다. */
export function PlanTargetsSection({ plan }: { readonly plan: CreativePlan }) {
  const targets = plan.targets ?? [];
  const fragments = plan.fragments ?? [];
  if (targets.length === 0) return null;
  return (
    <details className="evidence-details" open>
      <summary>
        타겟 {targets.length}명 · 시장에서 뽑은 장면 조각 {fragments.length}개
      </summary>
      <div className="stack">
        {targets.map((target) => {
          const used = plan.hypotheses
            .map((item, index) => (item.targetId === target.id ? index + 1 : 0))
            .filter(Boolean);
          return (
            <section className="stack hypothesis-card" key={target.id}>
              <span className="eyebrow">{experiences[target.experience]}</span>
              <h3>{target.label}</h3>
              {target.fit && (
                <p className="muted small-copy">
                  타겟 점수 {targetFitScore(target.fit)} (고통 {target.fit.painStrength} × 우리
                  상품의 답 {target.fit.productAnswer} × 차이 {target.fit.distinctness}) ·{" "}
                  {target.fit.reason}
                </p>
              )}
              <p className="muted small-copy">
                이 타겟을 쓰는 광고안: {used.length ? used.map((n) => `${n}번`).join(", ") : "없음"}
              </p>
              <ul className="evidence-list stack">
                {fragments
                  .filter((fragment) => target.fragmentIds.includes(fragment.id))
                  .map((fragment) => (
                    <FragmentLine fragment={fragment} key={fragment.id} />
                  ))}
              </ul>
            </section>
          );
        })}
      </div>
    </details>
  );
}

// 설득 사슬(2026-10-06): 고통 → 믿는 원인 → 진짜 원인 → 해결 조건 → 우리 상품의 사실 → 가능한 이유 → 결과·변화.
const chainLabels = {
  pain: "① 고통",
  believedCause: "② 고객이 믿는 원인",
  realCause: "③ 진짜 원인",
  requirement: "④ 해결 조건",
  productFact: "⑤ 우리 상품의 사실",
  reasonWhy: "⑥ 가능한 이유",
  outcome: "결과·변화",
} as const satisfies Record<(typeof CHAIN_STEP_KEYS)[number], string>;
export function ChainView({ chain }: { readonly chain: PersuasionChain }) {
  return (
    <ol className="evidence-list stack-tight">
      {CHAIN_STEP_KEYS.map((key) => {
        const step = chain[key];
        if (!step.content) return null;
        return (
          <li key={key}>
            <strong>{chainLabels[key]}</strong> · {step.content}
            <span className="muted small-copy"> ({bases[step.basis]})</span>
          </li>
        );
      })}
      <li>
        <strong>이 해결은 우리 상품이어야만 하는가</strong> ·{" "}
        {chain.exclusivity === "product_specific" ? "예 (제품 사실에 닿음)" : "아니오 — 사슬 실패"}
      </li>
    </ol>
  );
}
export function SolutionPathView({ path }: { readonly path: SolutionPath }) {
  return (
    <ol className="evidence-list stack-tight">
      {path.steps.map((step) => (
        <li key={`${step.stage}-${step.content}`}>
          <strong>{stages[step.stage]}</strong> · {step.content}
          <span className="muted small-copy"> ({bases[step.basis]})</span>
        </li>
      ))}
    </ol>
  );
}
