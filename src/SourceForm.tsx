import { type FormEvent, useRef, useState } from "react";
import { mergeSourceContent, SourceImagePreviewSchema } from "../shared/source-image-preview";
import {
  SourceUrlPreviewRequestSchema,
  SourceUrlPreviewSchema,
} from "../shared/source-url-preview";
import {
  CreateSourceSchema,
  type ProjectId,
  type ProjectSource,
  ProjectSourceSchema,
} from "../shared/sources";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";
import { imagePreviewChunks } from "./source-image-chunks";

export const sourceKinds = {
  product_fact: "제품 사실",
  review: "고객 후기",
  offer: "가격·혜택",
  reference: "광고 레퍼런스",
} as const;

export function SourceForm({
  projectId,
  source,
  initialKind,
  onClose,
  onSaved,
}: {
  readonly projectId: ProjectId;
  readonly source: ProjectSource | null;
  readonly initialKind?: keyof typeof sourceKinds;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const scanAllowed = source?.provenance.origin !== "success_ai";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(source?.title ?? "");
  const [content, setContent] = useState(source?.content ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [scanPending, setScanPending] = useState(false);
  const [imagePending, setImagePending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<readonly File[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanDraft, setScanDraft] = useState<ReturnType<
    typeof SourceUrlPreviewSchema.parse
  > | null>(null);
  const inFlight = useRef(false);
  const lastScanned = useRef("");
  const latestUrl = useRef(source?.url ?? "");
  const imageRun = useRef(0);
  const scanSource = async (force = false, candidate = url) => {
    if (!scanAllowed) return;
    const input = SourceUrlPreviewRequestSchema.safeParse({ url: candidate.trim() });
    if (!input.success) {
      if (url.trim()) setScanError("http:// 또는 https://로 시작하는 출처 URL을 확인해 주세요.");
      return;
    }
    if (inFlight.current || (!force && lastScanned.current === input.data.url)) return;
    inFlight.current = true;
    setScanPending(true);
    setScanError(null);
    try {
      const draft = SourceUrlPreviewSchema.parse(
        await api.post(`projects/${projectId}/source-url-preview`, { json: input.data }).json(),
      );
      if (latestUrl.current.trim() !== input.data.url) return;
      setScanDraft(draft);
      setTitle((current) => (current.trim() ? current : draft.title));
      setContent((current) => mergeSourceContent(current, draft.content));
      lastScanned.current = input.data.url;
    } catch (cause) {
      setScanError(await errorMessage(cause));
    } finally {
      inFlight.current = false;
      setScanPending(false);
      const changedUrl = latestUrl.current.trim();
      if (changedUrl && changedUrl !== input.data.url) void scanSource(false, changedUrl);
    }
  };
  const scanImages = async (files: readonly File[]) => {
    if (!files.length) return;
    const run = ++imageRun.current;
    setImagePending(true);
    setImageError(null);
    setImageNotice(null);
    const observed = new Set<string>();
    const additions: string[] = [];
    let candidateTitle = "";
    let chunks = 0;
    const applyDraft = () => {
      if (candidateTitle) setTitle((current) => (current.trim() ? current : candidateTitle));
      if (additions.length)
        setContent((current) => mergeSourceContent(current, additions.join("\n")));
    };
    try {
      for await (const chunk of imagePreviewChunks(files)) {
        if (run !== imageRun.current) return;
        const body = new FormData();
        body.append("file", chunk.file);
        const reading = SourceImagePreviewSchema.parse(
          await api.post(`projects/${projectId}/source-image-preview`, { body }).json(),
        );
        if (run !== imageRun.current) return;
        if (!candidateTitle && reading.title) candidateTitle = reading.title;
        const origin =
          chunk.total > 1 ? `${chunk.sourceName} · 구간 ${chunk.part}` : chunk.sourceName;
        if (reading.title && !reading.lines.some((line) => line.includes(reading.title))) {
          const titleLine = `상품명: ${reading.title}`;
          if (!observed.has(titleLine)) {
            observed.add(titleLine);
            additions.push(`[${origin}] ${titleLine}`);
          }
        }
        for (const line of reading.lines) {
          const clean = line.trim();
          if (!clean || observed.has(clean)) continue;
          observed.add(clean);
          additions.push(`[${origin}] ${clean}`);
        }
        chunks++;
      }
      applyDraft();
      setImageNotice(
        additions.length
          ? `이미지 ${files.length}장 · ${chunks}개 구간에서 문구 ${additions.length}개를 읽었습니다. 저장 전에 원본과 대조해 주세요.`
          : "이미지에서 읽을 수 있는 상품 문구를 찾지 못했습니다. 더 선명한 이미지를 선택해 주세요.",
      );
    } catch (cause) {
      if (run === imageRun.current) {
        applyDraft();
        setImageError(cause instanceof Error ? cause.message : "이미지 분석에 실패했습니다.");
      }
    } finally {
      if (run === imageRun.current) setImagePending(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const expires = String(data.get("expiresAt") ?? "");
    const expiry = expires ? new Date(expires) : null;
    if (expiry && !Number.isFinite(expiry.getTime())) {
      setError("혜택 종료 시각을 확인해 주세요.");
      return;
    }
    const parsed = CreateSourceSchema.safeParse({
      kind: data.get("kind"),
      title: data.get("title"),
      content: data.get("content"),
      url: data.get("url") || null,
      evidence: data.get("evidence"),
      status: data.get("included") ? "eligible" : "inactive",
      expiresAt: expiry?.toISOString() ?? null,
      provenance: source?.provenance,
      ...(source?.referenceData ? { referenceData: source.referenceData } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "자료 내용을 확인해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const path = `projects/${projectId}/sources`;
      const response = source
        ? await api.put(`${path}/${source.id}`, { json: parsed.data }).json()
        : await api.post(path, { json: parsed.data }).json();
      const saved = ProjectSourceSchema.parse(response);
      const files = data
        .getAll("files")
        .filter((item): item is File => item instanceof File && item.size > 0);
      if (files.length > 0) {
        for (const file of files) {
          const upload = new FormData();
          upload.append("files", file);
          await api.post(`${path}/${saved.id}/files`, { body: upload }).json();
        }
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const formTitle = source
    ? "자료 수정"
    : initialKind === "product_fact"
      ? "내 상품 정보 등록"
      : initialKind === "offer"
        ? "가격·혜택 등록"
        : "프로젝트 자료 추가";
  return (
    <Dialog title={formTitle} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="form-grid">
          <Field label="자료 종류">
            <select
              name="kind"
              defaultValue={source?.kind ?? initialKind ?? "product_fact"}
              disabled={source?.provenance.origin === "success_ai"}
            >
              {Object.entries(sourceKinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {source?.provenance.origin === "success_ai" && (
              <input type="hidden" name="kind" value="reference" />
            )}
          </Field>
          <Field label="내용의 성격">
            <select name="evidence" defaultValue={source?.evidence ?? "observed"}>
              <option value="observed">실제 자료에서 확인한 내용</option>
              <option value="hypothesis">검증이 필요한 아이디어·가설</option>
            </select>
          </Field>
        </div>
        <Field
          label="출처 URL (선택)"
          help={
            scanAllowed
              ? "주소를 입력한 뒤 다른 칸을 누르면 페이지의 제목과 본문을 읽어 초안을 채웁니다. 저장 전에 내용을 확인해 주세요."
              : "Success AI에서 가져온 광고의 원본 주소입니다. 이미 저장된 광고 내용은 이 URL로 다시 스캔하지 않습니다."
          }
        >
          <input
            name="url"
            type="url"
            maxLength={4000}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              latestUrl.current = event.target.value;
              setScanDraft(null);
              setScanError(null);
              lastScanned.current = "";
            }}
            onBlur={() => {
              if (scanAllowed) void scanSource();
            }}
            placeholder="https://…"
          />
        </Field>
        {scanAllowed && (
          <div className="form-actions">
            <Button
              disabled={!url.trim() || scanPending}
              pending={scanPending}
              onClick={() => {
                void scanSource(true);
              }}
            >
              URL에서 이름·내용 가져오기
            </Button>
          </div>
        )}
        {scanError && <Notice tone="error">{scanError}</Notice>}
        {scanDraft && (
          <Notice tone={scanDraft.warning ? "warning" : "info"}>
            {scanDraft.warning ??
              "페이지에서 읽은 초안을 채웠습니다. 확인 후 수정하거나 저장하세요."}
            {(title !== scanDraft.title || content !== scanDraft.content) && (
              <Button
                onClick={() => {
                  setTitle(scanDraft.title);
                  setContent((current) => mergeSourceContent(current, scanDraft.content));
                }}
              >
                가져온 초안 적용
              </Button>
            )}
          </Notice>
        )}
        <Field label="자료 이름">
          <input
            name="title"
            required
            minLength={2}
            maxLength={240}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={
              initialKind === "product_fact"
                ? "예: 주력 상품 기본 정보 · 상세페이지 핵심"
                : initialKind === "offer"
                  ? "예: 10월 무료배송 · 첫 구매 할인"
                  : "예: 텀블러 소재 안내 · 구매 후기 · 10월 무료배송"
            }
          />
        </Field>
        <Field
          label="자료 내용"
          help={
            initialKind === "product_fact"
              ? "상세페이지, 패키지, 실제 제품 스펙처럼 광고에서 사실로 말해도 되는 내용을 넣어 주세요."
              : "원문을 붙여넣어 주세요. 예: ‘용량 500ml, 스테인리스 소재’ 또는 고객이 남긴 실제 후기."
          }
        >
          <textarea
            name="content"
            className="source-content-input"
            maxLength={20000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={
              initialKind === "product_fact"
                ? "예: 제품명, 카테고리, 소재, 용량, 구성품, 사용법, 주의사항, 상세페이지에서 확인한 핵심 문장"
                : initialKind === "offer"
                  ? "예: 할인율, 쿠폰, 무료배송, 사은품, 적용 조건, 종료일"
                  : "제품 사실과 광고 아이디어는 구분해 저장하세요. 레퍼런스의 문구·구조는 참고하되, 타사 주장을 우리 제품의 사실로 사용하지 않습니다."
            }
          />
        </Field>
        {(initialKind === "product_fact" ||
          initialKind === "offer" ||
          source?.kind === "product_fact" ||
          source?.kind === "offer") && (
          <Field
            label="상세페이지·상품 이미지 파일 (선택)"
            help="jpg/png/webp 이미지를 여러 장 선택하면 문구를 자동으로 읽어 초안에 더합니다. 저장 전 원본과 대조해 주세요. 원본 파일도 프로젝트에 보관됩니다."
          >
            <input
              name="files"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                setImageFiles(files);
                if (files.length) void scanImages(files);
              }}
            />
            {imageFiles.length > 0 && (
              <div className="form-actions">
                <Button
                  disabled={imagePending}
                  pending={imagePending}
                  onClick={() => {
                    void scanImages(imageFiles);
                  }}
                >
                  이미지 다시 읽기
                </Button>
              </div>
            )}
            {imageNotice && <Notice tone="info">{imageNotice}</Notice>}
            {imageError && (
              <Notice tone="error">
                {imageError} 직접 내용을 입력하거나 다시 시도할 수 있습니다.
              </Notice>
            )}
          </Field>
        )}
        <Field
          label="가격·혜택 종료 시각 (선택)"
          help="기한이 지난 자료는 새 작업의 근거에서 제외됩니다. 현재 컴퓨터의 현지 시각입니다."
        >
          <input
            name="expiresAt"
            type="datetime-local"
            defaultValue={source?.expiresAt ? localDate(source.expiresAt) : ""}
          />
        </Field>
        <label className="approval-check">
          <input name="included" type="checkbox" defaultChecked={source?.status !== "inactive"} />
          <span>새 작업에 이 자료를 사용합니다.</span>
        </label>
        {source && (
          <Notice>
            수정은 이후 만드는 작업에 적용됩니다. 이미 저장된 작업 자료는 바뀌지 않습니다.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button
            type="submit"
            variant="primary"
            pending={pending}
            disabled={scanPending || imagePending}
          >
            자료 저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function localDate(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
