import type { StoredVideoScriptReview } from "../shared/render-state";
import { scriptNeedsFixBanner } from "../shared/script-approval";
import { Notice } from "./primitives";

type Props = {
  readonly review: StoredVideoScriptReview | null;
  readonly hardProblems: readonly string[];
  readonly warnings: readonly string[];
  readonly needsFix: boolean;
  readonly dirty: boolean;
  readonly approvalComplete: boolean;
};

export function ScriptDiagnostics({
  review,
  hardProblems,
  warnings,
  needsFix,
  dirty,
  approvalComplete,
}: Props) {
  const repairs = review?.repairs ?? [];
  return (
    <>
      {((needsFix && !approvalComplete) || hardProblems.length > 0) && (
        <Notice tone={hardProblems.length > 0 ? "error" : "info"}>
          <p className="script-review-title">
            {hardProblems.length > 0
              ? scriptNeedsFixBanner
              : dirty
                ? "수정한 내용을 저장한 뒤 승인해 주세요."
                : "필수 수정 사항을 해결했습니다."}
            {needsFix && review && ` (생성 ${review.generations}회)`}
          </p>
          {hardProblems.length > 0 ? (
            <>
              <ul className="script-rules">
                {hardProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
              <p>
                문장·자막에서 고칠 수 없는 컷 구성 문제는 아래 다시 쓰기에 수정 요청을 적어 주세요.
              </p>
            </>
          ) : (
            <p>
              {dirty
                ? "수정한 대본을 먼저 저장한 뒤 승인해 주세요."
                : "남은 규칙 위반이 없습니다. 내용을 확인한 뒤 승인할 수 있습니다."}
            </p>
          )}
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice tone="warning">
          <details className="script-warnings">
            <summary>확인할 품질·리듬 경고 {warnings.length}건</summary>
            <ul className="script-rules">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </Notice>
      )}
      {repairs.length > 0 && (
        <details className="evidence-details script-repairs">
          <summary>자동 조정 기록 {repairs.length}건</summary>
          <ul className="script-rules">
            {repairs.map((repair) => (
              <li key={repair}>{repair}</li>
            ))}
          </ul>
        </details>
      )}
      {review && review.accepted !== "needsFix" && (
        <div className={`script-review script-review-${review.status}`}>
          <p className="script-review-title">
            AI 검토 {review.attempt}회차 · {review.status === "pass" ? "통과" : "수정 권고"}
            {dirty && " · 수정 전 대본 기준"}
            {review.accepted === "forced" &&
              " · 생성 3회 뒤에도 수정 권고가 남아 사용자 승인이 필요합니다"}
          </p>
          <p>{review.summary}</p>
          {review.issues.length > 0 && (
            <ul className="script-review-issues">
              {review.issues.map((issue) => (
                <li key={`${issue.sentenceIndex ?? "all"}-${issue.problem}`}>
                  <strong>
                    {issue.sentenceIndex === null ? "전체" : `${issue.sentenceIndex + 1}번째 문장`}
                    {issue.cutIndexes.length > 0 && ` · 컷 ${issue.cutIndexes.join(", ")}`}
                  </strong>{" "}
                  {issue.problem} → {issue.fix}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
