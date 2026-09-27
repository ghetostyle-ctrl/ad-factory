import type { ProductionAsset } from "../shared/production-assets";
import { Button, Dialog, Notice } from "./primitives";

export function ProductionDeleteDialog({
  asset,
  deleting,
  error,
  onClose,
  onDelete,
}: {
  readonly asset: ProductionAsset;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onDelete: (asset: ProductionAsset) => void;
}) {
  return (
    <Dialog title="제작 소스 삭제" onClose={onClose} closeDisabled={deleting}>
      <div className="stack">
        <p>
          <strong>{asset.title}</strong>을 이 프로젝트의 제작 소스에서 삭제할까요?
        </p>
        <p className="muted">이후 만드는 작업과 제작 지시서에서 제외됩니다.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={deleting}>
            취소
          </Button>
          <Button
            variant="danger"
            pending={deleting}
            onClick={() => {
              onDelete(asset);
            }}
          >
            {deleting ? "삭제 중…" : "제작 소스 삭제"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
