import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { Job } from "../shared/schema";
import { api, errorMessage } from "./api";
import { Button, Dialog, Notice } from "./primitives";

export function jobDeleteBlocker(job: Job): string | null {
  if (job.status === "running") return "실행 중인 작업은 먼저 중지한 뒤 삭제하세요.";
  if (
    job.automation &&
    ["queued", "running", "waiting", "attention"].includes(job.automation.status)
  )
    return "자동 운영을 중지한 뒤 삭제하세요.";
  if (job.staged) return "Meta에 광고가 준비된 작업은 기록 보존을 위해 삭제할 수 없습니다.";
  return null;
}

export function DeleteJobDialog({
  job,
  onClose,
  onDeleted,
}: {
  readonly job: Job;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = jobDeleteBlocker(job);
  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await api.delete(`jobs/${job.id}`);
      onDeleted();
    } catch (cause) {
      setError(await errorMessage(cause));
      setPending(false);
    }
  };
  return (
    <Dialog
      title="작업을 삭제할까요?"
      description={job.name}
      onClose={onClose}
      closeDisabled={pending}
    >
      <div className="stack">
        {blocker ? (
          <Notice tone="warning">{blocker}</Notice>
        ) : (
          <>
            <p>
              작업 기록과 이 작업의 결과물
              {job.artifacts.length > 0 ? ` ${job.artifacts.length}개` : ""}(문서·이미지·영상)가 이
              PC에서 영구 삭제됩니다. 되돌릴 수 없습니다.
            </p>
            <p className="muted">자료 라이브러리의 제품 자료와 레퍼런스는 그대로 남습니다.</p>
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void remove();
            }}
            disabled={Boolean(blocker)}
            pending={pending}
          >
            <Trash2 size={14} aria-hidden="true" />
            삭제
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
