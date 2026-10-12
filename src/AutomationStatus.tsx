import type { AutomationState } from "../shared/automation";
import type { Job } from "../shared/schema";
import { pendingScriptDraft } from "../shared/script-drafts";
import { PHASE_LABELS } from "../shared/ui-state";
import { moneyLabel } from "./api";

export const operationDate = (value: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "예약 없음";

// 서버가 만든 구성 경고 문장을 화면에서만 사용자 말로 바꾼다(원문·서버 데이터는 그대로).
const ISSUE_TEXT: readonly (readonly [RegExp, string])[] = [
  [
    /구매 결정\(BOFU\) 광고가 세트에 없습니다\.?/u,
    "구매 직전 단계 광고가 없어요 — 그대로 진행해도 되고, 다시 기획하면 하나 추가합니다.",
  ],
  [/\bTOFU\b/gu, "처음 알리기"],
  [/\bMOFU\b/gu, "비교 중"],
  [/\bBOFU\b/gu, "구매 직전"],
];
export function planIssueText(issue: string): string {
  return ISSUE_TEXT.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    issue,
  );
}

// 대본 형식 문제로 보관된 초안: 오류·응답 원문을 받아 보고 고치거나 다시 쓸 수 있다. 사용자가 움직일 일이라 카드 아래 패널로 둔다.
export function ScriptDraftPanel({ job }: { readonly job: Job }) {
  const draft = pendingScriptDraft(job);
  if (!draft) return null;
  return (
    <section className="plan-choice stack" aria-label="대본 초안 수정">
      <h3>영상 {draft.number} 대본 초안 수정 대기</h3>
      {job.result && <p className="muted">{job.result}</p>}
      <div className="cluster operation-actions">
        {draft.response && (
          <a className="button button-secondary" href={draft.response.url} download>
            응답 원문 받기
          </a>
        )}
        {draft.previous && (
          <a className="button button-secondary" href={draft.previous.url} download>
            이전 대본 초안 받기
          </a>
        )}
        <a className="button button-secondary" href={draft.issue.url} download>
          오류 상세 받기
        </a>
      </div>
      <p className="muted">
        이어서 진행하면 오류 내용을 전달해 대본을 다시 작성하며 기존 설정의 API 비용이 발생합니다.
      </p>
    </section>
  );
}

// 고급 · 자동 운영 상세: 실행 범위와 예약 시각. 긴 안내문은 지금 할 일 카드가 맡고 여기에는 쓰지 않는다.
export function AutomationStatus({
  job,
  automation,
}: {
  readonly job: Job;
  readonly automation: AutomationState;
}) {
  return (
    <dl className="definition-list operation-definition">
      <div>
        <dt>현재 단계</dt>
        <dd>{PHASE_LABELS[automation.phase]}</dd>
      </div>
      <div>
        <dt>실행 범위</dt>
        <dd>
          {automation.policy.mode === "creative"
            ? `광고안·이미지 ${automation.policy.imageCount ?? (job.sourceSnapshot ? 3 : 1)}개·완성 영상 ${automation.policy.videoCount ?? 0}개(30~60초·클립 최대 4개·정지 이미지 최대 14장·내레이션·자막·BGM)`
            : automation.policy.mode === "activate"
              ? "자동 게시와 정기 분석"
              : "광고 준비까지만"}
        </dd>
      </div>
      {automation.nextRunAt && (
        <div>
          <dt>다음 작업 시각</dt>
          <dd>{operationDate(automation.nextRunAt)}</dd>
        </div>
      )}
      {automation.policy.mode !== "creative" && (
        <>
          <div>
            <dt>다음 성과 분석</dt>
            <dd>{operationDate(automation.nextAnalysisAt)}</dd>
          </div>
          <div>
            <dt>총 광고비 한도</dt>
            <dd>{moneyLabel(automation.policy.maxTotalSpend, job.currency)}</dd>
          </div>
          <div>
            <dt>운영 종료 시각</dt>
            <dd>{operationDate(automation.policy.endAt)}</dd>
          </div>
          <div>
            <dt>Meta 광고 상태</dt>
            <dd>
              {job.staged
                ? (job.staged.deliveryStatus ?? "게재 상태 미확인")
                : "아직 준비되지 않음"}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}
