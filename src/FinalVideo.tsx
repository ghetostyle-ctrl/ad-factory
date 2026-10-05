import { Download, Film, Music } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { RenderState } from "../shared/render-state";
import type { Job } from "../shared/schema";
import type { VideoScript } from "../shared/video-script";
import { api } from "./api";
import "./render.css";

// 대본 카드의 완성본 섹션: 9:16 플레이어·다운로드·클립 A~H 썸네일·정지 이미지 S1~S14 썸네일·문장별 내레이션·렌더 리포트.
const ReportSchema = z.object({
  measuredDurationMs: z.number(),
  integratedLufs: z.number(),
  truePeakDb: z.number(),
  ffmpegVersion: z.string(),
  bgm: z.object({ id: z.string(), license: z.string() }).nullable(),
  warnings: z.array(z.string()),
});
// 상태 라벨은 "완성 영상 …" 접두 뒤에 붙는다. 완성은 '저장됨'으로 적어 "완성 영상 완성" 중복을 피한다.
export function renderStage(
  render: RenderState | undefined,
  clipCount: number,
  stillCount = 0,
): string {
  if (!render) return "제작 대기";
  if (render.final) return "저장됨";
  const done = Object.values(render.clips).filter((clip) => clip?.name).length;
  if (done > 0 || Object.keys(render.startImages).length > 0) return `클립 ${done}/${clipCount}`;
  const stillsDone = Object.values(render.stills).filter((still) => still?.name).length;
  if (stillCount > 0 && Object.keys(render.stills).length > 0)
    return `정지 이미지 ${stillsDone}/${stillCount}`;
  if (render.voice) return "내레이션 완료";
  return "제작 대기";
}
// 문장별 내레이션은 가장 늦은 시도(템포 재합성이 있으면 attempt 2)의 wav 한 개만 최종본이다.
const VOICE_FILE = /^voice-(\d+)-(\d+)-(\d+)\.wav$/;
export function finalVoices<T extends { readonly kind: string; readonly name: string }>(
  artifacts: readonly T[],
  number: number,
): T[] {
  const latest = new Map<number, { readonly attempt: number; readonly item: T }>();
  for (const item of artifacts) {
    if (item.kind !== "audio") continue;
    const match = VOICE_FILE.exec(item.name);
    if (!match || Number(match[1]) !== number) continue;
    const sentence = Number(match[2]);
    const attempt = Number(match[3]);
    const current = latest.get(sentence);
    if (!current || attempt > current.attempt) latest.set(sentence, { attempt, item });
  }
  return [...latest.entries()].sort(([a], [b]) => a - b).map(([, value]) => value.item);
}
export function FinalVideo({ job, script }: { readonly job: Job; readonly script: VideoScript }) {
  const render = job.renders.find((item) => item.number === script.number);
  const artifact = (name: string | null | undefined) =>
    name ? job.artifacts.find((item) => item.name === name) : undefined;
  const final = artifact(render?.final?.name);
  const report = artifact(`render-report-${script.number}.json`);
  const voices = finalVoices(job.artifacts, script.number);
  const reportUrl = report?.url;
  const [parsed, setParsed] = useState<z.infer<typeof ReportSchema> | null>(null);
  useEffect(() => {
    if (!reportUrl) return;
    const controller = new AbortController();
    void api
      .get(reportUrl.replace(/^\/api\//, ""), { signal: controller.signal })
      .json()
      .then((value) => {
        if (!controller.signal.aborted) {
          const result = ReportSchema.safeParse(value);
          setParsed(result.success ? result.data : null);
        }
      })
      .catch(() => {});
    return () => controller.abort();
    // SSE 상태 갱신마다 새 객체가 생기므로 객체가 아닌 URL 문자열에 의존한다.
  }, [reportUrl]);
  return (
    <div className="stack final-section">
      {final ? (
        <div className="final-video-row">
          <video controls preload="metadata" className="final-video" src={final.url}>
            <track kind="captions" />
          </video>
          <div className="stack">
            <a className="button button-secondary" href={final.url} download={final.name}>
              <Download size={14} aria-hidden="true" />
              완성 영상 다운로드
            </a>
            <dl className="definition-list">
              <div>
                <dt>길이</dt>
                <dd>{((render?.final?.durationMs ?? 0) / 1000).toFixed(1)}초</dd>
              </div>
              {parsed && (
                <>
                  <div>
                    <dt>라우드니스</dt>
                    <dd>
                      {parsed.integratedLufs.toFixed(1)} LUFS · 피크 {parsed.truePeakDb.toFixed(1)}{" "}
                      dBTP
                    </dd>
                  </div>
                  <div>
                    <dt>BGM</dt>
                    <dd>
                      {parsed.bgm
                        ? `${parsed.bgm.id} · ${parsed.bgm.license || "라이선스 미기재"}`
                        : "없음"}
                    </dd>
                  </div>
                  <div>
                    <dt>렌더</dt>
                    <dd className="mono">ffmpeg {parsed.ffmpegVersion}</dd>
                  </div>
                </>
              )}
            </dl>
            {parsed && parsed.warnings.length > 0 && (
              <ul className="muted small-copy final-warnings">
                {parsed.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="muted small-copy">
          <Film size={14} aria-hidden="true" /> 완성 영상{" "}
          {renderStage(render, script.veoClips.length, script.stills.length)}
        </p>
      )}
      {script.stills.length > 0 && (
        <ul className="card-slides clip-grid">
          {script.stills.map((still) => {
            const image = artifact(render?.stills[still.id]?.name);
            return (
              <li key={still.id}>
                {image ? (
                  <img src={image.url} alt={`정지 이미지 ${still.id}`} loading="lazy" />
                ) : (
                  <div className="card-slide-pending">제작 대기</div>
                )}
                <span>
                  정지 이미지 {still.id} · {image ? "완료" : "대기"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {script.veoClips.length > 0 && (
        <ul className="card-slides clip-grid">
          {script.veoClips.map((clip) => {
            const start = artifact(render?.startImages[clip.id]?.name);
            const video = artifact(render?.clips[clip.id]?.name);
            return (
              <li key={clip.id}>
                {video ? (
                  <video preload="metadata" muted className="clip-thumb" src={video.url}>
                    <track kind="captions" />
                  </video>
                ) : start ? (
                  <img src={start.url} alt={`클립 ${clip.id} 시작 이미지`} loading="lazy" />
                ) : (
                  <div className="card-slide-pending">제작 대기</div>
                )}
                <span>
                  클립 {clip.id} · {video ? "완료" : start ? "시작 이미지" : "대기"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {voices.length > 0 && (
        <details className="evidence-details">
          <summary>
            <Music size={14} aria-hidden="true" /> 내레이션 {voices.length}개 듣기
          </summary>
          <ul className="voice-list">
            {voices.map((voice) => (
              <li key={voice.id}>
                <span className="mono">{voice.name}</span>
                <audio controls preload="none" src={voice.url}>
                  <track kind="captions" />
                </audio>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
