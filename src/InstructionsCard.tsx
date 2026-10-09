import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type InstructionsStatus,
  InstructionsStatusSchema,
  shortDigest,
} from "../shared/instructions-status";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";

// 연결 설정 창의 '지시 파일' 읽기 전용 카드(D6). GET /api/instructions 로 파일 목록·해시·마지막 로드·경고·임계값을 보여 준다.
// 수정은 저장소의 instructions/ 파일에서 하고, 여기서는 읽은 결과만 확인한다.
export function InstructionsCard() {
  const [status, setStatus] = useState<InstructionsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const load = useCallback(async () => {
    setPending(true);
    try {
      setStatus(InstructionsStatusSchema.parse(await api.get("instructions").json()));
      setError(null);
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <InstructionsCardView
      status={status}
      error={error}
      pending={pending}
      onRefresh={() => void load()}
    />
  );
}

const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
function dateTimeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}
function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}
function stateLabel(status: InstructionsStatus): {
  readonly text: string;
  readonly tone: "success" | "warning" | "danger";
} {
  if (!status.loaded) return { text: "읽기 실패", tone: "danger" };
  if (status.warnings.length > 0) return { text: "경고 · 마지막 성공본 사용 중", tone: "warning" };
  return { text: "정상", tone: "success" };
}

export function InstructionsCardView({
  status,
  error,
  pending,
  onRefresh,
}: {
  readonly status: InstructionsStatus | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly onRefresh: () => void;
}) {
  const state = status ? stateLabel(status) : null;
  const sectionCount = (file: string) =>
    status?.sections.filter((section) => section.file === file).length ?? 0;
  const thresholdNames = status ? Object.keys(status.thresholds) : [];
  const warnings = status ? [...new Set(status.warnings)] : [];
  return (
    <section className="instructions-card stack" aria-label="지시 파일">
      <div className="instructions-card-header">
        <h3>지시 파일</h3>
        {state && <span className={`badge badge-${state.tone}`}>{state.text}</span>}
        <Button size="sm" onClick={onRefresh} pending={pending}>
          <RefreshCw size={14} aria-hidden="true" />
          다시 확인
        </Button>
      </div>
      <p className="muted small-copy">
        저장소의 <code>{status?.folder ?? "instructions"}/</code> 폴더에 있는 창작
        지시(기획·대본·검토·카피·Flow 프롬프트 문구)와 <code>thresholds.json</code>의 숫자
        임계값입니다. 서버가 생성 호출마다 읽으므로 파일을 고치면 다음 생성부터 반영되고
        재시작·빌드는 필요 없습니다. 이 카드는 읽기 전용이며 수정 규칙은{" "}
        <code>instructions/README.md</code>를 따릅니다.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {!status && !error && pending && (
        <p className="muted small-copy">지시 파일 상태를 읽는 중…</p>
      )}
      {status && (
        <>
          {warnings.map((warning) => (
            <Notice tone={status.loaded ? "warning" : "error"} key={warning}>
              {warning}
            </Notice>
          ))}
          <dl className="definition-list instructions-summary">
            <div>
              <dt>해시</dt>
              <dd>
                {status.digest ? (
                  <>
                    <span className="mono">{shortDigest(status.digest)}</span>{" "}
                    <span className="instructions-digest">{status.digest}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>마지막 로드</dt>
              <dd>{dateTimeLabel(status.loadedAt)}</dd>
            </div>
            <div>
              <dt>확인 시각</dt>
              <dd>{dateTimeLabel(status.checkedAt)}</dd>
            </div>
            <div>
              <dt>절·임계값</dt>
              <dd>
                절 {status.sections.length}개 · 임계값 {thresholdNames.length}개
              </dd>
            </div>
          </dl>
          {status.files.length > 0 ? (
            <ul className="instructions-files">
              {status.files.map((file) => (
                <li key={file.name}>
                  <strong>{file.name}</strong>
                  <span className="mono">{shortDigest(file.digest)}</span>
                  <span className="instructions-meta">
                    {sizeLabel(file.size)}
                    {file.name.endsWith(".md") ? ` · 절 ${sectionCount(file.name)}개` : ""} · 수정{" "}
                    {dateTimeLabel(file.modifiedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small-copy">폴더에서 읽은 파일이 없습니다.</p>
          )}
          {thresholdNames.length > 0 && (
            <details className="settings-details instructions-thresholds">
              <summary>임계값 {thresholdNames.length}개 보기</summary>
              <dl className="definition-list">
                {thresholdNames.map((name) => {
                  const detail = status.thresholdDetails[name];
                  return (
                    <div key={name}>
                      <dt className="mono">{name}</dt>
                      <dd>
                        {status.thresholds[name]}
                        {detail && (
                          <>
                            {" "}
                            <span className="muted">
                              ({detail.min}–{detail.max})
                            </span>
                            {detail.description && (
                              <span className="muted small-copy instructions-threshold-note">
                                {" "}
                                — {detail.description}
                              </span>
                            )}
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          )}
        </>
      )}
    </section>
  );
}
