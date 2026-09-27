import { Clapperboard, Copy } from "lucide-react";
import { useState } from "react";
import type { Job } from "../shared/schema";
import { Button, Notice } from "./primitives";

const purposes = {
  hook: "후킹",
  problem: "문제",
  solution: "해결 장면",
  proof: "근거",
  cta: "행동 유도",
} as const;
const sources = {
  approved_image: "승인 이미지",
  veo_clip: "Flow 클립",
  project_clip: "프로젝트 영상",
} as const;

export function VideoScripts({ job }: { readonly job: Job }) {
  const [copyResult, setCopyResult] = useState("");
  const count =
    job.automation?.policy.mode === "creative" ? (job.automation.policy.videoCount ?? 0) : 0;
  if (count === 0) return null;
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="cluster">
          <Clapperboard size={18} aria-hidden="true" />
          <h2>
            영상 대본과 컷 설계 · {job.videoScripts.length}/{count}
          </h2>
        </div>
        <p>대본과 컷별 화면·자막·내레이션을 먼저 확정하고 필요한 이미지를 제작합니다.</p>
      </header>
      <div className="panel-body stack">
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
          const clip = job.artifacts.find(
            (item) => item.name === `video-auto-${script.number}.mp4`,
          );
          return (
            <article className="hypothesis-card stack" key={script.number}>
              <div className="hypothesis-heading">
                <span className="hypothesis-number">{script.number}</span>
                <div>
                  <span className="eyebrow">
                    8초 세로 영상 · {clip ? "원본 클립 저장됨" : "대본 완료"}
                  </span>
                  <h3>{script.title}</h3>
                  <p>{concept?.targetAudience ?? script.hypothesisId}</p>
                </div>
              </div>
              <div className="stack">
                {script.cuts.map((cut) => (
                  <section className="source-citation" key={`${cut.startSec}-${cut.endSec}`}>
                    <strong>
                      {cut.startSec}–{cut.endSec}초 · {purposes[cut.purpose]}
                    </strong>
                    <p>화면: {cut.screenComposition}</p>
                    <p>자막: {cut.onScreenText || "없음"}</p>
                    <p>내레이션: {cut.narration || "없음"}</p>
                    <p className="muted small-copy">필요 소스: {sources[cut.source]}</p>
                  </section>
                ))}
              </div>
              <details className="evidence-details">
                <summary>제작 소스 · Flow 지시 · 편집 지시</summary>
                <div className="stack">
                  <p>
                    <strong>시작 이미지:</strong>{" "}
                    {concept?.creative.imagePrompt ?? "연결된 광고안 확인 필요"}
                  </p>
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
              {clip && (
                <a href={clip.url} download={clip.name}>
                  Veo 원본 클립 다운로드
                </a>
              )}
            </article>
          );
        })}
        <Notice>
          {job.artifacts.some((item) => /^video-auto-\d+\.mp4$/.test(item.name))
            ? "생성된 영상 파일은 8초 원본 클립입니다. 컷별 자막·내레이션 합성과 최종 편집본 저장은 아직 연결되지 않았습니다."
            : "대본과 Flow 지시가 준비되었습니다. 영상 파일 생성과 컷별 자막·내레이션 합성, 최종 편집본 저장은 아직 완료되지 않았습니다."}
        </Notice>
      </div>
    </section>
  );
}
