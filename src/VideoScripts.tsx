import { Clapperboard, Copy } from "lucide-react";
import { useState } from "react";
import { clipModeOf } from "../shared/flow-mode";
import type { Job } from "../shared/schema";
import {
  pendingScriptApprovals,
  scriptApprovalMode,
  scriptNeedsFix,
  scriptNeedsFixBanner,
} from "../shared/script-approval";
import { isHybrid } from "../shared/video-script";
import { FinalVideo, renderStage } from "./FinalVideo";
import { FlowPanel } from "./FlowPanel";
import { Button, Notice } from "./primitives";
import { ScriptEditor, scriptEditorKey } from "./ScriptEditor";
import { ScriptSources, visualPolicyLabel } from "./ScriptFields";
import { VideoPlanning } from "./VideoPlanning";

export function VideoScripts({ job }: { readonly job: Job }) {
  const [copyResult, setCopyResult] = useState("");
  const count =
    job.automation?.policy.mode === "creative" ? (job.automation.policy.videoCount ?? 0) : 0;
  if (count === 0) return null;
  const pending = pendingScriptApprovals(job);
  // 3회 생성 뒤에도 규칙을 통과하지 못한 초안: 승인 전에 고치거나 다시 써야 한다
  const needsFix = pending.filter(
    (number) =>
      scriptNeedsFix(job, number) &&
      (job.renders.find((render) => render.number === number)?.scriptReview?.hardProblems.length ??
        0) > 0,
  );
  const waitingForApproval =
    pending.length > 0 && job.automation?.status === "waiting" && job.automation.phase === "script";
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="cluster">
          <Clapperboard size={18} aria-hidden="true" />
          <h2>
            영상 대본과 컷 설계 · {job.videoScripts.length}/{count}
          </h2>
        </div>
        <p>
          {scriptApprovalMode(job) === "auto"
            ? "AI 검토를 통과한 대본은 바로 제작하고, 3회 생성 뒤에도 검토를 통과하지 못한 대본만 승인을 기다립니다."
            : "대본을 확인·수정하고 승인해야 이미지 제작·내레이션 합성 등 유료 제작을 시작합니다."}
        </p>
      </header>
      <div className="panel-body stack">
        {waitingForApproval && (
          <Notice tone="warning">
            영상 대본 {pending.length}개를 확인하고 승인해 주세요(영상 {pending.join(", ")}). 각
            대본의 내레이션 문장과 자막을 고친 뒤 저장하고 승인하면 제작이 자동으로 이어집니다.
            마음에 들지 않으면 피드백을 적어 다시 쓸 수 있습니다.
            {needsFix.length > 0 && (
              <>
                <br />
                영상 {needsFix.join(", ")} 대본은 {scriptNeedsFixBanner}. 남은 규칙 위반이 모두 풀린
                뒤에만 승인할 수 있습니다.
              </>
            )}
          </Notice>
        )}
        {job.videoScripts.length === 0 && (
          <Notice>광고안 기획이 끝나면 영상별 대본과 Flow 제작 지시를 작성합니다.</Notice>
        )}
        {copyResult && (
          <p role="status" className="muted">
            {copyResult}
          </p>
        )}
        {job.videoScripts.map((script) => {
          const concept = job.creativePlan?.hypotheses.find(
            (item) => item.id === script.hypothesisId,
          );
          // 완성본(video-final-<n>.mp4) 우선, 없으면 제작 진행 상태(내레이션·클립)를 보여 준다
          const render = job.renders.find((item) => item.number === script.number);
          const legacyClip = job.artifacts.find(
            (item) => item.name === `video-auto-${script.number}.mp4`,
          );
          // 시각 정책 배지(혼합형·입체 설명). 정책이 없는 예전 대본은 배지 없이 그대로 보인다.
          const policy = visualPolicyLabel(script.planning?.visualPolicy);
          const hybrid = isHybrid(script);
          return (
            <article className="hypothesis-card stack" key={script.number}>
              <div className="hypothesis-heading">
                <span className="hypothesis-number">{script.number}</span>
                <div>
                  <span className="eyebrow">
                    {script.durationSec}초 세로 영상 · 컷 {script.cuts.length}개 · 완성 영상{" "}
                    {renderStage(render, script.veoClips.length, script.stills.length)}
                  </span>
                  <h3>{script.title}</h3>
                  <p>{concept?.targetAudience ?? script.hypothesisId}</p>
                  {policy && (
                    <p>
                      <span className="badge badge-accent">{policy}</span>
                    </p>
                  )}
                </div>
              </div>
              {script.openLoop && (
                <p>
                  <strong>궁금증:</strong> {script.openLoop} · {script.payoffSec}초에 답
                </p>
              )}
              {(script.fixedTitle.length > 0 || script.disclaimer || script.voicePersona) && (
                <div className="stack-tight">
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
                </div>
              )}
              {script.planning && <VideoPlanning planning={script.planning} />}
              <ScriptEditor key={scriptEditorKey(script)} job={job} script={script} />
              <details className="evidence-details">
                <summary>제작 소스 · Flow 지시 · 편집 지시</summary>
                <div className="stack">
                  <p>
                    <strong>대표 이미지(연속성 기준):</strong>{" "}
                    {concept?.creative.imagePrompt ?? "연결된 광고안 확인 필요"}
                  </p>
                  {script.styleAnchor && (
                    <p>
                      <strong>{hybrid ? "실사 시각 기준(styleAnchor):" : "공통 시각 기준:"}</strong>{" "}
                      {script.styleAnchor}
                    </p>
                  )}
                  {/* 설명 세계 기준(혼합형) · 등장 대상 · Veo 클립(구간 계획) · 설명 컷(그래픽 순서 또는 장면) · 정지 이미지 */}
                  <ScriptSources script={script} />
                  <p>
                    <strong>Flow 프롬프트:</strong> {script.flowPrompt}
                  </p>
                  <Button
                    onClick={() => {
                      void navigator.clipboard.writeText(script.flowPrompt).then(
                        () => setCopyResult(`${script.number}번 Flow 프롬프트를 복사했습니다.`),
                        () => setCopyResult("복사하지 못했습니다. 프롬프트를 직접 선택해 주세요."),
                      );
                    }}
                  >
                    <Copy size={15} aria-hidden="true" /> Flow 프롬프트 복사
                  </Button>
                  <p>
                    <strong>편집 지시:</strong> {script.editInstructions}
                  </p>
                </div>
              </details>
              {clipModeOf(job) === "flow" && <FlowPanel job={job} script={script} />}
              <FinalVideo job={job} script={script} />
              {legacyClip && (
                <a href={legacyClip.url} download={legacyClip.name}>
                  예전 Veo 원본 클립 다운로드
                </a>
              )}
            </article>
          );
        })}
        <Notice>
          {job.renders.some((render) => render.final)
            ? "완성 영상은 Typecast 내레이션·자막·BGM(라이브러리가 있을 때)·Veo 클립·AI 정지 이미지·모션그래픽을 ffmpeg로 조립한 30~60초 세로 MP4입니다. 실제 제품 외형·법적 적합성은 사람이 확인하세요."
            : "대본이 승인되면 이미지 제작·검토 후 영상마다 내레이션 합성 → 정지 이미지 → 시작 이미지 → Veo 클립(실사 컷만) → 모션그래픽 → 조립 순서로 완성 영상을 만듭니다."}
        </Notice>
      </div>
    </section>
  );
}
