import { Copy, ExternalLink, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { type FlowImageRequest, flowImagesOf } from "../shared/flow-images";
import { FLOW_URL } from "../shared/flow-mode";
import type { Job } from "../shared/schema";
import { api, errorMessage } from "./api";
import { Button, Field, Notice } from "./primitives";
import "./flow.css";

function ImageRequest({
  job,
  request,
  onRefresh,
}: {
  readonly job: Job;
  readonly request: FlowImageRequest;
  readonly onRefresh: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const base = `jobs/${job.id}/flow-images/${request.id}`;
  const uploaded = request.digest !== null;
  const source = uploaded ? `/api/${base}/image` : preview;
  const prompt = `${request.prompt}\n최종 이미지 화면비: ${request.aspect === "portrait" ? "9:16 세로" : "1:1 정사각형"}.`;
  const available =
    job.automation?.status === "waiting" &&
    ["image", "stills", "startImages"].includes(job.automation.phase);
  const upload = async () => {
    if (!file || !confirmed) return;
    if (file.size > 15 * 1024 * 1024) {
      setError("이미지는 15MB 이하여야 합니다.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("confirmed", "true");
      await api.post(base, { body, timeout: 60_000 });
      setFile(null);
      setConfirmed(false);
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="flow-clip">
      <div className="flow-thumb">
        {source ? (
          <img
            src={source}
            alt={`${request.label} ${uploaded ? "업로드 이미지" : "선택한 파일 미리보기"}`}
            width={request.aspect === "portrait" ? 360 : 640}
            height={640}
            style={{
              aspectRatio: request.aspect === "portrait" ? "9 / 16" : "1",
              objectFit: "contain",
            }}
          />
        ) : (
          <div className="card-slide-pending">
            {request.aspect === "portrait" ? "9:16" : "1:1"}
            <br />
            이미지 대기
          </div>
        )}
      </div>
      <div className="stack flow-body">
        <div className="flow-clip-heading">
          <strong>{request.label}</strong>
          <span className={`badge ${uploaded ? "badge-success" : "badge-warning"}`}>
            {uploaded ? "업로드됨" : "업로드 대기"}
          </span>
        </div>
        <details open={!uploaded}>
          <summary>Flow 이미지 프롬프트</summary>
          <pre className="flow-prompt">{prompt}</pre>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(prompt).then(
                () => setCopied(true),
                () => setError("프롬프트를 선택해 직접 복사해 주세요."),
              );
            }}
          >
            <Copy size={14} />
            {copied ? "복사됨" : "프롬프트 복사"}
          </Button>
        </details>
        {request.referenceCount > 0 && (
          <div className="cluster">
            {Array.from({ length: request.referenceCount }, (_, index) => index + 1).map(
              (reference) => (
                <a
                  key={reference}
                  href={`/api/${base}/references/${reference}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  참조 이미지 {reference} 열기
                </a>
              ),
            )}
          </div>
        )}
        {!uploaded && (
          <>
            <Field
              label={`${request.label} 파일 선택`}
              help="PNG/JPEG · 15MB 이하. 화면비와 제품 표현을 확인하세요."
            >
              <input
                type="file"
                accept="image/png,image/jpeg"
                disabled={pending || !available}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setConfirmed(false);
                  setError(null);
                }}
              />
            </Field>
            <label className="approval-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={!file || pending || !available}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>이 장면에 사용할 이미지가 맞는지 확인했습니다.</span>
            </label>
            <Button
              pending={pending}
              disabled={!file || !confirmed || !available}
              onClick={() => {
                void upload();
              }}
            >
              <Upload size={15} />
              확인한 이미지 업로드
            </Button>
            {!available && (
              <p className="muted small-copy">
                이미지 업로드 대기 상태가 되면 올릴 수 있습니다. 중지한 작업은 먼저 재개하세요.
              </p>
            )}
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </li>
  );
}
export function FlowImagesPanel({
  job,
  onRefresh,
}: {
  readonly job: Job;
  readonly onRefresh: () => void;
}) {
  const requests = flowImagesOf(job);
  if (job.executionModels?.imageProvider !== "flow" || !requests.length) return null;
  const pending = requests.filter((request) => !request.digest);
  const completed = requests.filter((request) => request.digest);
  return (
    <section className="panel" aria-label="Flow 이미지 제작">
      <div className="panel-header spread">
        <h2>Flow 이미지 제작</h2>
        <a href={FLOW_URL} className="flow-link" target="_blank" rel="noreferrer">
          Flow 열기
          <ExternalLink size={14} />
        </a>
      </div>
      <div className="panel-body stack">
        <Notice>
          현재 단계에 필요한 이미지를 순서대로 요청합니다. 프롬프트와 참조 이미지를 Flow에 넣어
          제작한 뒤 확인하고 업로드하세요. 이미지 검토 후 다음 단계가 이어지며, 설명 컷 CLEAN·INFO는
          아래 영상 카드에서 올립니다.
        </Notice>
        {pending.length > 0 && (
          <ul className="flow-clips">
            {pending.map((request) => (
              <ImageRequest key={request.id} job={job} request={request} onRefresh={onRefresh} />
            ))}
          </ul>
        )}
        {completed.length > 0 && (
          <details>
            <summary>업로드한 이미지 {completed.length}장</summary>
            <ul className="flow-clips">
              {completed.map((request) => (
                <ImageRequest key={request.id} job={job} request={request} onRefresh={onRefresh} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
