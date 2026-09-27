import { Building2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { Account, Job } from "../shared/schema";
import { AccountSelectionSchema, AccountsSchema } from "../shared/schema";
import { api, errorMessage, postJob } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

export function AccountDialog({
  job,
  onClose,
  onSaved,
}: {
  readonly job: Job;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [selected, setSelected] = useState(job.accountId ?? "");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = async () => {
      try {
        setAccounts(AccountsSchema.parse(await api.get("accounts").json()).accounts);
      } catch (cause) {
        setError(await errorMessage(cause));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const pageId = String(data.get("pageId") ?? "").trim();
    const pixelId = String(data.get("pixelId") ?? "").trim();
    const instagramAccountId = String(data.get("instagramAccountId") ?? "").trim();
    const parsed = AccountSelectionSchema.safeParse({
      accountId: selected,
      ...(pageId ? { pageId } : {}),
      ...(pixelId ? { pixelId } : {}),
      ...(instagramAccountId ? { instagramAccountId } : {}),
    });
    if (!parsed.success) {
      setError("계정을 선택하고 ID에는 숫자만 입력해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await postJob(`jobs/${job.id}/account`, parsed.data);
      onSaved();
      onClose();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="광고 계정 선택"
      description="현재 토큰으로 확인된 계정 목록입니다. 이 작업에 사용할 계정을 직접 선택하세요."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {loading ? (
          <Notice>Meta에서 접근 가능한 계정을 확인하고 있습니다.</Notice>
        ) : accounts.length === 0 ? (
          <Notice>표시할 계정이 없습니다. 토큰의 광고 계정 권한을 확인해 주세요.</Notice>
        ) : (
          <fieldset className="account-options">
            <legend className="sr-only">광고 계정</legend>
            {accounts.map((account) => (
              <label
                className={`account-option ${selected === account.id ? "selected" : ""}`}
                key={account.id}
              >
                <input
                  type="radio"
                  name="accountId"
                  value={account.id}
                  checked={selected === account.id}
                  onChange={() => setSelected(account.id)}
                />
                <Building2 size={18} />
                <span>
                  <strong>{account.name}</strong>
                  <small>
                    {account.businessName || "비즈니스 이름 없음"} · {account.currency}
                  </small>
                  <small className="mono">{account.id}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="form-grid">
          <Field label="Facebook 페이지 ID" help="광고 게시에 필요한 페이지 ID입니다.">
            <input
              name="pageId"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={job.selection?.pageId ?? ""}
              placeholder="숫자 ID"
            />
          </Field>
          <Field
            label={job.objective === "sales" ? "픽셀 ID (필수)" : "픽셀 ID (선택)"}
            help={
              job.objective === "sales"
                ? "구매 전환 광고에는 픽셀 ID가 필요합니다."
                : "트래픽 광고에서는 선택 사항입니다."
            }
          >
            <input
              name="pixelId"
              required={job.objective === "sales"}
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={job.selection?.pixelId ?? ""}
              placeholder="숫자 ID"
            />
          </Field>
        </div>
        <Field label="Instagram 계정 ID (선택)">
          <input
            name="instagramAccountId"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={job.selection?.instagramAccountId ?? ""}
            placeholder="숫자 ID"
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!selected || loading}>
            이 계정 사용
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
