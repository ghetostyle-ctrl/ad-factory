import { Save } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  imageModelPresets,
  type ModelSettings,
  ModelSettingsSchema,
  ttsVoicePresets,
} from "../shared/models";
import { ConfigStatusSchema } from "../shared/schema";
import { api, errorMessage } from "./api";
import { Button, Field, Notice } from "./primitives";

export function ModelSettingsForm({
  settings,
  onSaved,
}: {
  readonly settings: ModelSettings;
  readonly onSaved: () => void;
}) {
  const [imageModel, setImageModel] = useState(settings.imageModel);
  const [quality, setQuality] = useState<string>(settings.imageQuality);
  const [ttsSelection, setTtsSelection] = useState(settings.ttsSelection);
  const [ttsVoiceId, setTtsVoiceId] = useState(settings.ttsVoiceId ?? ttsVoicePresets[0].id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const extendedQuality =
    imageModel === "gpt-image-2.5-sunburst" || imageModel === "gpt-image-2.5-flare";
  const chooseImageModel = (value: string) => {
    setImageModel(value);
    if (
      value !== "gpt-image-2.5-sunburst" &&
      value !== "gpt-image-2.5-flare" &&
      ["xhigh", "max"].includes(quality)
    )
      setQuality("high");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = ModelSettingsSchema.safeParse({
      textProvider: data.get("textProvider"),
      textModel: data.get("textModel"),
      codexModel: String(data.get("codexModel") ?? "").trim() || null,
      imageModel,
      imageQuality: quality,
      ttsProvider: "typecast",
      ttsSelection,
      ttsVoiceId: ttsSelection === "manual" ? ttsVoiceId : null,
      ttsTempo: Number(data.get("ttsTempo")),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "모델 설정을 확인해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      ConfigStatusSchema.parse(await api.post("model-settings", { json: parsed.data }).json());
      setMessage("모델 설정을 저장했습니다. 새로 시작하는 작업부터 적용됩니다.");
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
        <h3>AI 모델 설정</h3>
        <p className="muted small-copy">
          텍스트와 이미지 모델을 따로 선택합니다. 모델 설정은 재시작 후에도 유지됩니다.
        </p>
      </div>
      <Field label="텍스트 공급자">
        <select name="textProvider" defaultValue={settings.textProvider}>
          <option value="auto">자동 선택 · OpenAI 우선</option>
          <option value="openai">OpenAI API</option>
          <option value="codex">Codex CLI</option>
          <option value="none">사용 안 함</option>
        </select>
      </Field>
      <Field label="OpenAI 텍스트 모델" help="사용 권한이 있는 정확한 API 모델 ID를 입력하세요.">
        <input
          name="textModel"
          required
          defaultValue={settings.textModel}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Codex 텍스트 모델 (선택)"
        help="자동 운영에는 정확한 모델 ID가 필요합니다. 수동 실행에서만 비워두고 CLI 기본 모델을 사용할 수 있습니다."
      >
        <input
          name="codexModel"
          defaultValue={settings.codexModel ?? ""}
          placeholder="CLI 기본 모델"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="이미지 모델 프리셋">
        <select
          value={imageModelPresets.some((model) => model === imageModel) ? imageModel : "custom"}
          onChange={(event) => {
            if (event.target.value === "custom") chooseImageModel("");
            else chooseImageModel(event.target.value);
          }}
        >
          {imageModelPresets.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          <option value="custom">직접 입력</option>
        </select>
      </Field>
      <div className="form-grid">
        <Field label="이미지 모델 ID" help="프리셋 선택 또는 직접 입력이 가능합니다.">
          <input
            name="imageModel"
            required
            value={imageModel}
            onChange={(event) => chooseImageModel(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="이미지 품질">
          <select
            name="imageQuality"
            value={quality}
            onChange={(event) => setQuality(event.target.value)}
          >
            <option value="auto">자동</option>
            <option value="low">낮음 · low</option>
            <option value="medium">중간 · medium</option>
            <option value="high">높음 · high</option>
            {extendedQuality && (
              <>
                <option value="xhigh">매우 높음 · xhigh</option>
                <option value="max">최대 · max</option>
              </>
            )}
          </select>
        </Field>
      </div>
      <p className="muted small-copy">
        GPT Image 2.5 프리셋에서 xhigh·max를 선택할 수 있습니다. 모델 사용 가능 여부는 실제 API
        응답으로 확인됩니다. 진행 중인 작업의 모델은 바뀌지 않습니다.
      </p>
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
