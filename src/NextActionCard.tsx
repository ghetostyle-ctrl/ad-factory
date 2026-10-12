import { useId } from "react";
import type { NextAction, NextActionCommand } from "../shared/next-action";
import type { UiFamily } from "../shared/ui-state";
import { Button, StatusDot } from "./primitives";

// nextAction 의 명령에 화면 쪽 보강 하나를 더한다: Flow 이미지 대기는 영상 번호가 아니라 이 화면의 이미지 패널이 행동 면이다(docs 8-1절 b).
export type CardCommand = NextActionCommand | { readonly type: "openImages" };
export type CardButton = {
  readonly label: string;
  readonly command: CardCommand;
};
export type CardAction = Omit<NextAction, "primary" | "secondary"> & {
  readonly primary: CardButton | null;
  readonly secondary: CardButton | null;
};

// 카드 머리 라벨의 계열·문구는 작업 상태(jobUiState)가 만든 값을 그대로 쓴다. 이 컴포넌트는 새 상태 문구를 만들지 않는다.
export function NextActionCard({
  action,
  family,
  head,
  pending,
  disabledPrimary,
  onCommand,
}: {
  readonly action: CardAction;
  readonly family: UiFamily;
  readonly head: string;
  readonly pending: CardCommand["type"] | null;
  readonly disabledPrimary: boolean;
  readonly onCommand: (command: CardCommand) => void;
}) {
  const titleId = useId();
  const yourTurn = action.kind === "yourTurn";
  const render = (button: CardButton | null, variant: "primary" | "secondary") =>
    button && (
      <Button
        variant={variant}
        pending={pending === button.command.type}
        disabled={variant === "primary" && disabledPrimary}
        onClick={() => onCommand(button.command)}
      >
        {button.label}
      </Button>
    );
  return (
    <section
      className={`next-card ${yourTurn ? "is-turn" : ""} kind-${action.kind}`}
      aria-labelledby={titleId}
    >
      <div className="next-main">
        <div className="next-label">
          <StatusDot state={{ family, label: head, detail: "" }} />
          {action.reason && <span className="next-reason">· 멈춘 이유: {action.reason}</span>}
        </div>
        <h3 id={titleId}>{action.title}</h3>
        {action.detail && <p>{action.detail}</p>}
        {action.facts.length > 0 && (
          <dl className="next-facts">
            {action.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>
                  <b>{fact.value}</b>
                  {fact.unit && <small>{fact.unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {(action.primary || action.secondary) && (
        <div className="next-actions">
          {render(action.primary, "primary")}
          {render(action.secondary, "secondary")}
        </div>
      )}
    </section>
  );
}
