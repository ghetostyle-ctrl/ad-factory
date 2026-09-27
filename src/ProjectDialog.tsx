import { type FormEvent, useState } from "react";
import { CreateProjectSchema, type Project, ProjectSchema } from "../shared/sources";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

export function ProjectDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (project: Project) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = CreateProjectSchema.safeParse({
      name: data.get("name"),
      description: data.get("description"),
    });
    if (!parsed.success) {
      setError("프로젝트 이름을 2자 이상 입력해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onCreated(ProjectSchema.parse(await api.post("projects", { json: parsed.data }).json()));
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="새 프로젝트"
      description="같은 제품·브랜드의 자료를 모아 여러 광고 작업에 재사용합니다."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="프로젝트 이름">
          <input
            name="name"
            required
            minLength={2}
            maxLength={120}
            placeholder="예: 모닝 텀블러 · 가을 컬렉션"
          />
        </Field>
        <Field label="프로젝트 설명 (선택)">
          <textarea
            name="description"
            maxLength={4000}
            placeholder="어떤 제품이나 브랜드의 자료를 모으나요?"
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            프로젝트 만들기
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
