import { CirclePause, LoaderCircle, Play, Settings2, Square } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { AutomationState } from "../shared/automation";
import { clipModeOf } from "../shared/flow-mode";
import type { ConfigStatus, Job, StudioState } from "../shared/schema";
import { AutomationStatus, operationDate } from "./AutomationStatus";
import { errorMessage, postJob } from "./api";
import { confirmDialog } from "./confirm-dialog";
import { ModelProvenance } from "./ModelProvenance";
import { Button, Notice } from "./primitives";

const AutomationSetup = lazy(() =>
  import("./AutomationSetup").then((module) => ({ default: module.AutomationSetup })),
);
const statuses = {
  queued: ["실행 대기", "neutral"],
  running: ["자동 작업 중", "accent"],
  waiting: ["다음 분석 대기", "neutral"],
  blocked: ["설정 대기", "warning"],
  attention: ["확인 필요", "warning"],
  stopped: ["자동 운영 중지", "neutral"],
  completed: ["운영 완료", "success"],
} as const satisfies Record<AutomationState["status"], readonly [string, string]>;

// 소재 제작의 waiting 은 분석 예약이 아니라 사용자 작업 대기다(실패가 아님): 대본 승인 또는 Google Flow 클립 업로드.
function statusOf(automation: AutomationState): readonly [string, string] {
  if (automation.status !== "waiting" || automation.policy.mode !== "creative")
    return statuses[automation.status];
  return automation.phase === "script"
    ? ["영상 대본 승인 대기", "warning"]
    : ["Flow 클립 업로드 대기", "warning"];
}
export function AutomationPanel({
  job,
  config,
  engine,
  onSettings,
  onRefresh,
  onCreate,
}: {
  readonly job: Job;
  readonly config: ConfigStatus;
  readonly engine: StudioState["engine"];
  readonly onSettings: () => void;
  readonly onRefresh: () => void;
  readonly onCreate: () => void;
}) {
  const [setup, setSetup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automation = job.automation;
  const flowMode = clipModeOf(job) === "flow";
  const legacy = Boolean(job.staged) || job.artifacts.length > 0;
  const needsCodexModel = config.textProvider === "codex" && !config.modelSettings.codexModel;
  const missingTools = [
    !config.openai && "OpenAI API 키",
    config.textProvider === "none" && "텍스트 공급자",
  ].filter(Boolean);
  // 영상(완성본)을 만들려면 추가로 필요한 연결·도구. 영상 0개면 없어도 된다.
  const missingVideoTools = [
    !config.gemini && !flowMode && "Gemini API 키(Veo)",
    !config.typecast && "Typecast API 키(내레이션)",
    !config.ffmpeg && "ffmpeg 8.x(libass·libx264)",
    !config.captionFont && "자막 폰트(assets/fonts 또는 FONT_DIR)",
  ].filter(Boolean);
  // 응답 수신과 핸들 저장 사이에 끊긴 Veo 클립: 재개하면 다시 생성하므로 중복 과금 가능성이 있다
  const uncertainClips = job.renders.flatMap((render) =>
    Object.entries(render.clips).flatMap(([clipId, clip]) =>
      clip?.pendingSince && !clip.operation && !clip.name
        ? [`영상 ${render.number} 클립 ${clipId}`]
        : [],
    ),
  );
  const mutate = async (action: "stop" | "resume" | "reset") => {
    setPending(true);
    setError(null);
    try {
      await postJob(
        `jobs/${job.id}/automation/${action}`,
        action === "stop" ? undefined : { confirmation: true },
      );
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const canStop = automation && !["stopped", "completed"].includes(automation.status);
  return (
    <section className="panel operation-panel" aria-labelledby="operation-title">
      <header className="panel-header spread">
        <div>
          <h2 id="operation-title">
            {automation && automation.policy.mode !== "creative"
              ? "광고 자동 운영"
              : "소재 자동 제작"}
          </h2>
          <p>
            {automation && automation.policy.mode !== "creative"
              ? "기존 광고 운영의 진행 상황입니다."
              : "상품 자료 분석과 영상 대본·컷 설계 후 이미지 제작·검토, 내레이션·Veo 클립·모션그래픽을 조립한 완성 영상 제작을 진행합니다."}
          </p>
        </div>
        <span className={`badge badge-${automation ? statusOf(automation)[1] : "neutral"}`}>
          {automation?.status === "running" ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <CirclePause size={12} />
          )}
          {automation ? statusOf(automation)[0] : "시작 전"}
        </span>
      </header>
      <div className="panel-body stack">
        {automation ? (
          <>
            <AutomationStatus job={job} automation={automation} />
            {automation.status === "attention" && uncertainClips.length > 0 && (
              <Notice tone="warning">
                {uncertainClips.join(", ")}의 Veo 요청 결과가 불확실합니다(중복 과금 가능성). 공급자
                사용량을 확인한 뒤 재개하면 해당 클립만 다시 생성합니다.
              </Notice>
            )}
            <div className="cluster operation-actions">
              {canStop && (
                <Button
                  variant="danger"
                  pending={pending}
                  onClick={() => {
                    void mutate("stop");
                  }}
                >
                  <Square size={14} />
                  자동 운영 중지
                </Button>
              )}
              {(automation.status === "blocked" ||
                automation.status === "stopped" ||
                (automation.status === "waiting" && automation.policy.mode === "creative") ||
                (automation.status === "attention" &&
                  (automation.videoOperation !== null ||
                    automation.policy.mode === "creative"))) && (
                <Button
                  pending={pending}
                  onClick={() => {
                    void mutate("resume");
                  }}
                >
                  <Play size={14} />
                  {automation.status === "waiting"
                    ? automation.phase === "script"
                      ? "승인 상태 다시 확인"
                      : "업로드 상태 다시 확인"
                    : automation.status === "attention" && automation.policy.mode === "creative"
                      ? "검토 결과 확인 후 계속 진행"
                      : automation.status === "attention"
                        ? "기존 Veo 작업 재확인"
                        : "중지된 작업 재개"}
                </Button>
              )}
              {(automation.status === "stopped" || automation.status === "blocked") && (
                <Button
                  variant="ghost"
                  pending={pending}
                  onClick={async () => {
                    if (
                      await confirmDialog(
                        "자동 운영과 생성 결과물을 초기화할까요? 되돌릴 수 없습니다.",
                        { confirmLabel: "초기화", danger: true },
                      )
                    )
                      void mutate("reset");
                  }}
                >
                  초기화 후 새로 시작
                </Button>
              )}
              {automation.status === "blocked" && (
                <Button variant="ghost" onClick={onSettings}>
                  <Settings2 size={14} />
                  연결 설정
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <p>
              프로젝트 자료와 이미지 모델을 확인한 뒤 시작하세요. 광고 계정이나 예산 없이 소재를
              제작하고 검토합니다.
            </p>
            {job.sourceSnapshot && (
              <Notice>
                프로젝트 자료를 분석해 영상별 대본·컷·Flow 지시를 먼저 저장하고 이미지를 제작합니다.
                영상을 요청하면 내레이션 → AI 정지 이미지(최대 14장) → 시작 이미지 → Veo 클립(실사
                컷만, 최대 4개) → 모션그래픽 → 조립 순서로 30~60초 완성 영상(자막·BGM 포함)을
                저장합니다.
              </Notice>
            )}
            {missingTools.length > 0 && (
              <Notice tone="warning">
                제작 연결 대기: {missingTools.join(" · ")}. 연결 설정에서 입력할 수 있습니다.
              </Notice>
            )}
            {missingVideoTools.length > 0 && (
              <Notice>
                완성 영상 제작에 필요(영상 0개면 무관): {missingVideoTools.join(" · ")}. 키는 연결
                설정에서, ffmpeg·폰트는 서버 환경에서 준비합니다.
              </Notice>
            )}
            {legacy && (
              <Notice>
                이미 결과물이 있는 작업입니다. 기존 작업은 자동 운영에 등록되지 않습니다. 새
                작업에서 자동 운영을 설정하세요.
              </Notice>
            )}
            {needsCodexModel && (
              <Notice tone="warning">
                Codex 자동 운영에는 고정할 텍스트 모델 ID가 필요합니다. 연결 설정에서 Codex 모델을
                입력하세요.
              </Notice>
            )}
            <div className="cluster operation-actions">
              <Button
                variant="primary"
                disabled={legacy || needsCodexModel || job.status === "running"}
                onClick={() => setSetup(true)}
              >
                <Play size={15} />
                소재 자동 제작 설정
              </Button>
              {legacy && <Button onClick={onCreate}>새 작업 만들기</Button>}
              {(missingTools.length > 0 || needsCodexModel) && (
                <Button variant="ghost" onClick={onSettings}>
                  연결 설정
                </Button>
              )}
            </div>
          </>
        )}
        <ModelProvenance job={job} />
        <p className="muted small-copy">
          운영 엔진: {engine.running ? "가동 중" : "중지됨"} · 자동 운영 {engine.activeJobs}개 ·
          마지막 확인 {operationDate(engine.lastTickAt)}. 이 컴퓨터의 서버가 실행 중이어야 예약
          작업이 진행됩니다.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      {setup && (
        <Suspense fallback={<Notice>운영 설정을 불러오고 있습니다…</Notice>}>
          <AutomationSetup
            job={job}
            geminiConnected={config.gemini}
            typecastConnected={config.typecast}
            ffmpegReady={config.ffmpeg && config.captionFont}
            onClose={() => setSetup(false)}
            onSaved={onRefresh}
          />
        </Suspense>
      )}
    </section>
  );
}
