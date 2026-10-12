import { KeyRound, Terminal, Unplug } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { CliConnection, CliConnections } from "../shared/cli-connections";
import type { ConfigStatus } from "../shared/schema";
import { ConfigStatusSchema } from "../shared/schema";
import { api, errorMessage } from "./api";
import { CliConnectionsCard } from "./CliConnectionsCard";
import { InstructionsCard } from "./InstructionsCard";
import { ModelSettingsForm } from "./ModelSettingsForm";
import { Button, Dialog, Field, Notice, Segmented } from "./primitives";

// 연결 설정은 네 구역으로 나눈다. 모든 구역을 계속 마운트해 두고(hidden) 모델 폼에 적은 값이 탭을 옮겨도 남게 한다.
const SETTINGS_TABS = [
  { value: "connections", label: "연결" },
  { value: "models", label: "모델" },
  { value: "instructions", label: "지시 파일" },
  { value: "environment", label: "환경" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
const SETTINGS_PANEL_ID = "settings-panel";
const settingsTabId = (tab: SettingsTab) => `settings-tab-${tab}`;

// 연결 행 라벨: 있는 사실만 적는다. 키·실행 파일이 있다는 것까지만 알고, 실제 호출 성공·로그인은 확인 전이다.
// CLI 는 '로그인 상태 확인' 결과가 있을 때만 그 결과대로 적는다(성공 = 확인됨, 로그인 실패 = 로그인 필요).
function connectionLabel(
  available: boolean,
  kind: "key" | "cli",
  checked?: CliConnection,
): { readonly text: string; readonly tone: "" | "is-set" | "is-verified" | "is-failed" } {
  if (!available) return { text: "미설정", tone: "" };
  if (kind === "key") return { text: "키 있음 · 미검증", tone: "is-set" };
  if (checked?.authentication === "ready") return { text: "확인됨", tone: "is-verified" };
  if (checked?.authentication === "login_required")
    return { text: "로그인 필요", tone: "is-failed" };
  return { text: "설치됨 · 로그인 미확인", tone: "is-set" };
}

export function SettingsDialog({
  config,
  onClose,
  onSaved,
}: {
  readonly config: ConfigStatus;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("connections");
  const [cliChecked, setCliChecked] = useState<CliConnections | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const openaiApiKey = String(data.get("openaiApiKey") ?? "").trim();
    const anthropicApiKey = String(data.get("anthropicApiKey") ?? "").trim();
    const geminiApiKey = String(data.get("geminiApiKey") ?? "").trim();
    const metaAccessToken = String(data.get("metaAccessToken") ?? "").trim();
    const typecastApiKey = String(data.get("typecastApiKey") ?? "").trim();
    if (!openaiApiKey && !anthropicApiKey && !geminiApiKey && !metaAccessToken && !typecastApiKey) {
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
              ...(anthropicApiKey ? { anthropicApiKey } : {}),
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
      kind: "key",
      icon: KeyRound,
    },
    {
      name: "Codex CLI",
      detail: "기획·대본·프롬프트 작성",
      available: config.codex,
      kind: "cli",
      checked: cliChecked?.codex,
      icon: Terminal,
    },
    {
      name: "Claude Code",
      detail: "기획·대본·프롬프트 작성",
      available: config.claudeCode,
      kind: "cli",
      checked: cliChecked?.claudeCode,
      icon: Terminal,
    },
    {
      name: "Gemini Veo",
      detail: "영상 소재 생성",
      available: config.gemini,
      kind: "key",
      icon: KeyRound,
    },
    {
      name: "Typecast",
      detail: "영상 나레이션 TTS",
      available: config.typecast,
      kind: "key",
      icon: KeyRound,
    },
    {
      name: "Meta 광고",
      detail: "계정 선택, 광고 준비 및 성과 조회",
      available: config.meta,
      kind: "key",
      icon: Unplug,
    },
  ] as const;
  return (
    <Dialog
      title="연결 설정"
      description="연결 정보와 텍스트·이미지·영상 모델을 설정하고 지시 파일 상태를 확인합니다."
      onClose={onClose}
    >
      <div className="stack">
        <div className="settings-tabs">
          <Segmented
            label="연결 설정 구역"
            options={SETTINGS_TABS}
            value={tab}
            onChange={setTab}
            idPrefix="settings-tab"
            panelId={SETTINGS_PANEL_ID}
          />
        </div>
        <div
          className="stack"
          role="tabpanel"
          id={SETTINGS_PANEL_ID}
          aria-labelledby={settingsTabId(tab)}
        >
          <div className="stack" hidden={tab !== "connections"}>
            <div className="connection-list">
              {providers.map((provider) => {
                const state = connectionLabel(
                  provider.available,
                  provider.kind,
                  "checked" in provider ? provider.checked : undefined,
                );
                return (
                  <div className="connection-row" key={provider.name}>
                    <span className="connection-icon">
                      <provider.icon size={18} aria-hidden="true" />
                    </span>
                    <div>
                      <strong>{provider.name}</strong>
                      <p className="muted">{provider.detail}</p>
                    </div>
                    <span className={`conn-state ${state.tone}`}>
                      <i aria-hidden="true" />
                      {state.text}
                    </span>
                  </div>
                );
              })}
            </div>
            <Notice>
              키 또는 실행 파일의 존재만 표시합니다. CLI 로그인은 아래 확인 버튼으로 확인할 수 있고,
              모델 권한·잔액은 실제 실행 전까지 미검증입니다.
            </Notice>
            <CliConnectionsCard onChecked={setCliChecked} />
            <details className="settings-details">
              <summary>API 키 연결 (선택한 제작 방식에 따라 필요)</summary>
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
                <Field
                  label="Anthropic API 키"
                  help="Anthropic API 방식의 대본 작성에 사용합니다. Claude Code 로그인과는 별도입니다."
                >
                  <input
                    name="anthropicApiKey"
                    type="password"
                    placeholder="sk-ant-…"
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
            </details>
          </div>
          <div className="stack" hidden={tab !== "models"}>
            <ModelSettingsForm settings={config.modelSettings} onSaved={onSaved} />
          </div>
          <div className="stack" hidden={tab !== "instructions"}>
            <InstructionsCard />
          </div>
          <div className="stack" hidden={tab !== "environment"}>
            <h3>실행 환경</h3>
            <dl className="definition-list">
              <div>
                <dt>텍스트 경로</dt>
                <dd>{config.textProvider}</dd>
              </div>
              <div>
                <dt>텍스트 모델</dt>
                <dd>
                  {config.textProvider === "codex"
                    ? (config.modelSettings.codexModel ?? "CLI 기본 모델")
                    : config.textProvider === "claudeCode"
                      ? (config.modelSettings.claudeCodeModel ?? "CLI 기본 모델")
                      : config.textModel}
                </dd>
              </div>
              <div>
                <dt>이미지 모델</dt>
                <dd>
                  {config.modelSettings.imageProvider === "flow"
                    ? "Google Flow · 직접 제작 후 업로드"
                    : config.imageModel}
                </dd>
              </div>
              <div>
                <dt>TTS</dt>
                <dd>
                  {config.modelSettings.ttsSelection === "auto"
                    ? "Typecast · 자동 선택"
                    : `Typecast · ${config.modelSettings.ttsVoiceId}`}
                </dd>
              </div>
              <div>
                <dt>Meta API</dt>
                <dd>{config.metaVersion}</dd>
              </div>
            </dl>
            <p className="muted small-copy">
              저장된 키는 이 컴퓨터의 로컬 .env 파일에서만 사용됩니다. 이 파일은 Git에 포함하지
              말고, 브라우저 코드나 채팅에 키를 넣지 마세요.
            </p>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
