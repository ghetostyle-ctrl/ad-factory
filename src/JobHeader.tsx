import { Ellipsis, ExternalLink, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { clipModeOf, suggestedFlowModel } from "../shared/flow-mode";
import { jobProgress } from "../shared/next-action";
import type { Job } from "../shared/schema";
import { scriptApprovalMode } from "../shared/script-approval";
import { jobUiState } from "../shared/ui-state";
import { ProgressSegments, StatusDot, Tag } from "./primitives";

const TEXT_PROVIDER_LABELS = {
  openai: "OpenAI",
  codex: "Codex",
  claudeCode: "Claude Code",
} as const;

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}초` : `${Math.floor(whole / 60)}분 ${whole % 60}초`;
}
const startedLabel = (value: string) => {
  const date = new Date(value);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 시작`;
};

type MenuItem = {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};
// 작업 ⋯ 메뉴: 수정·삭제·자동 운영 초기화. 바깥 클릭·Esc 로 닫고, ↑↓ 로 항목을 옮긴다.
function JobMenu({ items }: { readonly items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const entries = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ??
        []),
    ];
    const index =
      document.activeElement instanceof HTMLButtonElement
        ? entries.indexOf(document.activeElement)
        : -1;
    const step = event.key === "ArrowDown" ? 1 : -1;
    entries[(index + step + entries.length) % entries.length]?.focus();
  };
  return (
    <div className="job-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="button button-ghost button-icon"
        aria-label="작업 메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label="작업 메뉴" onKeyDown={move}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`menu-item ${item.danger ? "is-danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function JobHeader({
  job,
  resetPending,
  onEdit,
  onDelete,
  onReset,
}: {
  readonly job: Job;
  readonly resetPending: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onReset: () => void;
}) {
  const progress = jobProgress(job);
  const policy = job.automation?.policy;
  const creative = policy?.mode === "creative" ? policy : null;
  const models = job.executionModels;
  const writer =
    models?.scriptProvider === "anthropic"
      ? "Claude"
      : models && models.textProvider !== "none"
        ? TEXT_PROVIDER_LABELS[models.textProvider]
        : null;
  const videoCount = creative?.videoCount ?? 0;
  const planIssues =
    job.automation?.planChoice?.action === "use" ? job.automation.planChoice.issues : [];
  const canEdit = !job.staged && !job.automation && job.status !== "running";
  const canReset = job.automation?.status === "stopped" || job.automation?.status === "blocked";
  const items: MenuItem[] = [
    ...(canEdit
      ? [
          {
            key: "edit",
            label: "수정",
            icon: <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />,
            onSelect: onEdit,
          },
        ]
      : []),
    ...(canReset
      ? [
          {
            key: "reset",
            label: "초기화 후 새로 시작",
            icon: <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />,
            disabled: resetPending,
            onSelect: onReset,
          },
        ]
      : []),
    {
      key: "delete",
      label: "작업 삭제",
      icon: <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />,
      danger: true,
      onSelect: onDelete,
    },
  ];
  return (
    <header className="job-header">
      <div className="job-title">
        <div className="eyebrow">
          {job.sourceSnapshot ? `${job.sourceSnapshot.projectName} · ` : ""}
          {startedLabel(job.createdAt)}
        </div>
        <h1>{job.name}</h1>
        <div className="tag-row">
          {creative && (
            <>
              <Tag>
                이미지 <b>{creative.imageCount ?? (job.sourceSnapshot ? 3 : 1)}</b>
              </Tag>
              <Tag>
                영상 <b>{videoCount}</b>
              </Tag>
              {videoCount > 0 && (
                <Tag>
                  클립{" "}
                  <b>
                    {clipModeOf(job) === "flow"
                      ? `Google Flow · ${suggestedFlowModel(creative.videoModel).replace(" - ", " ")}`
                      : "자동(API)"}
                  </b>
                </Tag>
              )}
            </>
          )}
          {writer && (
            <Tag>
              글쓰기 <b>{writer}</b>
            </Tag>
          )}
          {videoCount > 0 && (
            <Tag>
              대본 <b>{scriptApprovalMode(job) === "auto" ? "자동" : "승인 후 제작"}</b>
            </Tag>
          )}
          {planIssues.length > 0 && (
            <span title={planIssues.join(" ")}>
              <Tag>
                구성 경고 <b>확인함</b>
              </Tag>
            </span>
          )}
          {job.productUrl && (
            <Tag href={job.productUrl}>
              <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
              제품 페이지
            </Tag>
          )}
        </div>
      </div>
      <div className="job-side">
        {progress.total > 0 ? (
          <div className="job-progress">
            <div className="progress-line">
              <b>{progress.done}</b>
              <span>
                / {progress.total}편 완성
                {progress.totalSec !== null && ` · ${formatDuration(progress.totalSec)}`}
              </span>
            </div>
            <ProgressSegments
              total={progress.total}
              done={progress.done}
              yourTurn={progress.yourTurn}
            />
            <ul className="progress-legend">
              <li>
                <i className="legend-dot is-done" aria-hidden="true" />
                완성 {progress.done}
              </li>
              {progress.yourTurn > 0 && (
                <li className="is-turn">
                  <i className="legend-dot is-turn" aria-hidden="true" />
                  당신 차례 {progress.yourTurn}
                </li>
              )}
              {progress.waiting > 0 && (
                <li>
                  <i className="legend-dot" aria-hidden="true" />
                  대기 {progress.waiting}
                </li>
              )}
            </ul>
          </div>
        ) : (
          <StatusDot state={jobUiState(job)} size={14} />
        )}
        <JobMenu items={items} />
      </div>
    </header>
  );
}
