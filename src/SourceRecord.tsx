import { ExternalLink, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { type MediaAsset, MediaAssetsSchema } from "../shared/media-assets";
import { type SourceFile, SourceFilesSchema } from "../shared/source-files";
import type { ProjectSource } from "../shared/sources";
import { api } from "./api";
import { MediaAnalysisCard } from "./MediaAnalysisCard";
import { Button } from "./primitives";
import { sourceKinds } from "./SourceForm";

export function SourceRecord({
  source,
  onEdit,
  projectId,
  at,
}: {
  readonly source: ProjectSource;
  readonly onEdit?: (source: ProjectSource) => void;
  readonly projectId?: string;
  readonly at?: string;
}) {
  const [assets, setAssets] = useState<readonly MediaAsset[]>([]);
  const [files, setFiles] = useState<readonly SourceFile[]>([]);
  useEffect(() => {
    if (!projectId || !source.referenceData?.media.some((media) => media.kind !== "preview"))
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const result = MediaAssetsSchema.parse(
          await api.get(`projects/${projectId}/sources/${source.id}/media`).json(),
        );
        if (!active) return;
        setAssets(result.assets);
        if (result.assets.some((asset) => asset.status === "pending"))
          timer = setTimeout(() => void load(), 2000);
      } catch {
        if (active) setAssets([]);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, source.id, source.referenceData]);
  useEffect(() => {
    if (!projectId || (source.kind !== "product_fact" && source.kind !== "offer")) return;
    let active = true;
    const load = async () => {
      try {
        const result = SourceFilesSchema.parse(
          await api.get(`projects/${projectId}/sources/${source.id}/files`).json(),
        );
        if (active) setFiles(result.files);
      } catch {
        if (active) setFiles([]);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [projectId, source.id, source.kind]);
  const expired =
    source.expiresAt !== null && Date.parse(source.expiresAt) <= (at ? Date.parse(at) : Date.now());
  const usable = source.status === "eligible" && !expired && source.contentStatus === "content";
  const origin = { user: "직접 등록", success_ai: "Success AI", link_copy: "링크 복사" }[
    source.provenance.origin
  ];
  return (
    <article className="source-record">
      <div className="spread source-record-heading">
        <div className="stack source-record-title">
          <div className="cluster">
            <span className="eyebrow">{sourceKinds[source.kind]}</span>
            <span className={`badge badge-${usable ? "neutral" : "warning"}`}>
              {source.status === "inactive"
                ? "사용 안 함"
                : expired
                  ? "기한 만료"
                  : source.contentStatus === "metadata_only"
                    ? "링크만 보관 · 분석 안 됨"
                    : "본문 사용 가능"}
            </span>
          </div>
          <h3>{source.title}</h3>
        </div>
        {onEdit && (
          <Button
            variant="ghost"
            aria-label={`${source.title} 수정`}
            onClick={() => onEdit(source)}
          >
            <Pencil size={15} />
            수정
          </Button>
        )}
      </div>
      <p className="muted small-copy">
        {source.evidence === "observed" ? "등록된 관측 내용" : "검증 전 가설"} · {origin} · 버전{" "}
        {source.revision}
      </p>
      <details className="source-details">
        <summary>내용과 출처 보기</summary>
        <div className="stack">
          <p className="source-content">
            {source.content ||
              "본문이 없습니다. 이 링크의 광고 내용이나 성과를 확인한 것으로 취급하지 않습니다."}
          </p>
          {source.url && (
            <a className="product-link" href={source.url} target="_blank" rel="noreferrer">
              출처 열기 <ExternalLink size={13} />
            </a>
          )}
          {projectId && files.length > 0 && (
            <div className="stack">
              <strong>상품 상세 이미지 파일</strong>
              {files.map((file) => (
                <a
                  key={file.id}
                  className="product-link"
                  href={`/api/projects/${projectId}/sources/${source.id}/files/${file.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {file.filename} · {Math.round(file.bytes / 1024)}KB <ExternalLink size={13} />
                </a>
              ))}
            </div>
          )}
          {source.referenceData && (
            <>
              <p className="muted small-copy">
                {source.referenceData.brand} · {source.referenceData.platform.toUpperCase()} ·
                미디어 링크 {source.referenceData.media.length}개 · 전사 구간{" "}
                {source.referenceData.transcriptSegments.length}개
              </p>
              {source.referenceData.observations.length > 0 && (
                <dl className="definition-list operation-definition">
                  {source.referenceData.observations.map((observation) => (
                    <div key={`${observation.name}-${observation.source}`}>
                      <dt>{observation.name}</dt>
                      <dd>
                        {observation.value}
                        <br />
                        <small className="muted">
                          {observation.source} ·{" "}
                          {observation.observedAt
                            ? new Date(observation.observedAt).toLocaleString("ko-KR")
                            : "관측 시각 없음"}
                        </small>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {source.referenceData.media.map((media) => (
                <a
                  key={`${media.kind}-${media.url}`}
                  href={media.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {media.kind} 원본 링크
                </a>
              ))}
              {projectId && assets.length > 0 && (
                <div className="stack">
                  <strong>프로젝트에 저장한 미디어 파일</strong>
                  {assets.map((asset) => (
                    <div key={asset.id} className="stack">
                      <p className="small-copy">
                        {asset.kind === "video" ? "영상" : "이미지"} ·{" "}
                        {asset.status === "pending" ? (
                          "다운로드 중"
                        ) : asset.status === "error" ? (
                          `다운로드 실패: ${asset.error}`
                        ) : (
                          <a
                            href={`/api/projects/${projectId}/sources/${source.id}/media/${asset.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            저장된 파일 열기 · {Math.round((asset.bytes ?? 0) / 1024)}KB
                          </a>
                        )}
                      </p>
                      {asset.status === "ready" && (
                        <MediaAnalysisCard
                          projectId={projectId}
                          sourceId={source.id}
                          asset={asset}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className="muted small-copy">
                공개 메타데이터와 저장된 텍스트입니다. 광고비·전환 성과나 링크 속 영상 시청을
                증명하지 않습니다.
              </p>
            </>
          )}
          <p className="muted small-copy">
            등록 {new Date(source.createdAt).toLocaleString("ko-KR")}
            {source.provenance.capturedAt &&
              ` · 원본 수집 ${new Date(source.provenance.capturedAt).toLocaleString("ko-KR")}`}
            {source.expiresAt &&
              ` · 유효 기한 ${new Date(source.expiresAt).toLocaleString("ko-KR")}`}
          </p>
          <p className="mono digest">자료 ID {source.id}</p>
        </div>
      </details>
    </article>
  );
}
