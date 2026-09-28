import {
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useId, useLayoutEffect, useRef } from "react";
import type { AgentState } from "../shared/schema";

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
const statuses = {
  idle: { label: "대기", tone: "neutral", icon: Circle },
  queued: { label: "실행 대기", tone: "neutral", icon: Circle },
  running: { label: "작업 중", tone: "accent", icon: LoaderCircle },
  blocked: { label: "입력 필요", tone: "warning", icon: CirclePause },
  review: { label: "검토", tone: "warning", icon: CirclePause },
  completed: { label: "완료", tone: "success", icon: CircleCheck },
  cancelled: { label: "중지됨", tone: "neutral", icon: CirclePause },
  failed: { label: "실패", tone: "danger", icon: CircleX },
} as const;
export function StatusBadge({ status }: { readonly status: AgentState["status"] }) {
  const item = statuses[status];
  const Icon = item.icon;
  return (
    <span className={`badge badge-${item.tone}`}>
      <Icon size={12} aria-hidden="true" className={status === "running" ? "spin" : ""} />
      {item.label}
    </span>
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
export function Field({
  label,
  help,
  children,
}: {
  readonly label: string;
  readonly help?: string;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Field children contain the native input, select or textarea; wrapping provides the accessible label.
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small className="muted">{help}</small>}
    </label>
  );
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
