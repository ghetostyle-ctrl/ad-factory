import type { AutomationState } from "../shared/automation";
import type { Job } from "../shared/schema";
import { moneyLabel } from "./api";
import { Notice } from "./primitives";

const phases = {
  strategy: "광고 전략 수립",
  creative: "카피·이미지 기획",
  script: "영상 대본·컷 설계",
  image: "이미지 생성",
  video: "Veo 영상 생성",
  voice: "내레이션 합성",
  stills: "정지 이미지 생성",
  startImages: "시작 이미지 생성",
  clips: "Veo 클립 생성",
  graphics: "모션그래픽 렌더",
  assemble: "최종 조립",
  review: "이미지·카피 검토",
  stage: "Meta 광고 준비",
  activate: "광고 활성화",
  insights: "실제 성과 조회",
  report: "AI 성과 분석",
  finished: "운영 종료",
} as const satisfies Record<AutomationState["phase"], string>;
export const operationDate = (value: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "예약 없음";
function nextAction(automation: AutomationState): string {
  switch (automation.status) {
    case "blocked":
      return "연결 설정을 완료하면 안전한 작업을 이어갑니다.";
    case "attention":
      return automation.policy.mode === "creative"
        ? automation.videoOperation
          ? "기록된 Veo 작업을 재확인할 수 있습니다. 새 영상 생성 요청은 보내지 않습니다."
          : "외부 요청 결과가 불확실합니다. 실행 기록을 확인하고 새 작업을 만들기 전에 공급자 사용량을 확인하세요."
        : "처리 결과를 확인해야 합니다. 실행 기록과 Meta 상태를 확인하세요.";
    case "stopped":
      return automation.policy.mode === "creative"
        ? "소재 자동 제작이 중지되었습니다."
        : "자동 실행이 중지되었습니다. 광고 상태는 아래에서 확인하세요.";
    case "completed":
      return automation.policy.mode === "creative"
        ? "영상 대본·컷 설계, 이미지 검토, 내레이션·Veo 클립·모션그래픽 조립까지 마쳤습니다. 완성 영상은 대본 카드에서 확인하세요."
        : automation.policy.mode === "prepare"
          ? "광고 준비를 마쳤습니다."
          : "운영이 종료되었습니다.";
    case "waiting":
      return automation.policy.mode !== "creative"
        ? "예약 시각에 실제 성과를 조회하고 AI가 분석합니다."
        : automation.phase === "script"
          ? "영상 대본을 대본 카드에서 확인·수정하고 승인하면 이미지 제작·검토부터 자동으로 이어서 제작합니다. 실패가 아니라 사용자 확인을 기다리는 중입니다."
          : "Google Flow에서 만든 클립을 대본 카드에서 업로드하면 자동으로 이어서 제작합니다. 실패가 아니라 사용자 작업을 기다리는 중입니다.";
    case "queued":
      return `다음 단계: ${phases[automation.phase]}`;
    case "running":
      return `현재 단계: ${phases[automation.phase]}`;
  }
}
export function AutomationStatus({
  job,
  automation,
}: {
  readonly job: Job;
  readonly automation: AutomationState;
}) {
  return (
    <>
      <div className="operation-current">
        <span className="eyebrow">현재 단계</span>
        <h3>{phases[automation.phase]}</h3>
        <p>{nextAction(automation)}</p>
      </div>
      {automation.lastError && <Notice tone="warning">{automation.lastError}</Notice>}
      <dl className="definition-list operation-definition">
        <div>
          <dt>실행 범위</dt>
          <dd>
            {automation.policy.mode === "creative"
              ? `소재 기획·이미지 ${automation.policy.imageCount ?? (job.sourceSnapshot ? 3 : 1)}개·완성 영상 ${automation.policy.videoCount ?? 0}개(30~60초·Veo 클립 최대 4개·정지 이미지 최대 14장·내레이션·자막·BGM)`
              : automation.policy.mode === "activate"
                ? "자동 게시와 정기 분석"
                : "광고 준비까지만"}
          </dd>
        </div>
        <div>
          <dt>다음 작업 시각</dt>
          <dd>{operationDate(automation.nextRunAt)}</dd>
        </div>
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
      {job.result && automation.status === "stopped" && <Notice>{job.result}</Notice>}
    </>
  );
}
