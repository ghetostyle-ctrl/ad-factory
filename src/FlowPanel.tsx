import { Copy, Download, ExternalLink, Upload } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import {
  buildFlowExport,
  FLOW_CLIP_MAX_BYTES,
  FLOW_URL,
  flowExportName,
  pendingFlowClips,
} from "../shared/flow-mode";
import type { ClipId } from "../shared/render-state";
import type { Job } from "../shared/schema";
import type { VideoScript } from "../shared/video-script";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";
import "./flow.css";

// Flow 모드 대본 카드 섹션: 클립 A~D 마다 시작 이미지·Veo 프롬프트·업로드 상태. 클립은 사용자(또는 브라우저 에이전트)가
// Google Flow 웹에서 만들어 이 화면이나 `bun run flow import` 로 올린다. Flow 화면 조작은 앱이 하지 않는다.
type ClipUi = { readonly pending: boolean; readonly error: string | null };
const idle: ClipUi = { pending: false, error: null };

export function FlowPanel({ job, script }: { readonly job: Job; readonly script: VideoScript }) {
  const [ui, setUi] = useState<Partial<Record<ClipId, ClipUi>>>({});
  const [copied, setCopied] = useState<string | null>(null);
  if (script.veoClips.length === 0) return null;
  const number = script.number;
  const render = job.renders.find((item) => item.number === number);
  const hasFinal = Boolean(render?.final);
  const running = job.status === "running" || job.automation?.status === "running";
  const data = buildFlowExport(job, number);
  const exportMarkdown = job.artifacts.find((item) => item.name === flowExportName(number, "md"));
  const pending = pendingFlowClips(job, number);
  const artifact = (name: string | null | undefined) =>
    name ? job.artifacts.find((item) => item.name === name) : undefined;
  const patch = (id: ClipId, value: ClipUi) => setUi((current) => ({ ...current, [id]: value }));
  const upload = async (id: ClipId, file: File) => {
    if (file.size > FLOW_CLIP_MAX_BYTES) {
      patch(id, { pending: false, error: "클립 파일은 200MB 이하여야 합니다." });
      return;
    }
    patch(id, { pending: true, error: null });
    try {
      await api.post(`jobs/${job.id}/videos/${number}/clips/${id}`, {
        body: file,
        headers: { "Content-Type": "video/mp4" },
        timeout: false,
      });
      patch(id, idle);
    } catch (cause) {
      patch(id, { pending: false, error: await errorMessage(cause) });
    }
  };
  const copy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => setCopied(id),
      () => setCopied(null),
    );
  };
  return (
    <section className="stack final-section flow-panel" aria-label={`영상 ${number} Flow 클립`}>
      <div className="flow-heading">
        <h4>
          Google Flow 클립 · {script.veoClips.length - pending.length}/{script.veoClips.length}
        </h4>
        <a href={FLOW_URL} target="_blank" rel="noreferrer" className="flow-link">
          Flow 열기
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
      {pending.length > 0 ? (
        <Notice tone="warning">
          클립 {pending.length}개를 Flow에서 만들어 업로드해 주세요. 시작 이미지를 첫 프레임으로
          올리고 프롬프트를 그대로 붙여 넣은 뒤, 9:16·8초로 생성해 내려받은 MP4를 아래에 올리면
          제작이 자동으로 이어집니다.
        </Notice>
      ) : (
        <p className="muted small-copy">이 영상의 Flow 클립이 모두 올라왔습니다.</p>
      )}
      <p className="muted small-copy">
        Flow 화면 조작 순서는 실제 화면에서 확인된 적이 없어 미검증입니다. 절차는 FLOW-MODE.md,
        내보내기 파일은{" "}
        {exportMarkdown ? (
          <a href={exportMarkdown.url} target="_blank" rel="noreferrer">
            {exportMarkdown.name}
          </a>
        ) : (
          "시작 이미지가 만들어진 뒤 생성됩니다"
        )}
        를 보세요.
      </p>
      <ul className="flow-clips">
        {data.clips.map((clip) => {
          const state = render?.clips[clip.id];
          const video = artifact(state?.name);
          const start = artifact(render?.startImages[clip.id]?.name);
          const status = ui[clip.id] ?? idle;
          const canReplace = Boolean(video) && !hasFinal && !running;
          const canUpload = !hasFinal && (!video || canReplace);
          return (
            <FlowClipCard
              key={clip.id}
              id={clip.id}
              prompt={clip.prompt}
              model={clip.suggestedModel}
              outputFile={clip.outputFile}
              startImageFile={clip.startImageFile}
              startUrl={start?.url ?? null}
              videoUrl={video?.url ?? null}
              attempts={state?.attempts ?? 0}
              status={status}
              canUpload={canUpload}
              copied={copied === clip.id}
              onCopy={() => copy(clip.id, clip.prompt)}
              onUpload={(file) => {
                void upload(clip.id, file);
              }}
            />
          );
        })}
      </ul>
      <details className="evidence-details">
        <summary>명령줄로 내보내기·업로드</summary>
        <div className="stack">
          <p className="mono small-copy">
            bun run flow export {job.id} {number}
          </p>
          <p className="mono small-copy">
            bun run flow import {job.id} {number} A &lt;내려받은-파일-경로&gt;
          </p>
        </div>
      </details>
    </section>
  );
}

function FlowClipCard({
  id,
  prompt,
  model,
  outputFile,
  startImageFile,
  startUrl,
  videoUrl,
  attempts,
  status,
  canUpload,
  copied,
  onCopy,
  onUpload,
}: {
  readonly id: ClipId;
  readonly prompt: string;
  readonly model: string;
  readonly outputFile: string;
  readonly startImageFile: string;
  readonly startUrl: string | null;
  readonly videoUrl: string | null;
  readonly attempts: number;
  readonly status: ClipUi;
  readonly canUpload: boolean;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onUpload: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const label = status.error ? "검증 실패" : videoUrl ? `업로드됨 · ${attempts}번째` : "대기";
  const tone = status.error ? "danger" : videoUrl ? "success" : "neutral";
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files.item(0);
    if (file && canUpload && !status.pending) onUpload(file);
  };
  return (
    <li className="flow-clip">
      <div className="flow-thumb">
        {videoUrl ? (
          <video preload="metadata" muted controls src={videoUrl}>
            <track kind="captions" />
          </video>
        ) : startUrl ? (
          <img src={startUrl} alt={`클립 ${id} 시작 이미지`} loading="lazy" />
        ) : (
          <div className="card-slide-pending">시작 이미지 대기</div>
        )}
      </div>
      <div className="stack flow-body">
        <div className="flow-clip-heading">
          <strong>클립 {id}</strong>
          <span className={`badge badge-${tone}`}>{label}</span>
        </div>
        <p className="muted small-copy">
          {model} · 9:16 · 8초 · 내려받을 파일 이름 {outputFile}
        </p>
        <pre className="flow-prompt">{prompt}</pre>
        <div className="cluster">
          <Button size="sm" onClick={onCopy}>
            <Copy size={14} aria-hidden="true" />
            {copied ? "복사됨" : "프롬프트 복사"}
          </Button>
          {startUrl && (
            <a
              className="button button-secondary button-sm"
              href={startUrl}
              download={startImageFile}
            >
              <Download size={14} aria-hidden="true" />
              시작 이미지 받기
            </a>
          )}
        </div>
        {status.error && <Notice tone="error">검증 실패: {status.error}</Notice>}
        {canUpload && (
          // biome-ignore lint/a11y/noStaticElementInteractions: 끌어다 놓기는 보조 입력이고, 같은 기능을 아래 버튼이 키보드로 제공한다.
          <div
            className={`flow-drop${over ? " flow-drop-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            <input
              ref={input}
              type="file"
              accept="video/mp4,.mp4"
              className="sr-only"
              aria-label={`클립 ${id} MP4 파일 선택`}
              onChange={(event) => {
                const file = event.target.files?.item(0);
                event.target.value = "";
                if (file) onUpload(file);
              }}
            />
            <Button
              size="sm"
              variant={videoUrl ? "secondary" : "primary"}
              pending={status.pending}
              onClick={() => input.current?.click()}
            >
              <Upload size={14} aria-hidden="true" />
              {videoUrl ? "다시 올리기" : "클립 올리기"}
            </Button>
            <span className="muted small-copy">
              MP4를 끌어다 놓거나 선택 · 세로 · 8초 권장(컷이 읽는 길이 이상) · 200MB 이하
            </span>
          </div>
        )}
      </div>
    </li>
  );
}
