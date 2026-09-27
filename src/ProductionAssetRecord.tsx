import { Download, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ProductionAsset } from "../shared/production-assets";
import { Button, Notice } from "./primitives";

const placementLabels = {
  auto: "AI 판단",
  opening: "도입부",
  middle: "제품 설명",
  ending: "마무리",
} as const;

function targetLabel(targets: ProductionAsset["settings"]["targets"]): string {
  switch (targets.mode) {
    case "all":
      return "영상 10개 전체";
    case "selected":
      return targets.videoNumbers.map((number) => `영상 ${number}`).join(", ");
    default:
      return targets satisfies never;
  }
}

export function ProductionAssetRecord({
  asset,
  onEdit,
  onDelete,
}: {
  readonly asset: ProductionAsset;
  readonly onEdit: (asset: ProductionAsset) => void;
  readonly onDelete: (asset: ProductionAsset) => void;
}) {
  const [previewError, setPreviewError] = useState(false);
  const { settings } = asset;
  const fileUrl = `/api/projects/${asset.projectId}/production-assets/${asset.id}/file`;
  const size =
    asset.bytes >= 1024 * 1024
      ? `${(asset.bytes / (1024 * 1024)).toFixed(1)}MiB`
      : `${Math.ceil(asset.bytes / 1024)}KiB`;
  return (
    <article className="source-record production-record">
      <div className="production-record-layout">
        <div className="stack">
          <video
            className="production-video"
            src={fileUrl}
            controls
            preload="metadata"
            muted={settings.audio === "mute"}
            width={asset.width}
            height={asset.height}
            onError={() => setPreviewError(true)}
            aria-label={`${asset.title} 원본 영상 미리보기`}
          />
          {previewError && (
            <Notice>
              이 브라우저에서 원본을 재생하지 못했습니다. 원본을 다운로드해 확인하세요.
            </Notice>
          )}
          <a className="product-link" href={fileUrl} download={asset.filename}>
            <Download size={14} aria-hidden="true" /> 원본 다운로드
          </a>
        </div>
        <div className="stack production-record-main">
          <div className="spread source-record-heading">
            <div className="stack source-record-title">
              <span className="badge badge-neutral">
                {settings.usage === "required" ? "필수 사용" : "AI 선택"}
              </span>
              <h3>{asset.title}</h3>
            </div>
            <div className="cluster">
              <Button
                variant="ghost"
                onClick={() => onEdit(asset)}
                aria-label={`${asset.title} 설정 수정`}
              >
                <Pencil size={15} aria-hidden="true" /> 설정 수정
              </Button>
              <Button
                variant="ghost"
                onClick={() => onDelete(asset)}
                aria-label={`${asset.title} 삭제`}
              >
                <Trash2 size={15} aria-hidden="true" /> 삭제
              </Button>
            </div>
          </div>
          <p className="muted small-copy">
            {asset.filename} · {size} ·{" "}
            {asset.durationSec.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}초
          </p>
          <dl className="definition-list production-metadata">
            <div>
              <dt>사용 구간</dt>
              <dd>
                {settings.startSec}초 ~{" "}
                {settings.endSec === null ? "끝까지" : `${settings.endSec}초`}
              </dd>
            </div>
            <div>
              <dt>배치</dt>
              <dd>{placementLabels[settings.placement]}</dd>
            </div>
            <div>
              <dt>적용 영상</dt>
              <dd>{targetLabel(settings.targets)}</dd>
            </div>
            <div>
              <dt>원본 오디오</dt>
              <dd>
                {settings.audio === "mute" ? "음소거" : "유지"}
                {asset.hasAudio ? "" : " · 오디오 없음"}
              </dd>
            </div>
          </dl>
          {settings.notes && <p className="source-content">{settings.notes}</p>}
        </div>
      </div>
    </article>
  );
}
