import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  PRODUCTION_ASSET_MAX_BYTES,
  type ProductionAsset,
  ProductionAssetSchema,
} from "../shared/production-assets";
import type { ProjectId } from "../shared/sources";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

export function ProductionUpload({
  projectId,
  onClose,
  onUploaded,
}: {
  readonly projectId: ProjectId;
  readonly onClose: () => void;
  readonly onUploaded: (asset: ProductionAsset) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("업로드할 영상 파일을 선택해 주세요.");
      return;
    }
    if (file.size > PRODUCTION_ASSET_MAX_BYTES) {
      setError("영상 한 개의 크기는 200 MiB 이하여야 합니다.");
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setError(null);
    try {
      const response = await api
        .post(`projects/${projectId}/production-assets`, {
          body: data,
          signal: abort.signal,
          timeout: 120000,
        })
        .json();
      const asset = ProductionAssetSchema.parse(response);
      if (!abort.signal.aborted) onUploaded(asset);
    } catch (cause) {
      const message =
        cause instanceof Error ? await errorMessage(cause) : "영상 파일을 저장하지 못했습니다.";
      if (!abort.signal.aborted) setError(message);
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  };
  return (
    <Dialog title="제작 영상 업로드" onClose={onClose} closeDisabled={pending}>
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="내 영상 파일" help="MP4, MOV, WebM · 파일당 최대 200 MiB">
          <input
            name="file"
            type="file"
            accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
            required
            disabled={pending}
          />
        </Field>
        <p className="muted">
          업로드 후 사용 구간과 배치 위치를 설정합니다. 기본값은 필수 사용 · 영상 10개 전체 · 원본
          음소거입니다.
        </p>
        {pending && (
          <Notice>
            파일을 저장하고 영상 정보를 확인하고 있습니다. 파일 크기에 따라 잠시 걸릴 수 있습니다.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            {pending ? "업로드 중…" : "영상 업로드"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
