import { Check, Hand } from "lucide-react";

// 영상 한 편의 제작 6단 스텝퍼. 상태는 호출한 쪽이 shared 의 규칙으로 계산해 넘기고, 여기서는 모양만 그린다.
// done = 초록 채움 + 체크 · current = 파란 링(지금 도는 단계) · turn = 노란 채움 + 손(당신 차례) · idle = 회색 링
export type StepState = "done" | "current" | "turn" | "idle";
export type StepItem = {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
};

const stateText: Record<StepState, string> = {
  done: "완료",
  current: "진행 중",
  turn: "당신 차례",
  idle: "대기",
};

export function Stepper({
  steps,
  label,
}: {
  readonly steps: readonly StepItem[];
  readonly label: string;
}) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((step) => (
        <li
          key={step.key}
          className={`step step-${step.state}`}
          aria-current={step.state === "current" || step.state === "turn" ? "step" : undefined}
        >
          <span className="step-mark" aria-hidden="true">
            {step.state === "done" ? (
              <Check size={12} strokeWidth={3} />
            ) : step.state === "turn" ? (
              <Hand size={12} strokeWidth={2} />
            ) : null}
          </span>
          <span className="step-label">{step.label}</span>
          <span className="sr-only">{stateText[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}
