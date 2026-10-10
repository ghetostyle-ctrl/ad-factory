import { defaultScriptModel, scriptProviderLabels } from "../shared/models";
import type { Artifact, Job } from "../shared/schema";

export function ModelProvenance({ job }: { readonly job: Job }) {
  const models = job.executionModels;
  if (!models)
    return (
      <p className="muted small-copy">작업 시작 시 선택한 모델이 고정되어 여기에 기록됩니다.</p>
    );
  return (
    <details className="settings-details">
      <summary>이 작업에 고정된 AI 모델</summary>
      <dl className="definition-list">
        <div>
          <dt>텍스트 공급자</dt>
          <dd>{models.textProvider}</dd>
        </div>
        <div>
          <dt>텍스트 모델</dt>
          <dd className="mono">
            {models.textProvider === "codex"
              ? (models.codexModel ?? "CLI 기본 모델 · ID 미확인")
              : models.textProvider === "claudeCode"
                ? (models.claudeCodeModel ?? "CLI 기본 모델 · ID 미확인")
                : models.textProvider === "none"
                  ? "사용 안 함"
                  : models.textModel}
          </dd>
        </div>
        {models.scriptProvider && models.scriptProvider !== "same" && (
          <>
            <div>
              <dt>영상 대본 공급자</dt>
              <dd>{scriptProviderLabels[models.scriptProvider]}</dd>
            </div>
            <div>
              <dt>영상 대본 모델</dt>
              <dd className="mono">
                {models.scriptModel ?? defaultScriptModel(models.scriptProvider, models.textModel)}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>이미지 제작 방식</dt>
          <dd>
            {models.imageProvider === "flow"
              ? "Google Flow · 직접 제작 후 업로드"
              : `OpenAI · ${models.imageModel}`}
          </dd>
        </div>
        <div>
          <dt>이미지 품질</dt>
          <dd>{models.imageProvider === "flow" ? "Flow에서 선택" : models.imageQuality}</dd>
        </div>
        <div>
          <dt>설정 고정 시각</dt>
          <dd>{new Date(models.capturedAt).toLocaleString("ko-KR")}</dd>
        </div>
      </dl>
    </details>
  );
}

const providerLabels = {
  openai: "OpenAI",
  codex: "Codex CLI",
  claudeCode: "Claude Code",
  anthropic: "Claude (Anthropic)",
  gemini: "Gemini(Veo)",
  typecast: "Typecast",
  ffmpeg: "로컬 렌더(ffmpeg)",
  flow: "Google Flow(웹 수동 제작)",
} as const satisfies Record<NonNullable<Artifact["model"]>["provider"], string>;
export function ArtifactProvenance({ artifact }: { readonly artifact: Artifact }) {
  const model = artifact.model;
  if (!model) return null;
  return (
    <dl className="definition-list">
      <div>
        <dt>생성 공급자</dt>
        <dd>{providerLabels[model.provider]}</dd>
      </div>
      <div>
        <dt>요청 모델</dt>
        <dd className="mono">{model.requestedModel ?? "CLI 기본 모델 · ID 미확인"}</dd>
      </div>
      <div>
        <dt>응답 모델</dt>
        <dd className="mono">{model.effectiveModel ?? "공급자 응답에 모델 ID 없음"}</dd>
      </div>
      {model.quality && (
        <div>
          <dt>요청 이미지 품질</dt>
          <dd>{model.quality}</dd>
        </div>
      )}
    </dl>
  );
}
