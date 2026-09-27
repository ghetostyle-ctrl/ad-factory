import { Check, KeyRound, Terminal, Unplug } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { ConfigStatus } from "../shared/schema";
import { ConfigStatusSchema } from "../shared/schema";
import { api, errorMessage } from "./api";
import { ModelSettingsForm } from "./ModelSettingsForm";
import { Button, Dialog, Field, Notice } from "./primitives";

export function SettingsDialog({
  config,
  onClose,
  onSaved,
}: {
  readonly config: ConfigStatus;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const openaiApiKey = String(data.get("openaiApiKey") ?? "").trim();
    const geminiApiKey = String(data.get("geminiApiKey") ?? "").trim();
    const metaAccessToken = String(data.get("metaAccessToken") ?? "").trim();
    const typecastApiKey = String(data.get("typecastApiKey") ?? "").trim();
    if (!openaiApiKey && !geminiApiKey && !metaAccessToken && !typecastApiKey) {
      setError("추가할 키 또는 토큰을 입력해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      ConfigStatusSchema.parse(
        await api
          .post("connections", {
            json: {
              ...(openaiApiKey ? { openaiApiKey } : {}),
              ...(geminiApiKey ? { geminiApiKey } : {}),
              ...(metaAccessToken ? { metaAccessToken } : {}),
              ...(typecastApiKey ? { typecastApiKey } : {}),
            },
          })
          .json(),
      );
      form.reset();
      setMessage("현재 서버 세션에 저장했습니다. 실제 호출 시 연결 상태가 확인됩니다.");
      onSaved();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const providers = [
    {
      name: "OpenAI",
      detail: "전략·기획 및 이미지 제작",
      available: config.openai,
      icon: KeyRound,
    },
    { name: "Codex CLI", detail: "로컬 텍스트 작업 대안", available: config.codex, icon: Terminal },
    { name: "Gemini Veo", detail: "영상 소재 생성", available: config.gemini, icon: KeyRound },
    { name: "Typecast", detail: "영상 나레이션 TTS", available: config.typecast, icon: KeyRound },
    {
      name: "Meta 광고",
      detail: "계정 선택, 광고 준비 및 성과 조회",
      available: config.meta,
      icon: Unplug,
    },
  ];
  return (
    <Dialog
      title="연결 설정"
      description="연결 정보와 텍스트·이미지·영상 모델을 설정합니다."
      onClose={onClose}
    >
      <div className="stack">
        <div className="connection-list">
          {providers.map((provider) => (
            <div className="connection-row" key={provider.name}>
              <span className="connection-icon">
                <provider.icon size={18} />
              </span>
              <div>
                <strong>{provider.name}</strong>
                <p className="muted">{provider.detail}</p>
              </div>
              <span className={`badge ${provider.available ? "badge-success" : "badge-neutral"}`}>
                {provider.available ? <Check size={12} /> : null}
                {provider.available ? "설정 감지" : "미설정"}
              </span>
            </div>
          ))}
        </div>
        <Notice>
          키 또는 실행 파일의 존재를 표시합니다. 로그인·권한·잔액은 실제 실행 전까지 확인되지
          않습니다.
        </Notice>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="stack"
        >
          <h3>현재 세션에 연결 정보 추가</h3>
          <Field label="OpenAI API 키" help="이미지 제작과 텍스트 작업에 사용합니다.">
            <input
              name="openaiApiKey"
              type="password"
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Gemini API 키" help="Veo 영상 생성에 사용합니다.">
            <input
              name="geminiApiKey"
              type="password"
              placeholder="Gemini API 키"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Typecast API 키" help="영상 나레이션 음성 생성에 사용합니다.">
            <input
              name="typecastApiKey"
              type="password"
              placeholder="Typecast API 키"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Meta 액세스 토큰">
            <input
              name="metaAccessToken"
              type="password"
              placeholder="Meta 액세스 토큰"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <p className="muted small-copy">
            입력한 키는 이 컴퓨터의 .env 파일에 저장되며 서버 재시작 후에도 다시 불러옵니다.
            브라우저 상태나 실행 기록에는 키를 저장하지 않습니다.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          <Button type="submit" variant="primary" pending={pending}>
            세션에 저장
          </Button>
        </form>
        <ModelSettingsForm settings={config.modelSettings} onSaved={onSaved} />
        <details className="settings-details">
          <summary>실행 환경 자세히 보기</summary>
          <dl className="definition-list">
            <div>
              <dt>텍스트 경로</dt>
              <dd>{config.textProvider}</dd>
            </div>
            <div>
              <dt>텍스트 모델</dt>
              <dd>{config.textProvider === "codex" ? "Codex CLI 기본 모델" : config.textModel}</dd>
            </div>
            <div>
              <dt>이미지 모델</dt>
              <dd>{config.imageModel}</dd>
            </div>
            <div>
              <dt>TTS</dt>
              <dd>
                {config.modelSettings.ttsSelection === "auto"
                  ? "Typecast · 에이전트 자동 선택"
                  : `Typecast · ${config.modelSettings.ttsVoiceId}`}
              </dd>
            </div>
            <div>
              <dt>Meta API</dt>
              <dd>{config.metaVersion}</dd>
            </div>
          </dl>
          <p className="muted small-copy">
            저장된 키는 이 컴퓨터의 로컬 .env 파일에서만 사용됩니다. 이 파일은 Git에 포함하지 말고,
            브라우저 코드나 채팅에 키를 넣지 마세요.
          </p>
        </details>
      </div>
    </Dialog>
  );
}
