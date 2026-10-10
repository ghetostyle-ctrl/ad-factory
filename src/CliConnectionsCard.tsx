import { Terminal } from "lucide-react";
import { useState } from "react";
import { type CliConnections, CliConnectionsSchema } from "../shared/cli-connections";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";

const labels = { codex: "Codex", claudeCode: "Claude Code" } as const;
export function CliConnectionsCard() {
  const [result, setResult] = useState<CliConnections | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setPending(true);
    setError(null);
    try {
      setResult(
        CliConnectionsSchema.parse(
          await api.post("cli-connections/check", { timeout: 35_000 }).json(),
        ),
      );
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="stack" aria-label="Codex와 Claude Code 연결 확인">
      <div className="cluster">
        <h3>설치된 AI 도구</h3>
        <Button
          pending={pending}
          onClick={() => {
            void check();
          }}
        >
          <Terminal size={15} />
          로그인 상태 확인
        </Button>
      </div>
      <p className="muted small-copy">
        설치·로그인 상태만 확인합니다. 대본이나 이미지를 생성하지 않습니다.
      </p>
      {result && (
        <dl className="definition-list">
          {(["codex", "claudeCode"] as const).map((key) => (
            <div key={key}>
              <dt>{labels[key]}</dt>
              <dd>
                <strong>
                  {
                    (
                      {
                        ready: "로그인 확인",
                        login_required: "로그인 필요",
                        unavailable: "설치 필요",
                        unknown: "확인 필요",
                      } as const
                    )[result[key].authentication]
                  }
                </strong>
                <p className="muted small-copy">{result[key].version}</p>
                <p>{result[key].message}</p>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
