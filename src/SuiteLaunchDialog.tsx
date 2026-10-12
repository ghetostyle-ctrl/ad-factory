import { ExternalLink, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SUITE_APPS,
  type SuiteAppId,
  type SuiteStartResult,
  SuiteStartResultSchema,
} from "../shared/suite-apps";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

// 사이드바에서 다른 스위트 앱을 고르면 열리는 창. 서버가 그 앱을 찾아서 켜고 포트가 열리면 그 주소로 이동한다.
// 꺼져 있고 폴더도 못 찾으면 폴더 경로 입력과 설치 명령을 보여 준다(사용자가 터미널에 붙여 넣는다).
type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "opening"; readonly url: string }
  | { readonly kind: "failed"; readonly result: SuiteStartResult }
  | { readonly kind: "error"; readonly message: string };

export function SuiteLaunchDialog({
  appId,
  onClose,
}: {
  readonly appId: SuiteAppId;
  readonly onClose: () => void;
}) {
  const app = SUITE_APPS[appId];
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [dir, setDir] = useState("");
  const requested = useRef(false);
  const start = useCallback(
    async (customDir?: string) => {
      setPhase({ kind: "starting" });
      try {
        const result = SuiteStartResultSchema.parse(
          await api
            .post(`suite/apps/${appId}/start`, {
              json: customDir ? { dir: customDir } : {},
              timeout: 120_000,
            })
            .json(),
        );
        if (result.up) {
          setPhase({ kind: "opening", url: result.url });
          window.location.href = result.url;
          return;
        }
        setPhase({ kind: "failed", result });
      } catch (cause) {
        setPhase({ kind: "error", message: await errorMessage(cause) });
      }
    },
    [appId],
  );
  // 창이 열릴 때 한 번만 켠다(StrictMode 의 이중 실행도 ref 로 막는다).
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void start();
  }, [start]);
  const busy = phase.kind === "starting" || phase.kind === "opening";
  return (
    <Dialog
      title={`${app.name} 열기`}
      description={app.summary}
      onClose={onClose}
      closeDisabled={phase.kind === "opening"}
    >
      <div className="stack">
        {phase.kind === "starting" && (
          <Notice tone="info">
            {app.name}가 켜져 있는지 확인하고, 꺼져 있으면 이 PC 에서 켭니다. 처음 켤 때는 1분 정도
            걸릴 수 있습니다.
          </Notice>
        )}
        {phase.kind === "opening" && (
          <Notice tone="info">
            {app.name}가 켜졌습니다. <a href={phase.url}>{phase.url}</a> 로 이동합니다.
          </Notice>
        )}
        {phase.kind === "error" && <Notice tone="error">{phase.message}</Notice>}
        {phase.kind === "failed" && (
          <>
            <Notice tone={phase.result.reason === "not_found" ? "warning" : "error"}>
              {phase.result.message}
            </Notice>
            {phase.result.hint && (
              <div>
                <p className="muted">터미널에 붙여 넣을 명령:</p>
                <pre className="flow-prompt">{phase.result.hint}</pre>
              </div>
            )}
            {phase.result.reason === "not_found" && (
              <>
                <Field
                  label={`${app.name} 폴더 경로`}
                  help="설치한 폴더의 전체 경로(예: C:\Users\이름\Downloads\success_ai). 한 번 알려 주면 기억합니다."
                >
                  <input
                    type="text"
                    value={dir}
                    onChange={(event) => setDir(event.target.value)}
                    placeholder={app.folderNames[0]}
                    autoComplete="off"
                  />
                </Field>
                <p className="muted">
                  아직 설치하지 않았다면{" "}
                  <a href={app.repo} target="_blank" rel="noreferrer">
                    {app.repo}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                  에서 받아 위 명령으로 설치한 뒤 다시 누르세요.
                </p>
              </>
            )}
          </>
        )}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose} disabled={phase.kind === "opening"}>
            닫기
          </Button>
          {phase.kind === "failed" && phase.result.reason === "not_found" ? (
            <Button
              variant="primary"
              onClick={() => {
                void start(dir.trim());
              }}
              disabled={dir.trim().length === 0}
            >
              <FolderOpen size={14} aria-hidden="true" />이 폴더로 켜기
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                void start();
              }}
              pending={busy}
              disabled={busy}
            >
              <RefreshCw size={14} aria-hidden="true" />
              다시 시도
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
