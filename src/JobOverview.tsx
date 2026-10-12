import { Plus } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { flowImagesOf } from "../shared/flow-images";
import { nextAction } from "../shared/next-action";
import { canReviewPlan } from "../shared/plan-recovery";
import type { ConfigStatus, Job, StudioState } from "../shared/schema";
import { jobUiState } from "../shared/ui-state";
import { ActivityRail } from "./ActivityRail";
import {
  type AutomationActions,
  AutomationAdvanced,
  AutomationSetupHost,
  automationNeeds,
} from "./AutomationPanel";
import { ScriptDraftPanel } from "./AutomationStatus";
import { FlowImagesPanel } from "./FlowImagesPanel";
import { type CardAction, type CardCommand, NextActionCard } from "./NextActionCard";
import { Button, Disclosure, Notice } from "./primitives";
import { ScriptBatchApproval } from "./ScriptBatchApproval";
import { FinalsDialog, VideoBoard } from "./VideoBoard";

const PlanRecoveryPanel = lazy(() =>
  import("./PlanRecoveryPanel").then((module) => ({ default: module.PlanRecoveryPanel })),
);
const FLOW_IMAGE_PHASES = ["image", "stills", "startImages"];

// 처음 열었을 때(작업이 하나도 없을 때)의 안내
export function JobWelcome({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <section className="welcome-panel">
      <div className="welcome-copy">
        <span className="eyebrow">다음 캠페인</span>
        <h2>
          좋은 광고의 시작,
          <br />
          하나의 제품 브리프.
        </h2>
        <p>
          전략부터 기획, 소재 제작까지.
          <br />
          단계가 차례로 진행하는 모습을 한곳에서 확인하세요.
        </p>
        <Button variant="primary" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />첫 작업 만들기
        </Button>
      </div>
      <ol className="welcome-steps" aria-label="시작 순서">
        <li>
          <span aria-hidden="true">1</span>제품 링크와 자료로 작업을 만듭니다
        </li>
        <li>
          <span aria-hidden="true">2</span>단계가 차례로 진행합니다
        </li>
        <li>
          <span aria-hidden="true">3</span>완성 영상을 확인합니다
        </li>
      </ol>
    </section>
  );
}

const reveal = (node: HTMLElement | null) => {
  if (!node) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  node.focus({ preventScroll: true });
};

// 개요 탭: 지금 할 일 카드 → (필요할 때만) 처리 패널 → 영상 보드 → 고급. 영상 플레이어·대본 카드·파일 카드는 여기 없다.
export function JobOverview({
  job,
  config,
  engine,
  live,
  manualPending,
  actions,
  onCreate,
  onRun,
  onCancel,
  onSettings,
  onRefresh,
  onOpenVideo,
  onOpenLog,
}: {
  readonly job: Job;
  readonly config: ConfigStatus;
  readonly engine: StudioState["engine"];
  readonly live: boolean;
  readonly manualPending: boolean;
  readonly actions: AutomationActions;
  readonly onCreate: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onSettings: () => void;
  readonly onRefresh: () => void;
  readonly onOpenVideo: (number: number | null) => void;
  readonly onOpenLog: () => void;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [finals, setFinals] = useState<{ readonly numbers: readonly number[] | null } | null>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef<HTMLDivElement>(null);
  const automation = job.automation;
  const creativePolicy = automation?.policy.mode === "creative" ? automation.policy : null;
  const needs = automationNeeds(job, config);
  const ui = jobUiState(job);
  const base = nextAction(job);
  const planReview = canReviewPlan(job);
  const flowImages = flowImagesOf(job);
  const imagesVisible = job.executionModels?.imageProvider === "flow" && flowImages.length > 0;
  const imagesWaiting =
    automation?.status === "waiting" &&
    creativePolicy !== null &&
    FLOW_IMAGE_PHASES.includes(automation.phase);
  const waitingImageCount = flowImages.filter((request) => !request.digest).length;
  // Flow 이미지 대기: 행동 면은 바로 아래 이미지 패널이다. 영상 번호로 가는 버튼 대신 거기로 이동하는 버튼을 둔다.
  const action: CardAction =
    imagesWaiting && imagesVisible
      ? {
          ...base,
          primary: { label: "Flow 이미지 올리기", command: { type: "openImages" } },
          secondary: base.secondary,
        }
      : base;
  const approvalVisible =
    creativePolicy !== null &&
    (creativePolicy.videoCount ?? 0) > 0 &&
    automation?.phase === "script";
  const showNeeds =
    (base.kind === "start" || automation?.status === "blocked") &&
    (needs.missingTools.length > 0 || needs.missingVideoTools.length > 0 || needs.needsCliModel);
  const pendingCommand =
    actions.pending === "resume" ? "resume" : actions.pending === "stop" ? "stop" : null;
  const onCommand = (command: CardCommand) => {
    switch (command.type) {
      case "start":
        setSetupOpen(true);
        break;
      case "resume":
        void actions.resume();
        break;
      case "stop":
        void actions.stop();
        break;
      case "openVideo":
        onOpenVideo(command.number);
        break;
      case "approveScripts":
        reveal(approvalRef.current);
        break;
      case "openSettings":
        onSettings();
        break;
      case "reviewPlan":
        reveal(planRef.current);
        break;
      case "downloadFinals":
        setFinals({ numbers: command.numbers });
        break;
      case "openImages":
        reveal(imagesRef.current);
        break;
    }
  };
  return (
    <div className="overview-grid">
      <div className="overview-main">
        <div className="next-stack">
          <NextActionCard
            action={action}
            family={ui.family}
            head={ui.label.split(" · ")[0] ?? ui.label}
            pending={pendingCommand}
            disabledPrimary={
              base.primary?.command.type === "start" &&
              (needs.needsCliModel || job.status === "running")
            }
            onCommand={onCommand}
          />
          {planReview && (
            <div className="anchor" ref={planRef} tabIndex={-1}>
              <Suspense fallback={<p role="status">기획 선택 화면을 불러오는 중입니다.</p>}>
                <PlanRecoveryPanel job={job} onRefresh={onRefresh} />
              </Suspense>
            </div>
          )}
          <ScriptDraftPanel job={job} />
          {approvalVisible && (
            <div className="panel-block anchor" ref={approvalRef} tabIndex={-1}>
              <ScriptBatchApproval
                key={job.id}
                job={job}
                onRefresh={onRefresh}
                onShowScript={(number) => onOpenVideo(number ?? base.videoNumber)}
              />
            </div>
          )}
          {imagesVisible && (
            <div className="anchor" ref={imagesRef} tabIndex={-1}>
              <Disclosure
                key={imagesWaiting ? "waiting" : "idle"}
                variant="plain"
                defaultOpen={imagesWaiting}
                summary={
                  waitingImageCount > 0
                    ? `Flow 이미지 올리기 · 대기 ${waitingImageCount}장`
                    : `Flow 이미지 ${flowImages.length}장 · 모두 올림`
                }
              >
                <FlowImagesPanel job={job} onRefresh={onRefresh} />
              </Disclosure>
            </div>
          )}
          {automation?.status === "attention" && needs.uncertainClips.length > 0 && (
            <p className="muted small-copy">
              결과가 불확실한 클립: {needs.uncertainClips.join(", ")}. 공급자 사용량을 확인한 뒤
              이어서 진행하면 해당 클립만 다시 만들어요(중복 과금 가능성).
            </p>
          )}
          {showNeeds && (
            <Notice>
              <div className="stack">
                {needs.missingTools.length > 0 && (
                  <p>
                    제작에 필요한 연결이 비어 있어요: {needs.missingTools.join(" · ")}. 연결
                    설정에서 입력할 수 있어요.
                  </p>
                )}
                {needs.missingVideoTools.length > 0 && (
                  <p>
                    완성 영상에 필요(영상 0개면 무관): {needs.missingVideoTools.join(" · ")}. 키는
                    연결 설정에서, ffmpeg·폰트는 서버 환경에서 준비합니다.
                  </p>
                )}
                {needs.needsCliModel && (
                  <p>
                    선택한 AI의 자동 운영에는 고정할 모델 ID가 필요합니다. 연결 설정에서 모델을
                    입력하세요.
                  </p>
                )}
                <div>
                  <Button size="sm" onClick={onSettings}>
                    연결 설정
                  </Button>
                </div>
              </div>
            </Notice>
          )}
          {!automation && needs.legacy && (
            <Notice>
              <div className="stack">
                <p>
                  이미 파일이 있는 작업입니다. 기존 작업은 자동 운영에 등록되지 않으니 새 작업에서
                  자동 운영을 설정하세요.
                </p>
                <div>
                  <Button size="sm" onClick={onCreate}>
                    새 작업 만들기
                  </Button>
                </div>
              </div>
            </Notice>
          )}
        </div>
        <VideoBoard
          job={job}
          onOpenVideo={onOpenVideo}
          onDownloadAll={() => setFinals({ numbers: null })}
        />
      </div>
      <ActivityRail job={job} live={live} onOpenLog={onOpenLog} />
      <div className="overview-advanced">
        <Disclosure summary="고급 · 자동 운영 상세">
          <AutomationAdvanced
            job={job}
            engine={engine}
            actions={actions}
            manual={{ pending: manualPending, onRun, onCancel }}
          />
        </Disclosure>
      </div>
      <AutomationSetupHost
        job={job}
        config={config}
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSaved={onRefresh}
      />
      {finals && (
        <FinalsDialog job={job} numbers={finals.numbers} onClose={() => setFinals(null)} />
      )}
    </div>
  );
}
