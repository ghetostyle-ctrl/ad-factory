import { Save } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { type ModelSettings, ModelSettingsSchema, ttsVoicePresets } from "../shared/models";
import { ConfigStatusSchema } from "../shared/schema";
import { api, errorMessage } from "./api";
import { ImageModelSettings } from "./ImageModelSettings";
import { Button, Field, Notice } from "./primitives";
import { TextModelSettings } from "./TextModelSettings";
export function ModelSettingsForm({
  settings,
  onSaved,
}: {
  readonly settings: ModelSettings;
  readonly onSaved: () => void;
}) {
  const [ttsSelection, setTtsSelection] = useState(settings.ttsSelection);
  const [ttsVoiceId, setTtsVoiceId] = useState(settings.ttsVoiceId ?? ttsVoicePresets[0].id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string, fallback: string) => String(data.get(name) ?? fallback).trim();
    const parsed = ModelSettingsSchema.safeParse({
      ...settings,
      textProvider: data.get("textProvider"),
      textModel: text("textModel", settings.textModel),
      codexModel: text("codexModel", settings.codexModel ?? "") || null,
      claudeCodeModel: text("claudeCodeModel", settings.claudeCodeModel ?? "") || null,
      scriptProvider: data.get("scriptProvider"),
      scriptModel:
        data.get("scriptProvider") === "same"
          ? undefined
          : text("scriptModel", settings.scriptModel ?? ""),
      imageProvider: data.get("imageProvider"),
      imageModel: text("imageModel", settings.imageModel),
      imageQuality: text("imageQuality", settings.imageQuality),
      ttsProvider: "typecast",
      ttsSelection,
      ttsVoiceId: ttsSelection === "manual" ? ttsVoiceId : null,
      ttsTempo: Number(data.get("ttsTempo")),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "모델 설정을 확인하세요.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      ConfigStatusSchema.parse(await api.post("model-settings", { json: parsed.data }).json());
      setMessage("설정을 저장했습니다. 새로 시작하는 작업부터 적용됩니다.");
      onSaved();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="stack model-settings"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div>
        <h3>AI 연결 및 제작 방식</h3>
        <p className="muted small-copy">
          글쓰기 AI와 이미지 제작 방식을 각각 선택하세요. 진행 중인 작업은 시작할 때 고정한 설정을
          사용합니다.
        </p>
      </div>
      <TextModelSettings settings={settings} />
      <ImageModelSettings settings={settings} />
      <div>
        <h3>영상 TTS 설정</h3>
        <p className="muted small-copy">
          보이스·속도는 작업 시작 시 고정되며 완성 영상 내레이션(문장별 Typecast 합성)에 쓰입니다.
          진행 중인 작업에는 적용되지 않습니다.
        </p>
      </div>
      <Field label="TTS 선택 방식">
        <select
          name="ttsSelection"
          value={ttsSelection}
          onChange={(event) => {
            setTtsSelection(event.target.value === "manual" ? "manual" : "auto");
          }}
        >
          <option value="auto">에이전트가 자동 선택</option>
          <option value="manual">내가 보이스 선택</option>
        </select>
      </Field>
      {ttsSelection === "manual" && (
        <div className="form-grid">
          <Field label="Typecast 보이스 프리셋">
            <select
              value={
                ttsVoicePresets.some((voice) => voice.id === ttsVoiceId) ? ttsVoiceId : "custom"
              }
              onChange={(event) => {
                if (event.target.value !== "custom") setTtsVoiceId(event.target.value);
              }}
            >
              {ttsVoicePresets.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} · {voice.tone}
                </option>
              ))}
              <option value="custom">직접 입력</option>
            </select>
          </Field>
          <Field
            label="Typecast voice id"
            help="보이스 목록에서 고른 tc_… 값을 직접 입력할 수 있습니다."
          >
            <input
              name="ttsVoiceId"
              required
              value={ttsVoiceId}
              onChange={(event) => setTtsVoiceId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
      )}
      <Field label="TTS 속도">
        <input
          name="ttsTempo"
          type="number"
          min="0.7"
          max="1.3"
          step="0.05"
          defaultValue={settings.ttsTempo}
        />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <Button type="submit" variant="primary" pending={pending}>
        <Save size={15} />
        모델 설정 저장
      </Button>
    </form>
  );
}
