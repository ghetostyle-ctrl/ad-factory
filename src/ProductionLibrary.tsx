import { Download, Film, RefreshCw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ProductionAsset, ProductionAssetsSchema } from "../shared/production-assets";
import type { Project } from "../shared/sources";
import { api, errorMessage } from "./api";
import { ProductionAssetForm } from "./ProductionAssetForm";
import { ProductionAssetRecord } from "./ProductionAssetRecord";
import { ProductionDeleteDialog } from "./ProductionDeleteDialog";
import { ProductionUpload } from "./ProductionUpload";
import { Button, Notice } from "./primitives";
import "./production.css";

type ProductionModal =
  | { readonly type: "upload" }
  | {
      readonly type: "edit" | "delete";
      readonly id: ProductionAsset["id"];
    }
  | null;

export function ProductionLibrary({ project }: { readonly project: Project }) {
  const [assets, setAssets] = useState<readonly ProductionAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<ProductionModal>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletion = useRef<AbortController | null>(null);
  const projectId = project.id;
  useEffect(() => () => deletion.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .get(`projects/${projectId}/production-assets`, {
        signal: abort.signal,
        searchParams: { refresh: reload },
      })
      .json()
      .then((value) => {
        const result = ProductionAssetsSchema.parse(value);
        if (!abort.signal.aborted) setAssets(result.assets);
      })
      .catch(async (cause: unknown) => {
        const failure =
          cause instanceof Error ? await errorMessage(cause) : "제작 소스를 불러오지 못했습니다.";
        if (!abort.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, reload]);
  const selected =
    modal && "id" in modal ? assets.find((asset) => asset.id === modal.id) : undefined;
  const remove = async (asset: ProductionAsset) => {
    const abort = new AbortController();
    deletion.current = abort;
    setDeleting(true);
    setDeleteError(null);
    setMessage(null);
    try {
      await api
        .delete(`projects/${projectId}/production-assets/${asset.id}`, { signal: abort.signal })
        .json();
      if (!abort.signal.aborted) {
        setAssets((current) => current.filter((item) => item.id !== asset.id));
        setModal((current) =>
          current?.type === "delete" && current.id === asset.id ? null : current,
        );
        setMessage("제작 소스를 삭제했습니다.");
      }
    } catch (cause) {
      const failure =
        cause instanceof Error ? await errorMessage(cause) : "제작 소스를 삭제하지 못했습니다.";
      if (!abort.signal.aborted) setDeleteError(failure);
    } finally {
      if (!abort.signal.aborted) setDeleting(false);
    }
  };
  return (
    <section className="panel">
      <header className="panel-header spread">
        <div>
          <div className="cluster">
            <Film size={18} />
            <h2>{project.name}의 제작 소스</h2>
          </div>
          <p>
            {loading
              ? "저장된 영상을 불러오는 중…"
              : error
                ? "목록을 확인하지 못했습니다."
                : `${assets.length}개 영상 · 이 프로젝트에서만 사용`}
          </p>
        </div>
        <div className="cluster production-actions">
          <Button
            variant="primary"
            disabled={loading || !!error}
            onClick={() => setModal({ type: "upload" })}
          >
            <Upload size={15} />내 영상 업로드
          </Button>
          <Button
            variant="ghost"
            aria-label="제작 소스 새로고침"
            disabled={loading}
            onClick={() => {
              setMessage(null);
              setReload((value) => value + 1);
            }}
          >
            <RefreshCw size={15} />
          </Button>
        </div>
      </header>
      <div className="panel-body stack">
        <Notice>
          제작 소스와 사용 지침은 저장되며, 완성 영상 자동 삽입은 영상 제작 기능 연결 후 적용됩니다.
        </Notice>
        {message && (
          <p className="production-success" role="status">
            {message}
          </p>
        )}
        {deleting && modal?.type !== "delete" && <Notice>제작 소스를 삭제하고 있습니다…</Notice>}
        {deleteError && modal?.type !== "delete" && <Notice tone="error">{deleteError}</Notice>}
        {loading ? (
          <Notice>실제 저장된 파일을 확인하고 있습니다…</Notice>
        ) : error ? (
          <>
            <Notice tone="error">{error}</Notice>
            <div>
              <Button onClick={() => setReload((value) => value + 1)}>
                제작 소스 다시 불러오기
              </Button>
            </div>
          </>
        ) : assets.length ? (
          <div className="spread production-manifest">
            <p className="muted">영상별 사용 지침과 소스 목록을 파일로 받을 수 있습니다.</p>
            <a
              className="button button-secondary"
              href={`/api/projects/${projectId}/production-plan`}
              download
            >
              <Download size={15} />
              제작 지시서 다운로드
            </a>
          </div>
        ) : (
          <div className="empty-small">
            <Film size={20} strokeWidth={1.75} aria-hidden="true" />
            <h3>직접 촬영한 영상을 추가하세요</h3>
            <p>
              제품 시연, 사용 장면, 브랜드 영상을 업로드하고 사용할 구간과 영상 번호를 지정할 수
              있습니다.
            </p>
            <Button variant="primary" onClick={() => setModal({ type: "upload" })}>
              내 영상 업로드
            </Button>
          </div>
        )}
      </div>
      {!loading && !error && assets.length > 0 && (
        <div className="source-ledger">
          {assets.map((asset) => (
            <ProductionAssetRecord
              key={asset.id}
              asset={asset}
              onEdit={(item) => setModal({ type: "edit", id: item.id })}
              onDelete={(item) => {
                setDeleteError(null);
                setModal({ type: "delete", id: item.id });
              }}
            />
          ))}
        </div>
      )}
      {modal?.type === "upload" && (
        <ProductionUpload
          projectId={projectId}
          onClose={() => {
            setModal(null);
            setReload((value) => value + 1);
          }}
          onUploaded={(asset) => {
            setAssets((current) => [...current, asset]);
            setMessage("영상 파일을 저장했습니다. 사용 지침을 설정해 주세요.");
            setModal({ type: "edit", id: asset.id });
          }}
        />
      )}
      {modal?.type === "edit" && selected && (
        <ProductionAssetForm
          key={selected.id}
          asset={selected}
          onClose={() => {
            setModal(null);
            setReload((value) => value + 1);
          }}
          onSaved={(saved) => {
            setAssets((current) => current.map((asset) => (asset.id === saved.id ? saved : asset)));
            setMessage("제작 소스 설정을 저장했습니다.");
            setModal(null);
          }}
        />
      )}
      {modal?.type === "delete" && selected && (
        <ProductionDeleteDialog
          asset={selected}
          deleting={deleting}
          error={deleteError}
          onClose={() => setModal(null)}
          onDelete={(asset) => {
            void remove(asset);
          }}
        />
      )}
    </section>
  );
}
