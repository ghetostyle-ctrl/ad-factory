import {
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  Hand,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import type { ButtonHTMLAttributes, CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cloneElement, isValidElement, useId, useLayoutEffect, useRef } from "react";
import type { AgentState } from "../shared/schema";
import { agentUiState, type UiState } from "../shared/ui-state";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  readonly size?: "md" | "sm" | "icon";
  readonly pending?: boolean;
};
const buttonSizes = { md: "", sm: "button-sm", icon: "button-icon" } as const;
export function Button({
  variant = "secondary",
  size = "md",
  pending = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || pending}
      aria-busy={pending}
      className={`button button-${variant} ${buttonSizes[size]} ${className}`}
    >
      {pending && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
// 상태 배지: 라벨·계열은 shared/ui-state 의 상태 어휘를 그대로 쓴다(화면에서 새 상태 문구를 만들지 않는다).
const statusIcons = {
  idle: Circle,
  queued: Circle,
  running: LoaderCircle,
  blocked: CirclePause,
  review: CirclePause,
  completed: CircleCheck,
  cancelled: CirclePause,
  failed: CircleX,
} as const satisfies Record<AgentState["status"], unknown>;
const badgeTones = {
  progress: "accent",
  yourTurn: "warning",
  done: "success",
  idle: "neutral",
} as const;
export function StatusBadge({ status }: { readonly status: AgentState["status"] }) {
  const ui = agentUiState(status);
  const Icon = statusIcons[status];
  const tone =
    ui.family === "stopped" ? (status === "failed" ? "danger" : "neutral") : badgeTones[ui.family];
  return (
    <span className={`badge badge-${tone}`}>
      <Icon size={12} aria-hidden="true" className={status === "running" ? "spin" : ""} />
      {ui.label}
    </span>
  );
}
// 상태 라벨 한 줄: 점 + 글자. '당신 차례'는 손 아이콘 + 굵은 글자(색만으로 구분하지 않는다).
// hideLabel 은 좁은 목록(사이드바)용 점 하나 — 글자는 화면낭독기에만 읽힌다.
export function StatusDot({
  state,
  size = 12,
  hideLabel = false,
}: {
  readonly state: UiState;
  readonly size?: 12 | 14;
  readonly hideLabel?: boolean;
}) {
  const hand = state.family === "yourTurn" && !hideLabel;
  return (
    <span className={`status-dot status-${state.family} size-${size}`}>
      {hand ? (
        <Hand size={14} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <i className="status-mark" aria-hidden="true" />
      )}
      <span className={hideLabel ? "sr-only" : undefined}>{state.label}</span>
    </span>
  );
}
// 메타데이터 칩(24px). href 가 있으면 새 창으로 여는 링크가 된다.
export function Tag({ children, href }: { readonly children: ReactNode; readonly href?: string }) {
  if (href)
    return (
      <a className="tag" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  return <span className="tag">{children}</span>;
}
// 영상 편수 진행바: 완성(success) → 당신 차례(warning) → 대기(sunken) 순으로 칸을 채운다.
export function ProgressSegments({
  total,
  done,
  yourTurn,
  height = 6,
  label,
}: {
  readonly total: number;
  readonly done: number;
  readonly yourTurn: number;
  readonly height?: 6 | 3;
  readonly label?: string;
}) {
  const cells = Array.from({ length: total }, (_, index) =>
    index < done ? "done" : index < done + yourTurn ? "turn" : "idle",
  );
  return (
    <div
      className={`segments segments-${height}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={label ?? `완성 ${done} / ${total}편`}
    >
      {cells.map((cell, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 칸은 길이가 고정된 순서 목록이라 위치가 곧 식별자다.
        <i key={index} className={cell === "idle" ? undefined : cell} />
      ))}
    </div>
  );
}
// 접힘 섹션(네이티브 details): 44px 행 + 쉐브론. plain 은 바깥 틀 없이 행만 둔다(안쪽에 패널이 있을 때).
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  variant = "panel",
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly variant?: "panel" | "plain";
}) {
  return (
    <details className={`disclosure disclosure-${variant}`} open={defaultOpen}>
      <summary>
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
// 둘 이상 중 하나를 고르는 조각 선택(보드/목록 등). 화살표 키로 옮기며 고른다.
// idPrefix 를 주면 각 조각에 `${idPrefix}-${value}` id 가 붙고, panelId 를 주면 aria-controls 로 본문과 이어진다.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  idPrefix,
  panelId,
}: {
  readonly options: readonly { readonly value: T; readonly label: ReactNode }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly idPrefix?: string;
  readonly panelId?: string;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // ←/→ 순환, Home/End 처음·끝 (JobTabs 와 같은 키 규칙)
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % options.length
        : event.key === "ArrowLeft"
          ? (index - 1 + options.length) % options.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = options[target];
    if (!next) return;
    onChange(next.value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll("button");
    buttons?.[target]?.focus();
  };
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-${option.value}` : undefined}
          aria-selected={option.value === value}
          aria-controls={panelId}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
const noticeIcons = { info: Info, error: CircleAlert, warning: TriangleAlert } as const;
export function Notice({
  children,
  tone = "info",
}: {
  readonly children: ReactNode;
  readonly tone?: "info" | "error" | "warning";
}) {
  const NoticeIcon = noticeIcons[tone];
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <NoticeIcon size={16} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
// 입력 한 칸: 라벨(+ 필수 표시) · 입력 · 도움말 · 오류. 입력이 input/select/textarea 하나면 required·aria-invalid·aria-describedby 를 대신 달고,
// 도움말·오류는 이름이 아니라 설명으로 읽히게 한다(입력이 여럿이거나 컴포넌트면 예전처럼 라벨 안에 그대로 둔다).
export function Field({
  label,
  help,
  required = false,
  error,
  children,
}: {
  readonly label: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly error?: string | null | undefined;
  readonly children: ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const control =
    isValidElement<Record<string, unknown>>(children) && typeof children.type === "string"
      ? children
      : null;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Field children contain the native input, select or textarea; wrapping provides the accessible label.
    <label className="field">
      <span className="field-head">
        <span>{label}</span>
        {required && <span className="field-required">필수</span>}
      </span>
      {control
        ? cloneElement(control, {
            ...(required ? { required: true } : {}),
            ...(error ? { "aria-invalid": true } : {}),
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
          })
        : children}
      {help && (
        <small id={helpId} className="muted" aria-hidden={control ? true : undefined}>
          {help}
        </small>
      )}
      {error && (
        <small id={errorId} className="field-error" aria-hidden={control ? true : undefined}>
          {error}
        </small>
      )}
    </label>
  );
}
// 불러오는 중 자리 표시: 실제 모양과 비슷한 회색 막대. 로딩 안내는 Notice 대신 이것으로 그린다.
export function Skeleton({
  width,
  height = 16,
  radius,
  className = "",
}: {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly radius?: number | string;
  readonly className?: string;
}) {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}
type DialogProps = {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly wide?: boolean;
  readonly closeDisabled?: boolean;
};
export function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
  closeDisabled = false,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const labelId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      const ownedFocus =
        dialog?.contains(document.activeElement) || document.activeElement === document.body;
      dialog?.close();
      if (
        ownedFocus &&
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        !document.querySelector("dialog[open]")
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  const close = () => {
    if (closeDisabled) return;
    ref.current?.close();
    onClose();
  };
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog-wide" : ""}`}
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-header">
        <div>
          <h2 id={labelId}>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="닫기"
          onClick={close}
          disabled={closeDisabled}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
