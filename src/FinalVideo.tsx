import { Music, Play } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import type { RenderState } from "../shared/render-state";
import type { Artifact, Job } from "../shared/schema";
import type { VideoScript } from "../shared/video-script";
import { api } from "./api";
import "./render.css";

// 영상 상세(VideoDetail)가 쓰는 완성본 보조 조각: 렌더 보고 파싱, 클립·정지 이미지 격자, 문장별 내레이션.
// 플레이어·다운로드·길이·소리 크기 요약은 VideoDetail 이 맡고, 여기에는 원값(LUFS·dBTP·ffmpeg)을 읽는 쪽만 남긴다.
const ReportSchema = z.object({
  measuredDurationMs: z.number(),
  integratedLufs: z.number(),
  truePeakDb: z.number(),
  ffmpegVersion: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  bgm: z.object({ id: z.string(), license: z.string() }).nullable(),
  warnings: z.array(z.string()),
});
export type RenderReport = z.infer<typeof ReportSchema>;

// 렌더 보고의 상투 안내(라벨 앵커 계획 좌표·BGM 없음)는 매번 같아서 '확인할 점'과 섞지 않고 접어 둔다.
const ROUTINE_WARNINGS = [/HyperFrames 03 라벨 합성/u, /BGM 라이브러리가 비어/u] as const;
export function routineWarning(text: string): boolean {
  return ROUTINE_WARNINGS.some((pattern) => pattern.test(text));
}
export function reportChecks(report: RenderReport | null | undefined): {
  readonly checks: readonly string[];
  readonly routine: readonly string[];
} {
  const warnings = report?.warnings ?? [];
  return {
    checks: warnings.filter((text) => !routineWarning(text)),
    routine: warnings.filter(routineWarning),
  };
}
// 소리 크기: 목표 -14 LUFS 안팎(-16~-12)이면 정상. 원값은 렌더 보고 Disclosure 안에서만 보인다.
export function loudnessOk(report: RenderReport): boolean {
  return report.integratedLufs >= -16 && report.integratedLufs <= -12;
}

// 렌더 보고 저장소: 같은 보고를 목록·상세가 함께 읽는다. 다시 조립하면 digest 가 바뀌어 새로 받는다.
type ReportEntry = RenderReport | "missing";
const reportCache = new Map<string, ReportEntry>();
const reportLoading = new Set<string>();
const reportListeners = new Set<() => void>();
let reportVersion = 0;
const reportKey = (url: string, digest: string) => `${url}|${digest}`;
function loadReport(url: string, digest: string) {
  const key = reportKey(url, digest);
  if (reportCache.has(key) || reportLoading.has(key)) return;
  reportLoading.add(key);
  void api
    .get(url.replace(/^\/api\//, ""), { searchParams: { v: digest } })
    .json()
    .then((value) => {
      const result = ReportSchema.safeParse(value);
      reportCache.set(key, result.success ? result.data : "missing");
    })
    .catch(() => {
      reportCache.set(key, "missing");
    })
    .finally(() => {
      reportLoading.delete(key);
      reportVersion += 1;
      for (const listener of reportListeners) listener();
    });
}
function subscribeReports(listener: () => void) {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
}
const reportSnapshot = () => reportVersion;
// 완성본이 있는 영상들의 렌더 보고(없거나 읽지 못하면 null). 인자는 문자열 배열이라 SSE 갱신마다 다시 받지 않는다.
export function useRenderReports(
  sources: readonly { readonly url: string; readonly digest: string }[],
): (RenderReport | null)[] {
  useSyncExternalStore(subscribeReports, reportSnapshot, reportSnapshot);
  const signature = sources.map((source) => reportKey(source.url, source.digest)).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature 가 sources 를 문자열로 요약한다.
  useEffect(() => {
    for (const source of sources) loadReport(source.url, source.digest);
  }, [signature]);
  return sources.map((source) => {
    const entry = reportCache.get(reportKey(source.url, source.digest));
    return entry === undefined || entry === "missing" ? null : entry;
  });
}
export function useRenderReport(
  report: Artifact | undefined,
  digest: string | undefined,
): RenderReport | null {
  const sources = useMemo(
    () => (report && digest ? [{ url: report.url, digest }] : []),
    [report, digest],
  );
  const [first] = useRenderReports(sources);
  return first ?? null;
}

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

// 클립·정지 이미지 격자. 영상 재생기를 늘리지 않으려고 클립은 시작 이미지 + '재생' 링크(새 탭)로 보여 준다.
export function ClipStillGrid({
  job,
  script,
}: {
  readonly job: Job;
  readonly script: VideoScript;
}) {
  const render = job.renders.find((item) => item.number === script.number);
  const artifact = (name: string | null | undefined) =>
    name ? job.artifacts.find((item) => item.name === name) : undefined;
  if (script.stills.length === 0 && script.veoClips.length === 0 && script.infoClips.length === 0)
    return null;
  return (
    <div className="stack-tight clip-grid-wrap">
      {script.veoClips.length > 0 && (
        <ul className="clip-grid">
          {script.veoClips.map((clip) => {
            const start = artifact(render?.startImages[clip.id]?.name);
            const video = artifact(render?.clips[clip.id]?.name);
            return (
              <li key={clip.id}>
                {start ? (
                  <img src={start.url} alt={`클립 ${clip.id} 시작 이미지`} loading="lazy" />
                ) : (
                  <div className="card-slide-pending">제작 대기</div>
                )}
                <span className="clip-grid-label">
                  클립 {clip.id} · {video ? "완료" : start ? "시작 이미지" : "대기"}
                </span>
                {video && (
                  <a
                    className="clip-play"
                    href={video.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`클립 ${clip.id} 새 탭에서 재생`}
                  >
                    <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    재생
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {script.infoClips.length > 0 && (
        <ul className="clip-grid">
          {script.infoClips.map((clip) => {
            const image = artifact(render?.infoImages[clip.id]?.info);
            const video = artifact(render?.clips[clip.id]?.name);
            return (
              <li key={clip.id}>
                {image ? (
                  <img
                    src={image.url}
                    alt={`설명 컷 ${clip.id.slice(1)} 설명 장면`}
                    loading="lazy"
                  />
                ) : (
                  <div className="card-slide-pending">제작 대기</div>
                )}
                <span className="clip-grid-label">
                  설명 컷 {clip.id.slice(1)} · {video ? "완료" : image ? "설명 장면" : "대기"}
                </span>
                {video && (
                  <a
                    className="clip-play"
                    href={video.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`설명 컷 ${clip.id.slice(1)} 새 탭에서 재생`}
                  >
                    <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    재생
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {script.stills.length > 0 && (
        <ul className="clip-grid">
          {script.stills.map((still) => {
            const image = artifact(render?.stills[still.id]?.name);
            return (
              <li key={still.id}>
                {image ? (
                  <img src={image.url} alt={`정지 이미지 ${still.id}`} loading="lazy" />
                ) : (
                  <div className="card-slide-pending">제작 대기</div>
                )}
                <span className="clip-grid-label">
                  정지 이미지 {still.id} · {image ? "완료" : "대기"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// 문장별 내레이션 듣기: 열었을 때만 <audio> 를 마운트한다(닫으면 해제 → 재생도 멈춘다). 영상 한 편에 음성 수십 개가 한꺼번에 뜨지 않게.
export function NarrationDisclosure({
  voices,
}: {
  readonly voices: readonly { readonly id: string; readonly name: string; readonly url: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (voices.length === 0) return null;
  return (
    <details
      className="disclosure disclosure-plain narration-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Music size={14} strokeWidth={1.75} aria-hidden="true" />
        내레이션 {voices.length}개 듣기
      </summary>
      {open && (
        <ul className="voice-list disclosure-body">
          {voices.map((voice, index) => (
            <li key={voice.id}>
              <span className="voice-no">{index + 1}번째 문장</span>
              {/* biome-ignore lint/a11y/useMediaCaption: 내레이션 음성은 위 대본 문장이 곧 자막이라 별도 텍스트 트랙이 없다. */}
              <audio controls preload="none" src={voice.url} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
