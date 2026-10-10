import { useState } from "react";
import {
  defaultScriptModel,
  type ModelSettings,
  ModelSettingsSchema,
  SCRIPT_PROVIDERS,
  ScriptProviderSchema,
  scriptProviderLabels,
  textModelPresets,
} from "../shared/models";
import { Field, Notice } from "./primitives";
export function TextModelSettings({ settings }: { readonly settings: ModelSettings }) {
  const [provider, setProvider] = useState(settings.textProvider);
  const [textModel, setTextModel] = useState(settings.textModel);
  const [codexModel, setCodexModel] = useState(settings.codexModel ?? "");
  const [claudeCodeModel, setClaudeCodeModel] = useState(settings.claudeCodeModel ?? "");
  const [scriptProvider, setScriptProvider] = useState(settings.scriptProvider ?? "same");
  const [scriptModel, setScriptModel] = useState(
    settings.scriptModel ??
      defaultScriptModel(settings.scriptProvider ?? "same", settings.textModel),
  );
  const cli = provider === "codex" || provider === "claudeCode";
  return (
    <section className="stack" aria-label="글쓰기 AI 선택">
      <Field
        label="글쓰기 AI"
        help="기획·카피·대본·이미지 프롬프트 작성과 이미지 검토에 사용할 도구입니다."
      >
        <select
          name="textProvider"
          value={provider}
          onChange={(event) =>
            setProvider(ModelSettingsSchema.shape.textProvider.parse(event.target.value))
          }
        >
          <option value="codex">Codex</option>
          <option value="claudeCode">Claude Code</option>
          <option value="openai">OpenAI API</option>
          <option value="auto">자동 선택 · OpenAI API 우선</option>
          <option value="none">사용 안 함</option>
        </select>
      </Field>
      {cli ? (
        <>
          <Notice>
            이 컴퓨터에 설치하고 로그인한 도구를 사용합니다. 선택한 AI가 대본까지 담당하며, 실행 시
            해당 계정의 사용량이 소모됩니다.
          </Notice>
          {provider === "codex" ? (
            <Field
              label="Codex 모델 ID"
              help="Codex에서 사용할 수 있는 모델 ID를 입력하세요. 자동 제작에는 모델 지정이 필요합니다."
            >
              <input
                name="codexModel"
                required
                value={codexModel}
                onChange={(event) => setCodexModel(event.target.value)}
                placeholder="사용 가능한 Codex 모델 ID"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : (
            <Field
              label="Claude Code 모델"
              help="sonnet·opus 등 CLI 별칭이나 사용 가능한 전체 모델 ID를 입력하세요."
            >
              <input
                name="claudeCodeModel"
                required
                list="claude-code-models"
                value={claudeCodeModel}
                onChange={(event) => setClaudeCodeModel(event.target.value)}
                placeholder="예: sonnet"
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="claude-code-models">
                <option value="sonnet" />
                <option value="opus" />
              </datalist>
            </Field>
          )}
          <input type="hidden" name="scriptProvider" value="same" />
        </>
      ) : (
        <>
          <Field
            label="OpenAI 텍스트 모델"
            help="프리셋을 고르거나 사용 가능한 모델 ID를 입력하세요."
          >
            <input
              name="textModel"
              required
              list="openai-text-models"
              value={textModel}
              onChange={(event) => setTextModel(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="openai-text-models">
              {textModelPresets.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>
          <Field
            label="영상 대본 단계 공급자"
            help="API 방식에서는 대본 작성에 별도 API를 지정할 수 있습니다."
          >
            <select
              name="scriptProvider"
              value={scriptProvider}
              onChange={(event) => {
                const next = ScriptProviderSchema.parse(event.target.value);
                setScriptProvider(next);
                setScriptModel(defaultScriptModel(next, textModel));
              }}
            >
              {SCRIPT_PROVIDERS.map((value) => (
                <option key={value} value={value}>
                  {scriptProviderLabels[value]}
                </option>
              ))}
            </select>
          </Field>
          {scriptProvider !== "same" && (
            <Field
              label={
                scriptProvider === "anthropic" ? "대본 Claude API 모델 ID" : "대본 OpenAI 모델 ID"
              }
            >
              <input
                name="scriptModel"
                required
                value={scriptModel}
                onChange={(event) => setScriptModel(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
        </>
      )}
    </section>
  );
}
