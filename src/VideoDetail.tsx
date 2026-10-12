import { Copy, Download, Ellipsis, FileText, History, PenLine, RefreshCw } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  clipModeOf,
  flowExportName,
  pendingFlowClips,
  videoScriptFor,
  waitingVideoNumber,
} from "../shared/flow-mode";
import type { Job } from "../shared/schema";
import {
  narrationSynthesized,
  pendingScriptApprovals,
  scriptApproved,
  scriptNeedsApproval,
} from "../shared/script-approval";
import { pendingScriptDraft } from "../shared/script-drafts";
import { agentUiState, stripEnumPrefix } from "../shared/ui-state";
import { isHybrid, type VideoScript } from "../shared/video-script";
import { ScriptDraftPanel } from "./AutomationStatus";
import { api, errorMessage } from "./api";
import { CalloutEditor } from "./CalloutEditor";
import { confirmDialog } from "./confirm-dialog";
import {
  ClipStillGrid,
  finalVoices,
  loudnessOk,
  NarrationDisclosure,
  reportChecks,
  useRenderReport,
} from "./FinalVideo";
import { FlowPanel } from "./FlowPanel";
import { Button, Disclosure, Notice, StatusDot } from "./primitives";
import { ScriptEditor, scriptCanEdit, scriptEditorKey, scriptStatusOf } from "./ScriptEditor";
import { ScriptSources, visualPolicyLabel } from "./ScriptFields";
import { type StepItem, Stepper, type StepState } from "./Stepper";
import { toast } from "./toast-store";
import { videoBoardItems } from "./VideoBoard";
import { VideoPlanning } from "./VideoPlanning";
import "./video-detail.css";

const FLOW_IMAGE_PHASES = new Set(["image", "stills", "startImages"]);
// 스텝 라벨의 "4 / 4" 가 줄바꿈으로 갈라지지 않게 줄바꿈 없는 공백을 쓴다.
const NBSP = "\u00a0";
const seconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}초`;
const count = (names: readonly (string | undefined)[]) => names.filter(Boolean).length;

// 영상 한 편의 6단계 상태. 계산은 shared 의 함수(승인·Flow 대기)가 하고, 여기서는 단계별로 모아 읽기만 한다.
function videoSteps(job: Job, script: VideoScript, number: number): StepItem[] {
  const render = job.renders.find((item) => item.number === number);
  const hasFinal =
    Boolean(render?.final) ||
    job.artifacts.some((asset) => asset.name === `video-final-${number}.mp4`);
  const automation = job.automation;
  const current = automation?.policy.mode === "creative" && waitingVideoNumber(job) === number;
  const phase =
    current && (automation?.status === "running" || automation?.status === "queued")
      ? automation.phase
      : null;
  const waitPhase = current && automation?.status === "waiting" ? automation.phase : null;
  const approved =
    hasFinal ||
    scriptApproved(job, number) ||
    narrationSynthesized(job, number) ||
    !scriptNeedsApproval(job, number);
  const startTotal = script.veoClips.length;
  const stillTotal = script.stills.length;
  const startHave = count(Object.values(render?.startImages ?? {}).map((entry) => entry?.name));
  const stillHave = count(Object.values(render?.stills ?? {}).map((entry) => entry?.name));
  const clipTotal = script.veoClips.length + script.infoClips.length;
  const clipMissing = pendingFlowClips(job, number).length;
  const clipTurn =
    waitPhase !== null &&
    waitPhase !== "script" &&
    !FLOW_IMAGE_PHASES.has(waitPhase) &&
    clipMissing > 0;
  const startDone = startHave >= startTotal && stillHave >= stillTotal;
  const startLabel =
    startTotal + stillTotal === 0
      ? "시작 이미지"
      : `시작 이미지 ${startHave}${NBSP}/${NBSP}${startTotal}${stillTotal > 0 ? ` · 정지 ${stillHave}${NBSP}/${NBSP}${stillTotal}` : ""}`;
  const pick = (done: boolean, turn: boolean, running: boolean): StepState =>
    done ? "done" : turn ? "turn" : running ? "current" : "idle";
  return [
    {
      key: "approve",
      label: "대본 승인",
      state: pick(approved, pendingScriptApprovals(job).includes(number), false),
    },
    {
      key: "voice",
      label: "내레이션",
      state: pick(hasFinal || Boolean(render?.voice), false, phase === "voice"),
    },
    {
      key: "start",
      label: startLabel,
      state: pick(
        hasFinal || (startTotal + stillTotal > 0 && startDone),
        waitPhase !== null && FLOW_IMAGE_PHASES.has(waitPhase) && waitPhase !== "image",
        phase === "stills" || phase === "startImages",
      ),
    },
    {
      key: "clips",
      label: clipTotal > 0 ? `클립 ${clipTotal - clipMissing}${NBSP}/${NBSP}${clipTotal}` : "클립",
      state: pick(hasFinal || (clipTotal > 0 && clipMissing === 0), clipTurn, phase === "clips"),
    },
    {
      key: "assemble",
      label: "조립",
      state: pick(hasFinal, false, phase === "graphics" || phase === "assemble"),
    },
    { key: "final", label: "완성", state: pick(hasFinal, false, false) },
  ];
}

type MenuItem = {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string | undefined;
  readonly onSelect: () => void;
};
// ⋯ 메뉴(바깥 클릭·Esc 로 닫고 ↑↓ 로 항목을 옮긴다).
function MoreMenu({
  items,
  label,
}: {
  readonly items: readonly MenuItem[];
  readonly label: string;
}) {
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
        className="button button-secondary button-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label={label} onKeyDown={move}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={item.disabled}
              title={item.title}
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

// 카드 안 접힘 한 행: 제목 + 보조 한 줄. 열기 전에는 본문을 그리지 않는다(영상 한 편에 DOM 이 쌓이지 않게).
function Fold({
  title,
  sub,
  aside,
  children,
}: {
  readonly title: string;
  readonly sub?: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="card-fold">
      <Disclosure
        variant="plain"
        summary={
          <>
            <span className="fold-title">{title}</span>
            {sub && <span className="fold-sub">{sub}</span>}
            {aside && <span className="fold-aside">{aside}</span>}
          </>
        }
      >
        {children}
      </Disclosure>
    </div>
  );
}

export function VideoDetail({
  job,
  number,
  onOpenOverview,
}: {
  readonly job: Job;
  readonly number: number;
  // Flow 이미지 올리기는 개요 탭의 이미지 패널에서 한다.
  readonly onOpenOverview: () => void;
}) {
  const script = videoScriptFor(job, number);
  const render = job.renders.find((entry) => entry.number === number);
  const item = videoBoardItems(job).find((entry) => entry.number === number);
  const state = item?.state ?? agentUiState("idle");
  const finalArtifact = item?.download ?? null;
  const hasFinal = Boolean(render?.final) || finalArtifact !== null;
  const digest = render?.final?.digest ?? "";
  const reportArtifact = job.artifacts.find(
    (asset) => asset.name === `render-report-${number}.json`,
  );
  const report = useRenderReport(hasFinal ? reportArtifact : undefined, render?.final?.digest);
  const [rewriteSignal, setRewriteSignal] = useState(0);
  const [reassembling, setReassembling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const automation = job.automation;
  const running =
    job.status === "running" || automation?.status === "running" || automation?.status === "queued";
  const previous = job.artifacts.filter((asset) =>
    new RegExp(`^video-final-${number}-before-reassembly-.+\\.mp4$`, "u").test(asset.name),
  );
  const exportMarkdown = job.artifacts.find((asset) => asset.name === flowExportName(number, "md"));
  const flowMode = clipModeOf(job) === "flow";
  const draftHere = pendingScriptDraft(job)?.number === number;

  if (!script) {
    return (
      <section
        className="video-detail"
        id={`video-script-${number}`}
        tabIndex={-1}
        aria-label={`영상 ${number}`}
      >
        <header className="vd-head">
          <div className="vd-title">
            <div className="vd-eyebrow">
              <span>영상 {number}</span>
              <StatusDot state={state} />
            </div>
            <h2>{item?.title ?? `영상 ${number}`}</h2>
          </div>
        </header>
        <div className="vd-empty panel-block">
          <p>
            {state.detail || "아직 이 영상의 대본이 없어요. 광고안 기획이 끝나면 만들어집니다."}
          </p>
        </div>
        {draftHere && <ScriptDraftPanel job={job} />}
      </section>
    );
  }

  const concept = job.creativePlan?.hypotheses.find((entry) => entry.id === script.hypothesisId);
  const hybrid = isHybrid(script);
  const policy = visualPolicyLabel(script.planning?.visualPolicy);
  const approval = scriptStatusOf(job, number);
  const approvalNote = approval.family === "done" ? `대본 ${approval.label}` : "";
  const canEdit = scriptCanEdit(job, number);
  const pendingApproval = pendingScriptApprovals(job).includes(number);
  const waiting = automation?.status === "waiting" ? automation : null;
  const turnFlow =
    flowMode &&
    waiting !== null &&
    waiting.phase !== "script" &&
    !FLOW_IMAGE_PHASES.has(waiting.phase) &&
    waitingVideoNumber(job) === number &&
    pendingFlowClips(job, number).length > 0 &&
    !hasFinal;
  const imageTurn =
    waiting !== null &&
    FLOW_IMAGE_PHASES.has(waiting.phase) &&
    waitingVideoNumber(job) === number &&
    !hasFinal;
  const clipTotal = script.veoClips.length + script.infoClips.length;
  const checks = reportChecks(report);
  const voices = finalVoices(job.artifacts, number);
  const canReassemble = hasFinal && !running && !job.staged;
  const showCalloutEditor =
    hasFinal &&
    job.status === "completed" &&
    automation?.policy.mode === "creative" &&
    automation.status === "completed" &&
    !job.staged;

  const reassemble = async () => {
    const ok = await confirmDialog(
      `영상 ${number}을 저장된 입력으로 다시 조립합니다. 기존 영상은 이전 버전으로 보관되고 유료 생성은 없습니다.`,
      { confirmLabel: "다시 조립" },
    );
    if (!ok) return;
    setReassembling(true);
    setActionError(null);
    try {
      await api.post(`jobs/${job.id}/videos/${number}/reassemble`, { timeout: false });
      toast(`영상 ${number}을 다시 조립했습니다. 재생해 확인하세요.`);
    } catch (cause) {
      setActionError(await errorMessage(cause));
    } finally {
      setReassembling(false);
    }
  };
  const openHistory = () => {
    const details = historyRef.current?.querySelector("details");
    if (!details) return;
    details.open = true;
    details.scrollIntoView({ block: "center" });
    details.querySelector("summary")?.focus({ preventScroll: true });
  };
  const copyFlowPrompt = () => {
    void navigator.clipboard.writeText(script.flowPrompt).then(
      () => toast(`영상 ${number} Flow 프롬프트를 복사했습니다.`),
      () => toast("복사하지 못했습니다. 프롬프트를 직접 선택해 주세요."),
    );
  };
  const menuItems: MenuItem[] = [
    ...(flowMode
      ? [
          {
            key: "flow-guide",
            label: "Flow 지시서 받기",
            icon: <FileText size={14} strokeWidth={1.75} aria-hidden="true" />,
            disabled: !exportMarkdown,
            onSelect: () => {
              if (exportMarkdown) window.open(exportMarkdown.url, "_blank", "noopener");
            },
          },
        ]
      : []),
    ...(hasFinal
      ? [
          {
            key: "history",
            label: previous.length > 0 ? `이전 버전 ${previous.length}개 보기` : "이전 버전 없음",
            icon: <History size={14} strokeWidth={1.75} aria-hidden="true" />,
            disabled: previous.length === 0,
            onSelect: openHistory,
          },
        ]
      : []),
    {
      key: "rewrite",
      label: "대본 다시 쓰기",
      icon: <PenLine size={14} strokeWidth={1.75} aria-hidden="true" />,
      disabled: !canEdit,
      title: canEdit
        ? undefined
        : "내레이션이 이미 합성됐거나 작업이 실행 중이면 대본을 바꿀 수 없습니다.",
      onSelect: () => setRewriteSignal((value) => value + 1),
    },
  ];
  const meta = [
    hasFinal && render?.final ? seconds(render.final.durationMs) : `대본 ${script.durationSec}초`,
    ...(report?.width && report.height ? [`${report.width} × ${report.height}`] : []),
    `컷 ${script.cuts.length}`,
    ...(report ? [`소리 크기 ${loudnessOk(report) ? "정상" : "확인 필요"}`] : []),
  ];
  const sourceSub = [
    `클립 ${clipTotal}`,
    `${hybrid ? "실사" : "Veo"} ${script.veoClips.length}`,
    `설명 장면 ${script.infoClips.length}`,
    `정지 이미지 ${script.stills.length}`,
  ].join(" · ");
  const legacyClip = job.artifacts.find((asset) => asset.name === `video-auto-${number}.mp4`);

  return (
    <section
      className="video-detail"
      id={`video-script-${number}`}
      tabIndex={-1}
      aria-label={`영상 ${number} ${script.title}`}
    >
      <header className="vd-head">
        <div className="vd-title">
          <div className="vd-eyebrow">
            <span>영상 {number}</span>
            <StatusDot state={state} />
            {approvalNote && <span>{approvalNote}</span>}
          </div>
          <h2>{script.title}</h2>
          <p className="vd-meta">
            {meta.map((text) => (
              <span key={text}>{text}</span>
            ))}
          </p>
        </div>
        <div className="vd-actions">
          {finalArtifact && (
            <a
              className="button button-primary"
              href={finalArtifact.url}
              download={finalArtifact.name}
            >
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              MP4 받기
            </a>
          )}
          {hasFinal && (
            <Button
              pending={reassembling}
              disabled={!canReassemble}
              title={running ? "실행 중인 작업은 재조립할 수 없습니다." : undefined}
              onClick={() => {
                void reassemble();
              }}
            >
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
              다시 조립
            </Button>
          )}
          <MoreMenu label={`영상 ${number} 더 보기`} items={menuItems} />
        </div>
      </header>
      {actionError && <Notice tone="error">{actionError}</Notice>}
      {turnFlow && <FlowPanel job={job} script={script} turn />}
      <div className="stepper-card">
        <Stepper steps={videoSteps(job, script, number)} label={`영상 ${number} 제작 단계`} />
      </div>
      <div className="vd-grid">
        <div className="vd-player-col">
          {finalArtifact ? (
            // biome-ignore lint/a11y/useMediaCaption: 자막은 영상 화면에 구워져 있어 따로 켜고 끌 텍스트 트랙이 없다.
            <video
              className="vd-player"
              controls
              preload="none"
              poster={item?.posterUrl ?? undefined}
              src={`${finalArtifact.url}${digest ? `?v=${digest}` : ""}`}
              aria-label={`영상 ${number} 완성본`}
            />
          ) : (
            <div className="vd-player vd-player-empty">
              <StatusDot state={state} size={14} />
              <p>{state.detail || "대본 준비됨"}</p>
              {imageTurn && (
                <Button size="sm" onClick={onOpenOverview}>
                  개요에서 이미지 올리기
                </Button>
              )}
            </div>
          )}
          <div className="vd-player-links">
            {clipTotal + script.stills.length > 0 && (
              <Disclosure
                variant="plain"
                summary={`${flowMode ? "Flow " : ""}클립 ${clipTotal}개 보기`}
              >
                <ClipStillGrid job={job} script={script} />
              </Disclosure>
            )}
            {previous.length > 0 && (
              <button type="button" className="link-button" onClick={openHistory}>
                이전 버전 {previous.length}개
              </button>
            )}
          </div>
        </div>
        <ScriptEditor
          key={scriptEditorKey(script)}
          job={job}
          script={script}
          defaultEditing={pendingApproval && canEdit}
          rewriteSignal={rewriteSignal}
        >
          {flowMode && !hasFinal && !turnFlow && (
            <Fold
              title="Flow 클립 올리기"
              sub={`${clipTotal - pendingFlowClips(job, number).length} / ${clipTotal}`}
            >
              <FlowPanel job={job} script={script} />
            </Fold>
          )}
          <Fold title="제작 소스" sub={sourceSub}>
            <div className="stack">
              <p>
                <strong>대표 이미지(연속성 기준):</strong>{" "}
                {concept?.creative.imagePrompt ?? "연결된 광고안 확인 필요"}
              </p>
              {script.styleAnchor && (
                <p>
                  <strong>{hybrid ? "실사 시각 기준:" : "공통 시각 기준:"}</strong>{" "}
                  {script.styleAnchor}
                </p>
              )}
              <ScriptSources script={script} />
              <p>
                <strong>Flow 프롬프트:</strong> {script.flowPrompt}
              </p>
              <div className="cluster">
                <Button size="sm" onClick={copyFlowPrompt}>
                  <Copy size={14} aria-hidden="true" />
                  Flow 프롬프트 복사
                </Button>
              </div>
              <p>
                <strong>편집 지시:</strong> {script.editInstructions}
              </p>
              {legacyClip && (
                <a href={legacyClip.url} download={legacyClip.name}>
                  예전 Veo 원본 클립 다운로드
                </a>
              )}
            </div>
          </Fold>
          <Fold
            title="이 영상의 타겟과 메시지"
            sub={stripEnumPrefix(concept?.targetAudience ?? script.hypothesisId)}
          >
            <div className="stack">
              <p>{stripEnumPrefix(concept?.targetAudience ?? script.hypothesisId)}</p>
              {policy && (
                <p>
                  <span className="badge badge-accent">{policy}</span>
                </p>
              )}
              {script.openLoop && (
                <p>
                  <strong>궁금증:</strong> {script.openLoop} · {script.payoffSec}초에 답
                </p>
              )}
              {script.fixedTitle.length > 0 && (
                <p>
                  <strong>고정 제목:</strong> {script.fixedTitle.join(" / ")}
                </p>
              )}
              {script.disclaimer && (
                <p>
                  <strong>고지 문구:</strong> {script.disclaimer}
                </p>
              )}
              {script.voicePersona && (
                <p>
                  <strong>내레이션 말투:</strong>{" "}
                  {script.voicePersona === "storytelling" ? "이야기하듯 전달" : "대화하듯 전달"}
                </p>
              )}
              {script.planning && <VideoPlanning planning={script.planning} />}
            </div>
          </Fold>
          {hasFinal && (
            <Fold
              title="렌더 보고"
              sub={checks.routine.length > 0 ? `자동 안내 ${checks.routine.length}건 접어 둠` : ""}
              aside={
                report ? (
                  <span className="fold-state">
                    <i aria-hidden="true" className={checks.checks.length === 0 ? "is-ok" : ""} />
                    {checks.checks.length === 0
                      ? "확인할 점 없음"
                      : `확인할 점 ${checks.checks.length}`}
                  </span>
                ) : undefined
              }
            >
              {report ? (
                <div className="stack">
                  <dl className="definition-list">
                    <div>
                      <dt>길이</dt>
                      <dd>{((render?.final?.durationMs ?? 0) / 1000).toFixed(1)}초</dd>
                    </div>
                    <div>
                      <dt>소리 크기</dt>
                      <dd>
                        {loudnessOk(report) ? "정상" : "확인 필요"} ·{" "}
                        {report.integratedLufs.toFixed(1)} LUFS · 피크{" "}
                        {report.truePeakDb.toFixed(1)} dBTP
                      </dd>
                    </div>
                    <div>
                      <dt>배경음악</dt>
                      <dd>
                        {report.bgm
                          ? `${report.bgm.id} · ${report.bgm.license || "라이선스 미기재"}`
                          : "없음"}
                      </dd>
                    </div>
                    <div>
                      <dt>렌더 엔진</dt>
                      <dd className="mono">ffmpeg {report.ffmpegVersion}</dd>
                    </div>
                  </dl>
                  {checks.checks.length > 0 && (
                    <ul className="script-rules">
                      {checks.checks.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  )}
                  {checks.routine.length > 0 && (
                    <Disclosure variant="plain" summary={`자동 안내 ${checks.routine.length}건`}>
                      <ul className="script-rules">
                        {checks.routine.map((text) => (
                          <li key={text}>{text}</li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </div>
              ) : (
                <p className="muted small-copy">렌더 보고를 불러오는 중이거나 아직 없어요.</p>
              )}
            </Fold>
          )}
          {hasFinal && (
            <div ref={historyRef}>
              <Fold title="다시 조립 기록" sub={`이전 버전 ${previous.length}`}>
                <div className="stack">
                  {previous.length === 0 ? (
                    <p className="muted small-copy">아직 다시 조립한 기록이 없어요.</p>
                  ) : (
                    <ul className="history-list">
                      {previous.map((asset, index) => (
                        <li className="history-row" key={asset.id}>
                          <span>이전 버전 {index + 1}</span>
                          <a href={asset.url} download={asset.name}>
                            받기
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {showCalloutEditor && (
                    <CalloutEditor key={`${job.id}-${number}`} jobId={job.id} number={number} />
                  )}
                </div>
              </Fold>
            </div>
          )}
          {voices.length > 0 && (
            <div className="card-fold">
              <NarrationDisclosure voices={voices} />
            </div>
          )}
        </ScriptEditor>
      </div>
    </section>
  );
}
