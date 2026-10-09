import type { VideoPlanning as Planning } from "../shared/video-planning";
import { ExplanationPlan } from "./ExplanationPlan";

const awarenessLabels = {
  unaware: "문제를 아직 뚜렷하게 느끼지 않음",
  problem_aware: "문제를 느끼고 있음",
  solution_aware: "해결 방법을 비교하고 있음",
  product_aware: "이 제품을 알고 있음",
  ready_to_decide: "구매를 결정하려 함",
} as const satisfies Record<Planning["audience"]["awareness"], string>;

const reviewLabels = {
  pass: "수정 없이 검토",
  revised: "문장 수정 기록",
} as const satisfies Record<Planning["copyReview"]["status"], string>;

const copyFieldLabels = {
  narration: "내레이션",
  screenText: "화면 문구",
} as const satisfies Record<Planning["copyReview"]["edits"][number]["field"], string>;

const sceneSourceLabels = {
  project_asset: "실제 촬영본",
  generated: "AI 생성",
  graphic: "그래픽",
  info_clip: "3D 설명 영상",
} as const satisfies Record<
  NonNullable<Planning["concept"]["scenePlan"]>[number]["source"],
  string
>;

export function VideoPlanning({ planning }: { readonly planning: Planning }) {
  const { audience, concept, copyReview } = planning;
  const audienceDetails = [
    ["관심을 갖게 된 계기", audience.trigger],
    ["지금 쓰는 방법", audience.currentApproach],
    ["겪는 불편", audience.friction],
    ["마음에 걸리는 점", audience.concern],
    ["원하는 변화", audience.desiredChange],
    ["구매를 망설이는 이유", audience.purchaseBarrier],
    ["결정에 필요한 근거", audience.proofNeeded],
  ] as const;
  return (
    <section className="stack script-panel" aria-label="제작 전 기획과 문장 검토 이력">
      <div className="stack-tight">
        <h4>제작 전 기획</h4>
        <p>
          <strong>영상 콘셉트:</strong> {concept.idea}
        </p>
        <p>
          <strong>시청자:</strong> {audience.viewer}
        </p>
        <p>
          <strong>지금 처한 상황:</strong> {audience.situation}
        </p>
        {concept.viewerChange ? (
          <p>
            <strong>시청자가 얻는 변화:</strong> {concept.viewerChange}
          </p>
        ) : null}
        {concept.mutedMessage ? (
          <p>
            <strong>소리 없이 전달할 한 줄:</strong> {concept.mutedMessage}
          </p>
        ) : null}
        {concept.stopReason ? (
          <p>
            <strong>첫 2초에 멈출 이유:</strong> {concept.stopReason}
          </p>
        ) : null}
      </div>
      {concept.scenePlan && concept.scenePlan.length > 0 ? (
        <details className="evidence-details">
          <summary>장면별 화면 소스 계획 · {concept.scenePlan.length}장면</summary>
          <ol className="evidence-list stack-tight">
            {concept.scenePlan.map((item) => (
              <li key={`${item.source}-${item.scene}-${item.reason}`}>
                <strong>{sceneSourceLabels[item.source]}</strong> · {item.scene}
                <p className="small-copy">{item.reason}</p>
                <ExplanationPlan plan={item.explanation} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <details className="evidence-details">
        <summary>고객 상황 · 구매 망설임 · 근거 확인</summary>
        <div className="stack">
          <div className="stack-tight">
            <p>
              <strong>인식 단계:</strong> {awarenessLabels[audience.awareness]}
            </p>
            {audienceDetails.map(([label, value]) => (
              <p key={label}>
                <strong>{label}:</strong> {value}
              </p>
            ))}
          </div>
          <div className="stack-tight">
            <p>
              <strong>자료에서 확인한 근거</strong>
            </p>
            {audience.evidence.length > 0 ? (
              <ul className="evidence-list">
                {audience.evidence.map((evidence) => (
                  <li key={`${evidence.sourceId}-${evidence.observation}`}>
                    {evidence.observation}
                    <p className="small-copy">자료 ID: {evidence.sourceId}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">이 기획에 기록된 자료 근거가 없습니다.</p>
            )}
          </div>
          <div className="stack-tight">
            <p>
              <strong>기획에서 세운 가정</strong>
            </p>
            {audience.assumptions.length > 0 ? (
              <ul className="evidence-list">
                {audience.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">이 기획에 기록된 가정이 없습니다.</p>
            )}
          </div>
          <div className="stack-tight">
            <p>
              <strong>아직 확인하지 못한 정보</strong>
            </p>
            {audience.unknowns.length > 0 ? (
              <ul className="evidence-list">
                {audience.unknowns.map((unknown) => (
                  <li key={unknown}>{unknown}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">이 기획에 기록된 미확인 정보가 없습니다.</p>
            )}
          </div>
        </div>
      </details>
      <details className="evidence-details">
        <summary>영상의 질문 · 장면 전개 · 행동 유도</summary>
        <div className="stack-tight">
          <p>
            <strong>시청자가 품는 질문:</strong> {concept.viewerQuestion}
          </p>
          <p>
            <strong>첫 장면:</strong> {concept.openingScene}
          </p>
          <p>
            <strong>이야기 전개</strong>
          </p>
          <ol className="evidence-list">
            {concept.development.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>
            <strong>질문에 대한 답:</strong> {concept.payoff}
          </p>
          <p>
            <strong>근거를 보여 줄 장면:</strong> {concept.proofScene}
          </p>
          <p>
            <strong>유도할 행동:</strong> {concept.ctaIntent}
          </p>
          <p>
            <strong>레퍼런스 활용:</strong> {concept.referenceNotes}
          </p>
        </div>
      </details>
      <details className="evidence-details">
        <summary>
          문장 검토 이력 · {reviewLabels[copyReview.status]} · {copyReview.edits.length}건
        </summary>
        <div className="stack">
          <p>{copyReview.summary}</p>
          {copyReview.edits.length > 0 ? (
            <ol className="evidence-list stack">
              {copyReview.edits.map((edit) => (
                <li key={`${edit.lineIndex}-${edit.field}-${edit.before}-${edit.after}`}>
                  <div className="stack-tight">
                    <p>
                      <strong>
                        기획 문장 {edit.lineIndex + 1} · {copyFieldLabels[edit.field]}
                      </strong>
                    </p>
                    <p>
                      <strong>검토 전:</strong> {edit.before || "(문구 없음)"}
                    </p>
                    <p>
                      <strong>수정 이유:</strong> {edit.reason}
                    </p>
                    <p>
                      <strong>다듬은 문장:</strong> {edit.after || "(문구 삭제)"}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">이 검토에서 기록된 문장 수정은 없습니다.</p>
          )}
        </div>
      </details>
      <p className="muted small-copy">
        기획과 문장 검토는 생성 당시의 기록입니다. 이후 직접 수정한 대본과 다를 수 있으며, 최종 대본
        승인을 뜻하지 않습니다.
      </p>
    </section>
  );
}
