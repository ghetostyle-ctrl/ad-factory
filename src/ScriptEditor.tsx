import { ChevronRight, FileCheck, Pencil, RefreshCw, Save } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { clipModeOf } from "../shared/flow-mode";
import { hybridProblems } from "../shared/hybrid-script-rules";
import { chainExpectation } from "../shared/persuasion-chain";
import type { Job } from "../shared/schema";
import {
  narrationSynthesized,
  scriptApprovalMode,
  scriptApproved,
  scriptDigestOf,
  scriptNeedsApproval,
  scriptNeedsFix,
} from "../shared/script-approval";
import { applyScriptEdit } from "../shared/script-edit";
import { classifyScriptProblems, scenePlanProblems } from "../shared/script-rules";
import type { UiState } from "../shared/ui-state";
import {
  alignmentProblems,
  hypothesisFactTexts,
  narrationProblems,
  type VideoScript,
} from "../shared/video-script";
import { api, errorMessage } from "./api";
import { Button, Disclosure, Notice, Segmented, StatusDot } from "./primitives";
import { ScriptDiagnostics } from "./ScriptDiagnostics";
import { ScriptFields } from "./ScriptFields";
import { toast } from "./toast-store";
import "./script.css";

const approvedAtLabel = (value: string) =>
  new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

// 이 영상의 대본을 지금 고칠 수 있는가: 승인이 필요한 대본이고, 내레이션이 아직 합성되지 않았고, 작업이 실행 중이 아닐 때.
export function scriptCanEdit(job: Job, number: number): boolean {
  const running = job.status === "running" || job.automation?.status === "running";
  return scriptNeedsApproval(job, number) && !narrationSynthesized(job, number) && !running;
}
// 대본 승인 상태 한 줄(문구는 예전 대본 카드의 배지와 같다). liveHard 는 편집 중인 지금 입력 기준 규칙 위반 수.
export function scriptStatusOf(job: Job, number: number, liveHard?: number): UiState {
  const render = job.renders.find((item) => item.number === number);
  const review = render?.scriptReview ?? null;
  if (scriptApproved(job, number))
    return {
      family: "done",
      label: "승인됨",
      detail: render?.scriptApproval ? approvedAtLabel(render.scriptApproval.approvedAt) : "",
    };
  if (narrationSynthesized(job, number))
    return { family: "idle", label: "내레이션 합성 완료 · 수정 불가", detail: "" };
  if (scriptApprovalMode(job) === "auto" && !scriptNeedsApproval(job, number))
    return { family: "done", label: "자동 진행(AI 검토 통과)", detail: "" };
  const hard = liveHard ?? review?.hardProblems.length ?? 0;
  if (scriptNeedsFix(job, number) && hard > 0)
    return { family: "stopped", label: "규칙 미통과 초안 · 고치거나 다시 쓰기", detail: "" };
  return { family: "yourTurn", label: "당신 차례 · 대본 승인", detail: "" };
}

type Pending = "save" | "approve" | "rewrite" | null;
type View = "script" | "cuts";

// 대본 카드: 읽기 전용 문장 목록 ↔ 컷 설계, 수정 모드에서는 문장·자막 입력과 하단 저장·승인·다시 쓰기 바.
// 저장·승인·다시 쓰기의 API 호출과 규칙 검사는 예전 대본 편집기와 같다.
export function ScriptEditor({
  job,
  script,
  defaultEditing = false,
  rewriteSignal = 0,
  children,
}: {
  readonly job: Job;
  readonly script: VideoScript;
  // 승인 대기 영상은 처음부터 수정 모드(편집기 + 하단 승인 바)로 연다.
  readonly defaultEditing?: boolean;
  // 값이 바뀌면(영상 상세의 ⋯ 메뉴 '대본 다시 쓰기') 수정 모드로 열고 다시 쓰기 입력으로 이동한다.
  readonly rewriteSignal?: number;
  // 카드 맨 아래에 이어 붙는 접힘 행들(제작 소스·렌더 보고 등). 저장 바는 그 뒤에 붙는다.
  readonly children?: ReactNode;
}) {
  const number = script.number;
  const render = job.renders.find((item) => item.number === number);
  const approved = scriptApproved(job, number);
  const synthesized = narrationSynthesized(job, number);
  const running = job.status === "running" || job.automation?.status === "running";
  // 자동 진행 정책이라도 AI 검토를 통과하지 못한(forced) 대본은 승인이 필요하므로 고칠 수 있다.
  const needsApproval = scriptNeedsApproval(job, number);
  const canEdit = scriptCanEdit(job, number);
  const [editing, setEditing] = useState(defaultEditing && canEdit);
  const [view, setView] = useState<View>("script");
  const [voices, setVoices] = useState(() => script.voiceover.map((voice) => voice.text));
  const [captions, setCaptions] = useState(() => script.cuts.map((cut) => cut.onScreenText));
  const [feedback, setFeedback] = useState("");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const rewriteRef = useRef<HTMLDetailsElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  // 다시 마운트돼도(저장·다시 쓰기로 대본 키가 바뀔 때) 이미 처리한 신호로 다시 열지 않는다.
  const handledSignal = useRef(rewriteSignal);
  const editable = canEdit && editing;
  const dirty =
    voices.some((text, index) => text !== script.voiceover[index]?.text) ||
    captions.some((text, index) => text !== script.cuts[index]?.onScreenText);
  const hypothesis = job.creativePlan?.hypotheses.find((item) => item.id === script.hypothesisId);
  const review = render?.scriptReview ?? null;
  const needsFix = review?.accepted === "needsFix";
  const edits = {
    voiceover: voices
      .map((text, index) => ({ index, text }))
      .filter((item) => item.text !== script.voiceover[item.index]?.text),
    captions: captions
      .map((onScreenText, cutIndex) => ({ cutIndex, onScreenText }))
      .filter((item) => item.onScreenText !== script.cuts[item.cutIndex]?.onScreenText),
  };
  const edited = dirty ? applyScriptEdit(script, edits) : script;
  const factIds = new Set(job.creativePlan?.sourceCoverage.factsUsed ?? []);
  const factTexts =
    job.sourceSnapshot?.sources
      .filter((source) => factIds.has(source.id))
      .map((source) => source.content) ?? [];
  const bound = script.voiceover.some((voice) => voice.fromCut >= 0);
  const rules = hypothesis
    ? classifyScriptProblems(edited, {
        number: script.number,
        durationSec: script.durationSec,
        hypothesis,
        hasProjectClips: (job.productionSourceSnapshot?.assets.length ?? 0) > 0,
        infoClipsAllowed: clipModeOf(job) === "flow",
        facts: [...hypothesisFactTexts(hypothesis), ...factTexts],
        ...chainExpectation(job.creativePlan, hypothesis),
      })
    : // 가설이 없는 예전 작업: 내레이션·말과 그림 규칙에 더해 장면 계획 규칙(콜아웃 어절·클립 구간)과
      // 혼합형 규칙(비트별 소스·설명 장면·엔딩; 혼합형이 아니면 빈 결과)도 저장 전에 본다
      {
        hard: [
          ...narrationProblems(edited.voiceover),
          ...(bound ? alignmentProblems(edited) : []),
          ...scenePlanProblems(edited).hard,
          ...hybridProblems(edited).hard,
        ],
        soft: [...scenePlanProblems(edited).soft, ...hybridProblems(edited).soft],
      };
  // 고칠 수 있을 때는 지금 입력 기준(live), 아니면 저장된 기록
  const hardProblems = canEdit ? rules.hard : (review?.hardProblems ?? []);
  const warnings = [
    ...new Set(canEdit && dirty ? rules.soft : [...(review?.warnings ?? []), ...rules.soft]),
  ];
  const base = `jobs/${job.id}/videos/${number}/script`;
  const run = async (kind: "save" | "approve" | "rewrite") => {
    setPending(kind);
    setError(null);
    try {
      if (kind === "save") {
        await api.put(base, {
          json: edits,
        });
        toast("대본을 저장했습니다. 내용을 확인한 뒤 승인해 주세요.");
      } else if (kind === "approve") {
        await api.post(`${base}/approve`, { json: {} });
        setEditing(false);
        toast("대본을 승인했습니다. 모든 영상이 승인되면 제작이 이어집니다.");
      } else {
        await api.post(`${base}/rewrite`, { json: { feedback }, timeout: false });
        setFeedback("");
        setRewriteOpen(false);
        toast("대본을 다시 썼습니다. 내용을 확인한 뒤 승인해 주세요.");
      }
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  // 다시 쓰기 입력이 열린 뒤(커밋 이후)에 그 입력으로 이동·포커스한다.
  const focusAfterOpen = useRef(false);
  const focusRewrite = () => {
    rewriteRef.current?.scrollIntoView({ block: "center" });
    feedbackRef.current?.focus({ preventScroll: true });
  };
  const openRewrite = () => {
    setEditing(true);
    if (rewriteOpen) {
      focusRewrite();
      return;
    }
    focusAfterOpen.current = true;
    setRewriteOpen(true);
  };
  useEffect(() => {
    if (!rewriteOpen || !focusAfterOpen.current) return;
    focusAfterOpen.current = false;
    rewriteRef.current?.scrollIntoView({ block: "center" });
    feedbackRef.current?.focus({ preventScroll: true });
  }, [rewriteOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 신호 값이 바뀔 때만 다시 쓰기 입력을 연다.
  useEffect(() => {
    if (rewriteSignal === handledSignal.current) return;
    handledSignal.current = rewriteSignal;
    if (rewriteSignal > 0 && canEdit) openRewrite();
  }, [rewriteSignal]);
  const status = scriptStatusOf(job, number, canEdit ? hardProblems.length : undefined);
  const barVisible = canEdit && (editing || !approved);
  const urgent = hardProblems.length > 0 || (needsFix && !approved && !synthesized);
  const hasDiagnostics =
    urgent ||
    warnings.length > 0 ||
    (review?.repairs.length ?? 0) > 0 ||
    (review !== null && review.accepted !== "needsFix");
  const diagnostics = (
    <ScriptDiagnostics
      review={review}
      hardProblems={hardProblems}
      warnings={warnings}
      needsFix={needsFix}
      dirty={dirty}
      approvalComplete={approved || synthesized}
    />
  );
  return (
    <section
      className={`script-card ${barVisible ? "has-bar" : ""}`}
      aria-label={`영상 ${number} 대본 확인`}
    >
      <header className="script-card-head">
        <h2>대본</h2>
        <span className="card-sub">
          {script.voiceover.length}문장 · {editable ? "수정 중" : "읽기 전용"}
        </span>
        {status.family !== "yourTurn" && (
          // 내가 승인할 차례는 하단 바가 말한다. 헤더에는 그 밖의 승인 상태만 둔다.
          <span title={status.detail || undefined}>
            <StatusDot state={status} />
          </span>
        )}
        <span className="card-spacer" />
        <Segmented
          label="대본 보기 방식"
          value={view}
          onChange={setView}
          options={[
            { value: "script", label: "대본" },
            {
              value: "cuts",
              label: (
                <>
                  컷 설계 <span className="seg-count">{script.cuts.length}</span>
                </>
              ),
            },
          ]}
        />
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null || (editing && dirty)}
            title={editing && dirty ? "저장하지 않은 수정이 있습니다." : undefined}
            onClick={() => setEditing((value) => !value)}
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
            {editing ? "수정 닫기" : "수정"}
          </Button>
        )}
      </header>
      {hasDiagnostics && urgent && <div className="script-card-notes">{diagnostics}</div>}
      <div className="script-card-body">
        <ScriptFields
          layout={view === "script" ? "lines" : "cuts"}
          script={edited}
          original={script}
          voices={voices}
          captions={captions}
          editable={editable}
          busy={pending !== null}
          onVoiceChange={(index, value) =>
            setVoices((current) => current.map((text, i) => (i === index ? value : text)))
          }
          onCaptionChange={(index, value) =>
            setCaptions((current) => current.map((text, i) => (i === index ? value : text)))
          }
        />
      </div>
      {barVisible && (
        <details
          className="disclosure disclosure-plain rewrite-box"
          ref={rewriteRef}
          open={rewriteOpen}
          onToggle={(event) => setRewriteOpen(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
            다시 쓰기(피드백 입력)
          </summary>
          <div className="disclosure-body stack">
            <p className="muted small-copy">
              적어 둔 요청을 붙여 대본을 다시 생성합니다(텍스트 API 호출 1~3회). 규칙 분류와 AI
              검토를 다시 거치고 승인은 풀립니다. 3회 뒤에도 규칙을 통과하지 못하면 가장 나은 초안을
              저장하고 여기서 고치게 합니다.
            </p>
            <textarea
              ref={feedbackRef}
              className="script-feedback"
              readOnly={pending !== null}
              rows={3}
              value={feedback}
              maxLength={2000}
              placeholder="예) 브랜드 이름을 더 일찍 말하고, 문장을 더 짧게"
              aria-label={`영상 ${number} 다시 쓰기 피드백`}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <div className="cluster">
              <Button
                size="sm"
                disabled={pending !== null || feedback.trim().length === 0}
                pending={pending === "rewrite"}
                onClick={() => {
                  void run("rewrite");
                }}
              >
                <RefreshCw size={14} aria-hidden="true" />
                다시 쓰기
              </Button>
            </div>
          </div>
        </details>
      )}
      {!canEdit && needsApproval && running && (
        <p className="muted small-copy script-card-note">
          작업이 실행 중일 때는 대본을 바꿀 수 없습니다.
        </p>
      )}
      {synthesized && (
        <p className="muted small-copy script-card-note">
          내레이션이 이미 합성된 영상입니다. 대본을 바꾸려면 작업을 초기화한 뒤 다시 시작하세요.
        </p>
      )}
      {error && (
        <div className="script-card-notes">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {hasDiagnostics && !urgent && (
        <div className="card-fold">
          <Disclosure
            variant="plain"
            summary={
              <>
                <span className="fold-title">AI 검토</span>
                <span className="fold-sub">
                  {warnings.length > 0 ? `확인할 점 ${warnings.length}건` : "수정 기록"}
                </span>
              </>
            }
          >
            <div className="stack">{diagnostics}</div>
          </Disclosure>
        </div>
      )}
      {children}
      {barVisible && (
        <fieldset
          className={`script-bar ${status.family === "yourTurn" ? "is-turn" : ""}`}
          aria-label="대본 저장과 승인"
        >
          <span className="script-bar-msg muted small-copy">
            {dirty ? (
              "저장하지 않은 수정이 있습니다."
            ) : hardProblems.length > 0 ? (
              "규칙 위반이 남아 있어 승인할 수 없습니다. 문장·자막을 고치거나 다시 쓰세요."
            ) : status.family === "yourTurn" ? (
              <StatusDot state={status} />
            ) : null}
          </span>
          <Button
            size="sm"
            disabled={pending !== null || !dirty || hardProblems.length > 0}
            pending={pending === "save"}
            onClick={() => {
              void run("save");
            }}
          >
            <Save size={14} aria-hidden="true" />
            저장
          </Button>
          <Button size="sm" variant="ghost" disabled={pending !== null} onClick={openRewrite}>
            <RefreshCw size={14} aria-hidden="true" />
            다시 쓰기…
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending !== null || dirty || approved || hardProblems.length > 0}
            pending={pending === "approve"}
            onClick={() => {
              void run("approve");
            }}
          >
            <FileCheck size={14} aria-hidden="true" />
            {approved ? "승인됨" : "대본 승인"}
          </Button>
        </fieldset>
      )}
    </section>
  );
}
// 저장된 대본이 바뀌면(저장·다시 쓰기·서버 갱신) 편집 상태를 새로 시작하기 위한 키
export function scriptEditorKey(script: VideoScript): string {
  return scriptDigestOf(script);
}
