import { Play, Square } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { clipModeOf } from "../shared/flow-mode";
import type { ConfigStatus, Job, StudioState } from "../shared/schema";
import { AutomationStatus, operationDate, planIssueText } from "./AutomationStatus";
import { errorMessage, postJob } from "./api";
import { confirmDialog } from "./confirm-dialog";
import { ModelProvenance } from "./ModelProvenance";
import { Button, Notice } from "./primitives";

const AutomationSetup = lazy(() =>
  import("./AutomationSetup").then((module) => ({ default: module.AutomationSetup })),
);

type AutomationAction = "stop" | "resume" | "reset";
export type AutomationActions = {
  readonly pending: AutomationAction | null;
  readonly resume: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
};
// 이어서 진행·중지·초기화. 유료 호출이나 되돌릴 수 없는 일이라 모두 확인 창을 거친다(docs 8-1절 a).
export function useAutomationActions(
  job: Job | null,
  onRefresh: () => void,
  onError: (message: string | null) => void,
): AutomationActions {
  const [pending, setPending] = useState<AutomationAction | null>(null);
  const mutate = async (action: AutomationAction) => {
    if (!job) return;
    setPending(action);
    onError(null);
    try {
      await postJob(
        `jobs/${job.id}/automation/${action}`,
        action === "stop" ? undefined : { confirmation: true },
      );
      onRefresh();
    } catch (cause) {
      onError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  return {
    pending,
    resume: async () => {
      if (
        await confirmDialog(
          "저장된 결과는 그대로 두고 남은 단계부터 이어서 진행해요. 설정에 따라 API 비용이나 Flow 크레딧이 들 수 있어요. 이어서 진행할까요?",
          { confirmLabel: "이어서 진행" },
        )
      )
        await mutate("resume");
    },
    stop: async () => {
      if (
        await confirmDialog(
          "자동 제작을 중지할까요? 이미 만든 결과는 그대로 남고, 이어서 진행으로 다시 시작할 수 있어요.",
          { confirmLabel: "중지" },
        )
      )
        await mutate("stop");
    },
    reset: async () => {
      if (
        await confirmDialog("자동 운영과 생성 결과물을 초기화할까요? 되돌릴 수 없습니다.", {
          confirmLabel: "초기화",
          danger: true,
        })
      )
        await mutate("reset");
    },
  };
}

// 시작 전에 막힐 수 있는 연결·도구, 불확실한 클립 요청. 화면 곳곳(지금 할 일 카드 아래 안내·고급)이 같은 계산을 쓴다.
export function automationNeeds(job: Job, config: ConfigStatus) {
  const flowMode = clipModeOf(job) === "flow";
  const needsCliModel =
    (config.textProvider === "codex" && !config.modelSettings.codexModel) ||
    (config.textProvider === "claudeCode" && !config.modelSettings.claudeCodeModel);
  const missingTools = [
    !config.openai &&
      (config.modelSettings.imageProvider !== "flow" || config.textProvider === "openai") &&
      "OpenAI API 키",
    config.textProvider === "codex" && !config.codex && "Codex 설치",
    config.textProvider === "claudeCode" && !config.claudeCode && "Claude Code 설치",
    config.textProvider === "none" && "텍스트 공급자",
    config.modelSettings.imageProvider === "flow" && !config.ffmpeg && "ffmpeg(Flow 이미지 검사)",
  ].filter((item): item is string => Boolean(item));
  // 영상(완성본)을 만들려면 추가로 필요한 연결·도구. 영상 0개면 없어도 된다.
  const missingVideoTools = [
    !config.gemini && !flowMode && "Gemini API 키(Veo)",
    !config.typecast && "Typecast API 키(내레이션)",
    !config.ffmpeg && "ffmpeg 8.x(libass·libx264)",
    !config.captionFont && "자막 폰트(assets/fonts 또는 FONT_DIR)",
  ].filter((item): item is string => Boolean(item));
  // 응답 수신과 핸들 저장 사이에 끊긴 Veo 클립: 이어서 진행하면 다시 생성하므로 중복 과금 가능성이 있다
  const uncertainClips = job.renders.flatMap((render) =>
    Object.entries(render.clips).flatMap(([clipId, clip]) =>
      clip?.pendingSince && !clip.operation && !clip.name
        ? [`영상 ${render.number} 클립 ${clipId}`]
        : [],
    ),
  );
  return {
    needsCliModel,
    missingTools,
    missingVideoTools,
    uncertainClips,
    legacy: Boolean(job.staged) || job.artifacts.length > 0,
  };
}

// 시작 설정 창(자동 제작 정책 선택). 시작 버튼은 지금 할 일 카드가 가진다.
export function AutomationSetupHost({
  job,
  config,
  open,
  onClose,
  onSaved,
}: {
  readonly job: Job;
  readonly config: ConfigStatus;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  if (!open) return null;
  return (
    <Suspense fallback={<Notice>시작 설정을 불러오고 있습니다…</Notice>}>
      <AutomationSetup
        job={job}
        imageProvider={config.modelSettings.imageProvider ?? "openai"}
        geminiConnected={config.gemini}
        typecastConnected={config.typecast}
        ffmpegReady={config.ffmpeg && config.captionFont}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Suspense>
  );
}

// 고급 · 자동 운영 상세 안쪽: 실행 범위·예약·고정된 AI 모델·엔진 상태. 평소에는 열지 않아도 되는 정보다.
export function AutomationAdvanced({
  job,
  engine,
  actions,
  manual,
}: {
  readonly job: Job;
  readonly engine: StudioState["engine"];
  readonly actions: AutomationActions;
  readonly manual: {
    readonly pending: boolean;
    readonly onRun: () => void;
    readonly onCancel: () => void;
  };
}) {
  const automation = job.automation;
  const canReset = automation?.status === "stopped" || automation?.status === "blocked";
  const issues = job.automation?.planChoice?.issues ?? [];
  const isRetry = ["blocked", "cancelled", "failed"].includes(job.status);
  return (
    <div className="stack">
      {automation && <AutomationStatus job={job} automation={automation} />}
      {automation?.planChoice?.action === "use" && issues.length > 0 && (
        <p className="muted small-copy">
          구성 경고를 확인하고 이 기획으로 제작하기로 했어요. {issues.map(planIssueText).join(" ")}
        </p>
      )}
      {automation?.lastError && (
        <p className="muted small-copy">마지막 안내: {automation.lastError}</p>
      )}
      {!job.sourceSnapshot && (job.productDescription || job.audience) && (
        <dl className="definition-list">
          {job.productDescription && (
            <div>
              <dt>제품 설명</dt>
              <dd>{job.productDescription}</dd>
            </div>
          )}
          {job.audience && (
            <div>
              <dt>타깃 고객</dt>
              <dd>{job.audience}</dd>
            </div>
          )}
        </dl>
      )}
      {!automation && !job.sourceSnapshot && (
        <div className="manual-run">
          <p className="muted small-copy">
            필요한 경우에만 개별 단계를 직접 실행합니다.{" "}
            {job.status === "review" && "직접 준비한 광고는 게시 검토에서 확인할 수 있습니다."}
          </p>
          {job.status === "running" ? (
            <Button variant="secondary" pending={manual.pending} onClick={manual.onCancel}>
              <Square size={13} aria-hidden="true" />
              작업 중지
            </Button>
          ) : (
            <Button
              pending={manual.pending}
              disabled={job.status === "review" || job.status === "completed"}
              onClick={manual.onRun}
            >
              <Play size={14} aria-hidden="true" />
              {isRetry ? "이어서 진행" : "시작"}
            </Button>
          )}
        </div>
      )}
      <ModelProvenance job={job} />
      <p className="muted small-copy">
        운영 엔진: {engine.running ? "가동 중" : "중지됨"} · 자동 운영 {engine.activeJobs}개 ·
        마지막 확인 {operationDate(engine.lastTickAt)}. 이 컴퓨터의 서버가 실행 중이어야 예약 작업이
        진행됩니다.
      </p>
      {canReset && (
        <div>
          <Button
            variant="ghost"
            pending={actions.pending === "reset"}
            onClick={() => {
              void actions.reset();
            }}
          >
            초기화 후 새로 시작
          </Button>
        </div>
      )}
    </div>
  );
}
