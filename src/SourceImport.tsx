import { type ChangeEvent, useState } from "react";
import {
  ImportSourcesSchema,
  type Project,
  type ProjectId,
  SourceImportResultSchema,
  SuccessAiExportSchema,
  SuccessAiPreviewSchema,
} from "../shared/sources";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";
import { sourceKinds } from "./SourceForm";

export function SourceImport({
  projectId,
  projects,
  onProjectSelect,
  initialKeyword,
  onClose,
  onSaved,
}: {
  readonly projectId: ProjectId;
  readonly projects?: readonly Project[];
  readonly onProjectSelect?: (id: ProjectId) => void;
  readonly initialKeyword?: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof ImportSourcesSchema.parse> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState("meta");
  const [keyword, setKeyword] = useState(initialKeyword ?? "");
  const [chosen, setChosen] = useState<readonly number[]>([]);
  const chosenIndices = new Set(chosen);
  const [rowKeys, setRowKeys] = useState<readonly string[]>([]);
  const localPreview = async () => {
    const request = SuccessAiPreviewSchema.safeParse({ platform, keyword, limit: 20 });
    if (!request.success) {
      setError("Success AI에 저장된 정확한 브랜드·검색어를 입력해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    setPreview(null);
    try {
      const result = SuccessAiExportSchema.parse(
        await api.post(`projects/${projectId}/success-ai-preview`, { json: request.data }).json(),
      );
      setPreview(result);
      setRowKeys(result.items.map(() => crypto.randomUUID()));
      setChosen(result.items.map((_, index) => index));
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const inspect = () => {
    try {
      const parsed = ImportSourcesSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        setError(`가져오기 형식을 확인해 주세요: ${parsed.error.issues[0]?.message}`);
        return;
      }
      setPreview(parsed.data);
      setRowKeys(parsed.data.items.map(() => crypto.randomUUID()));
      setChosen(parsed.data.items.map((_, index) => index));
      setError(null);
    } catch (cause) {
      if (cause instanceof SyntaxError)
        setError("JSON을 읽을 수 없습니다. 내보낸 파일 전체를 선택하거나 붙여넣어 주세요.");
      else throw cause;
    }
  };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setPreview(null);
    if (file.size > 2_000_000) {
      setError("2MB 이하의 JSON 파일을 선택해 주세요.");
      return;
    }
    try {
      setText(await file.text());
      setError(null);
    } catch (cause) {
      setError(await errorMessage(cause));
    }
  };
  const save = async () => {
    if (!preview || !chosen.length) return;
    setPending(true);
    setError(null);
    try {
      const batch = ImportSourcesSchema.parse({
        ...preview,
        items: preview.items.filter((_, index) => chosenIndices.has(index)),
      });
      SourceImportResultSchema.parse(
        await api.post(`projects/${projectId}/import`, { json: batch }).json(),
      );
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
      title="Success AI 자료 가져오기"
      description="이 컴퓨터의 Success AI에 저장된 광고를 찾아 선택합니다."
      onClose={onClose}
      wide
    >
      <div className="stack">
        {projects && projects.length > 1 && onProjectSelect && (
          <Field label="레퍼런스를 저장할 프로젝트">
            <select
              value={projectId}
              onChange={(event) => {
                const selected = projects.find((project) => project.id === event.target.value);
                if (selected) onProjectSelect(selected.id);
              }}
              disabled={pending}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Notice>
          이미 저장된 광고를 최대 20개까지 확인합니다. 새 수집을 실행하지 않습니다. 본문이 없는
          링크는 참고 링크로 보관되며 분석 근거가 되지 않습니다.
        </Notice>
        <div className="form-grid">
          <Field label="광고 플랫폼">
            <select
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setPreview(null);
              }}
              disabled={pending}
            >
              <option value="meta">Meta 광고</option>
              <option value="google">Google 광고</option>
            </select>
          </Field>
          <Field
            label="Success AI에 저장된 브랜드·검색어"
            help="저장할 때 사용한 이름과 정확히 일치해야 합니다."
          >
            <input
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value);
                setPreview(null);
              }}
              maxLength={120}
              placeholder="예: 나이키"
              disabled={pending}
            />
          </Field>
        </div>
        <Button
          pending={pending}
          disabled={!keyword.trim()}
          onClick={() => {
            void localPreview();
          }}
        >
          저장된 광고 불러오기
        </Button>
        <details className="evidence-details">
          <summary>JSON 파일·붙여넣기로 가져오기</summary>
          <div className="stack">
            <Field label="JSON 파일 선택">
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  void readFile(event);
                }}
                disabled={pending}
              />
            </Field>
            <Field
              label="또는 JSON 붙여넣기"
              help="형식: { &quot;items&quot;: [자료, …] }. Success AI 내보내기의 schemaVersion·exportedAt도 지원합니다."
            >
              <textarea
                className="mono"
                value={text}
                maxLength={500000}
                onChange={(event) => {
                  setText(event.target.value);
                  setPreview(null);
                  setError(null);
                }}
                disabled={pending}
              />
            </Field>
            <Button disabled={!text.trim() || pending} onClick={inspect}>
              JSON 자료 확인
            </Button>
          </div>
        </details>
        {preview && (
          <div className="source-import-preview stack">
            <h3>
              가져올 자료 선택 · {chosen.length}/{preview.items.length}개
            </h3>
            {preview.items.map((item, index) => (
              <label className="approval-check" key={rowKeys[index]}>
                <input
                  type="checkbox"
                  checked={chosenIndices.has(index)}
                  disabled={pending}
                  onChange={(event) =>
                    setChosen(
                      event.target.checked
                        ? [...chosen, index]
                        : chosen.filter((value) => value !== index),
                    )
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <span className="source-import-meta">
                    {sourceKinds[item.kind]} · {item.content ? "본문 포함" : "링크만 보관"} ·{" "}
                    {item.evidence === "observed" ? "등록된 관측 내용" : "검증 전 가설"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!preview || !chosen.length}
            onClick={() => {
              void save();
            }}
          >
            프로젝트에 {chosen.length}개 저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
