import {
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  FolderOpen,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { AgentId, Artifact, Job } from "../shared/schema";
import { JobSchema } from "../shared/schema";
import { ArtifactContent } from "./ArtifactContent";
import { agentMeta } from "./agentMeta";
import { api, errorMessage } from "./api";
import { ArtifactProvenance } from "./ModelProvenance";
import { Dialog, Notice } from "./primitives";

export function Artifacts({
  job,
  filter,
  onRefresh,
}: {
  readonly job: Job | null;
  readonly filter: AgentId | null;
  readonly onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => previewRequest.current?.abort(), []);
  const files = job?.artifacts.filter((item) => !filter || item.agentId === filter) ?? [];
  const upload = async (file: File) => {
    if (!job) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("PNG 또는 JPEG 이미지를 선택해 주세요.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("15MB 이하의 이미지를 선택해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      JobSchema.parse(await api.post(`jobs/${job.id}/upload`, { body }).json());
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const openArtifact = async (artifact: Artifact) => {
    previewRequest.current?.abort();
    const request = new AbortController();
    previewRequest.current = request;
    setPreview(artifact);
    setContent(null);
    setPreviewError(null);
    if (artifact.kind === "text" || artifact.kind === "json") {
      try {
        const text = z
          .string()
          .parse(
            await api.get(artifact.url.replace(/^\/api\//, ""), { signal: request.signal }).text(),
          );
        if (!request.signal.aborted && previewRequest.current === request) setContent(text);
      } catch (cause) {
        const message = await errorMessage(cause);
        if (!request.signal.aborted && previewRequest.current === request) setPreviewError(message);
      }
    }
  };
  const closePreview = () => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreview(null);
  };
  return (
    <section className="panel">
      <header className="panel-header spread">
        <div>
          <h2>
            {filter ? `${agentMeta[filter].title} 결과물` : "작업 결과물"}{" "}
            <span className="count-label">{files.length}</span>
          </h2>
          <p>전략 문서, 광고 이미지와 선택한 Veo 영상 클립까지.</p>
        </div>
        {job && !job.sourceSnapshot && (
          <label className={`button button-secondary upload-button ${pending ? "pending" : ""}`}>
            <Upload size={15} />
            <span>{pending ? "업로드 중" : "이미지 업로드 (선택)"}</span>
            <input
              aria-label="이미지 업로드 (선택)"
              type="file"
              accept="image/png,image/jpeg"
              disabled={
                pending ||
                job.status === "running" ||
                Boolean(job.staged) ||
                Boolean(job.automation)
              }
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
        )}
      </header>
      {error && (
        <div className="panel-body">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {files.length === 0 ? (
        <div className="empty-small">
          <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
          <h3>아직 생성된 결과물이 없어요</h3>
          <p>
            {job
              ? "소재 자동 제작을 시작하면 이미지·영상 클립과 문서가 여기에 저장됩니다."
              : "새 작업을 만들면 결과물이 이곳에 모입니다."}
          </p>
        </div>
      ) : (
        <div className="artifact-grid">
          {files.map((artifact) => (
            <article
              className={`artifact-card ${artifact.kind === "image" ? "" : "is-file"}`}
              key={artifact.id}
            >
              <button
                type="button"
                className="artifact-preview"
                onClick={() => {
                  void openArtifact(artifact);
                }}
                aria-label={`${artifact.name} 미리보기`}
              >
                {artifact.kind === "image" ? (
                  <img src={artifact.url} alt={artifact.name} loading="lazy" />
                ) : artifact.kind === "text" ? (
                  <FileText size={20} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <FileIcon size={20} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
              <div className="artifact-info">
                <strong>{artifact.name}</strong>
                <small>
                  {agentMeta[artifact.agentId].title} · {artifact.kind.toUpperCase()}
                </small>
                <a href={artifact.url} download className="artifact-download">
                  <Download size={14} />
                  다운로드
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
      {preview && (
        <Dialog title={preview.name} onClose={closePreview} wide>
          <div className="stack">
            <ArtifactProvenance artifact={preview} />
            {preview.kind === "image" ? (
              <img className="full-preview" src={preview.url} alt={preview.name} />
            ) : preview.kind === "video" ? (
              <video className="full-preview" src={preview.url} controls>
                <track kind="captions" />
              </video>
            ) : previewError ? (
              <Notice tone="error">{previewError}</Notice>
            ) : (
              <ArtifactContent artifact={preview} content={content} />
            )}
            <a
              className="button button-secondary"
              href={preview.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              원본 열기
            </a>
          </div>
        </Dialog>
      )}
    </section>
  );
}
