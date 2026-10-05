import { CircleCheck, CirclePause, FileCheck, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import type { Job } from "../shared/schema";
import {
  narrationSynthesized,
  scriptApprovalMode,
  scriptApproved,
  scriptDigestOf,
  scriptNeedsApproval,
} from "../shared/script-approval";
import { applyScriptEdit } from "../shared/script-edit";
import { classifyScriptProblems } from "../shared/script-rules";
import {
  alignmentProblems,
  hypothesisFactTexts,
  narrationProblems,
  type VideoScript,
} from "../shared/video-script";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";
import { ScriptDiagnostics } from "./ScriptDiagnostics";
import { ScriptFields } from "./ScriptFields";
import "./script.css";

const approvedAtLabel = (value: string) =>
  new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

export function ScriptEditor({ job, script }: { readonly job: Job; readonly script: VideoScript }) {
  const number = script.number;
  const render = job.renders.find((item) => item.number === number);
  const mode = scriptApprovalMode(job);
  const approved = scriptApproved(job, number);
  const synthesized = narrationSynthesized(job, number);
  const running = job.status === "running" || job.automation?.status === "running";
  // 자동 진행 정책이라도 AI 검토를 통과하지 못한(forced) 대본은 승인이 필요하므로 고칠 수 있다.
  const needsApproval = scriptNeedsApproval(job, number);
  const editable = needsApproval && !synthesized && !running;
  const [voices, setVoices] = useState(() => script.voiceover.map((voice) => voice.text));
  const [captions, setCaptions] = useState(() => script.cuts.map((cut) => cut.onScreenText));
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<"save" | "approve" | "rewrite" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        facts: [...hypothesisFactTexts(hypothesis), ...factTexts],
      })
    : {
        hard: [...narrationProblems(edited.voiceover), ...(bound ? alignmentProblems(edited) : [])],
        soft: [],
      };
  // 고칠 수 있을 때는 지금 입력 기준(live), 아니면 저장된 기록
  const hardProblems = editable ? rules.hard : (review?.hardProblems ?? []);
  const warnings = [
    ...new Set(editable && dirty ? rules.soft : [...(review?.warnings ?? []), ...rules.soft]),
  ];
  const base = `jobs/${job.id}/videos/${number}/script`;
  const run = async (kind: "save" | "approve" | "rewrite") => {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === "save") {
        await api.put(base, {
          json: edits,
        });
        setNotice("대본을 저장했습니다. 내용을 확인한 뒤 승인해 주세요.");
      } else if (kind === "approve") {
        await api.post(`${base}/approve`, { json: {} });
        setNotice("대본을 승인했습니다. 모든 영상이 승인되면 제작이 이어집니다.");
      } else {
        await api.post(`${base}/rewrite`, { json: { feedback }, timeout: false });
        setFeedback("");
        setNotice("대본을 다시 썼습니다. 내용을 확인한 뒤 승인해 주세요.");
      }
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  const status = synthesized
    ? { label: "내레이션 합성 완료 · 수정 불가", tone: "neutral", Icon: CircleCheck }
    : mode === "auto" && !needsApproval
      ? { label: "자동 진행(AI 검토 통과)", tone: "neutral", Icon: CircleCheck }
      : approved
        ? {
            label: `승인됨 · ${render?.scriptApproval ? approvedAtLabel(render.scriptApproval.approvedAt) : ""}`,
            tone: "success",
            Icon: CircleCheck,
          }
        : needsFix && hardProblems.length > 0
          ? { label: "규칙 미통과 초안 · 고치거나 다시 쓰기", tone: "danger", Icon: CirclePause }
          : { label: "승인 대기", tone: "warning", Icon: CirclePause };
  return (
    <section className="stack script-panel" aria-label={`영상 ${number} 대본 확인`}>
      <div className="flow-heading">
        <h4>대본 확인</h4>
        <span className={`badge badge-${status.tone}`}>
          <status.Icon size={12} aria-hidden="true" />
          {status.label}
        </span>
      </div>
      <ScriptDiagnostics
        review={review}
        hardProblems={hardProblems}
        warnings={warnings}
        needsFix={needsFix}
        dirty={dirty}
        approvalComplete={approved || synthesized}
      />
      <ScriptFields
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
      {editable && (
        <>
          <div className="cluster">
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
            {dirty && <span className="muted small-copy">저장하지 않은 수정이 있습니다.</span>}
            {!dirty && hardProblems.length > 0 && (
              <span className="muted small-copy">
                규칙 위반이 남아 있어 승인할 수 없습니다. 문장·자막을 고치거나 다시 쓰세요.
              </span>
            )}
          </div>
          <details className="evidence-details">
            <summary>다시 쓰기(피드백 입력)</summary>
            <div className="stack">
              <p className="muted small-copy">
                적어 둔 요청을 붙여 대본을 다시 생성합니다(텍스트 API 호출 1~3회). 규칙 분류와 AI
                검토를 다시 거치고 승인은 풀립니다. 3회 뒤에도 규칙을 통과하지 못하면 가장 나은
                초안을 저장하고 여기서 고치게 합니다.
              </p>
              <textarea
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
        </>
      )}
      {!editable && needsApproval && running && (
        <p className="muted small-copy">작업이 실행 중일 때는 대본을 바꿀 수 없습니다.</p>
      )}
      {synthesized && (
        <p className="muted small-copy">
          내레이션이 이미 합성된 영상입니다. 대본을 바꾸려면 작업을 초기화한 뒤 다시 시작하세요.
        </p>
      )}
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
// 저장된 대본이 바뀌면(저장·다시 쓰기·서버 갱신) 편집 상태를 새로 시작하기 위한 키
export function scriptEditorKey(script: VideoScript): string {
  return scriptDigestOf(script);
}
