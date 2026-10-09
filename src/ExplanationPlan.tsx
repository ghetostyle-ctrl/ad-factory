import type { ExplanationPlan as Plan } from "../shared/explanation-plan";
import "./explanation-plan.css";

const representations = {
  product: "실제 제품 외형",
  component: "제품 구성 요소",
  schematic: "설명용 도식",
} as const satisfies Record<Plan["entities"][number]["representation"], string>;

const annotationKinds = {
  label: "이름표",
  pointer: "연결선",
  direction: "방향 화살표",
  measure: "치수 표시",
} as const satisfies Record<Plan["annotations"][number]["kind"], string>;

function plannedRange(start: number, end: number, durationSec?: number): string {
  if (durationSec !== undefined) {
    const seconds = (progress: number) => Number((progress * durationSec).toFixed(1));
    return `클립 내 ${seconds(start)}–${seconds(end)}초 예정`;
  }
  return `장면의 ${Math.round(start * 100)}–${Math.round(end * 100)}% 구간`;
}

export function ExplanationPlan({
  plan,
  durationSec,
}: {
  readonly plan: Plan | null | undefined;
  readonly durationSec?: number;
}) {
  if (!plan) return null;
  const entityName = (id: string) => plan.entities.find((entity) => entity.id === id)?.name ?? id;
  return (
    <details className="evidence-details explanation-plan">
      <summary>설명 동작과 말 맞추기 · {plan.beats.length}단계</summary>
      <div className="stack">
        <p className="muted small-copy">
          {durationSec !== undefined &&
            "대상·설명선·이름표를 INFO 이미지에 먼저 구성한 뒤 움직임을 만듭니다. "}
          제작 전 계획입니다. 생성된 영상의 모습과 움직임은 제작 후 확인해야 합니다.
        </p>
        <p>
          <strong>유지할 제품 형태:</strong> {plan.productForm}
        </p>
        <div className="stack-tight">
          <strong>화면에 등장하는 대상</strong>
          <ul className="evidence-list">
            {plan.entities.map((entity) => (
              <li key={entity.id}>
                <strong>{entity.name}</strong> · {representations[entity.representation]}
                <p>{entity.appearance}</p>
              </li>
            ))}
          </ul>
        </div>
        <ol className="explanation-beats">
          {plan.beats.map((beat, index) => (
            <li className="source-citation stack-tight" key={beat.id}>
              <div className="stack-tight">
                <strong>
                  {index + 1}단계 · {beat.targetIds.map(entityName).join(" · ")}
                </strong>
                <span className="muted small-copy">
                  {plannedRange(beat.startProgress, beat.endProgress, durationSec)}
                </span>
              </div>
              <p>
                <strong>동작 전:</strong> {beat.before}
              </p>
              <p>
                <strong>보여 줄 움직임:</strong> {beat.action}
              </p>
              <p>
                <strong>동작 후:</strong> {beat.after}
              </p>
              <p>
                <strong>이때 할 말:</strong> {beat.narrationCue}
              </p>
              <p>
                <strong>시청자가 이해할 내용:</strong> {beat.viewerTakeaway}
              </p>
              {plan.annotations.some((item) => item.beatId === beat.id) && (
                <ul className="script-cuts" aria-label={`${index + 1}단계 설명 표시 계획`}>
                  {plan.annotations
                    .filter((item) => item.beatId === beat.id)
                    .map((annotation) => (
                      <li
                        key={`${annotation.targetId}-${annotation.kind}-${annotation.label}-${annotation.motionIntent}`}
                      >
                        <strong>
                          {annotationKinds[annotation.kind]} · {annotation.label}
                        </strong>
                        <span>가리킬 대상: {entityName(annotation.targetId)}</span>
                        <span>{annotation.motionIntent}</span>
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
