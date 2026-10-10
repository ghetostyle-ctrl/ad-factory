import { z } from "zod";

export const textModelPresets = ["gpt-5-mini", "gpt-6-astra"] as const;

export const imageModelPresets = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
] as const;
export const ttsVoicePresets = [
  { id: "tc_68537c9420b646f2176890ba", name: "Seojin", tone: "젊은 여성 · 기본 광고 내레이션" },
  { id: "tc_69f2e455ea79fd197aa0476f", name: "Seohyeon", tone: "젊은 여성 · 밝은 숏폼 톤" },
  { id: "tc_6a4f2130d153a5cac8e19996", name: "Jiseon", tone: "중년 여성 · 신뢰 설명형" },
  { id: "tc_6a21054564d676539427427e", name: "Hyejin", tone: "중년 여성 · 차분한 전문가형" },
] as const;
export const imageQualities = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const ImageQualitySchema = z.enum(imageQualities);
export const TtsSelectionSchema = z.enum(["auto", "manual"]);
export const ModelIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/, {
    message:
      "모델 ID는 영문·숫자로 시작하는 최대 160자이며, 공백 없이 영문·숫자와 . _ : / -만 사용할 수 있습니다.",
  });
// 영상 콘셉트·대본·AI 검토는 공통 텍스트 설정을 따르거나 별도 OpenAI/Anthropic 모델을 쓴다.
// 예전 작업 스냅샷에는 없고 scopeDigest 가 executionModels 를 해시하므로 기본값 없이 선택 항목으로 둔다.
export const SCRIPT_PROVIDERS = ["same", "openai", "anthropic"] as const;
export const ScriptProviderSchema = z.enum(SCRIPT_PROVIDERS);
export type ScriptProvider = z.infer<typeof ScriptProviderSchema>;
export const scriptProviderLabels = {
  same: "공통 텍스트 설정 사용",
  openai: "OpenAI API",
  anthropic: "Claude (Anthropic API)",
} as const satisfies Record<ScriptProvider, string>;
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export function defaultScriptModel(provider: ScriptProvider, openAIModel: string): string {
  switch (provider) {
    case "same":
    case "openai":
      return /^claude-/i.test(openAIModel) ? "gpt-5-mini" : openAIModel;
    case "anthropic":
      return DEFAULT_ANTHROPIC_MODEL;
    default:
      return provider satisfies never;
  }
}
const settingsFields = {
  textProvider: z.enum(["auto", "openai", "codex", "claudeCode", "none"]),
  textModel: ModelIdSchema,
  codexModel: ModelIdSchema.nullable(),
  claudeCodeModel: ModelIdSchema.nullable().optional(),
  scriptProvider: ScriptProviderSchema.optional(),
  scriptModel: ModelIdSchema.optional(),
  imageProvider: z.enum(["openai", "flow"]).optional(),
  imageModel: ModelIdSchema,
  imageQuality: ImageQualitySchema,
  ttsProvider: z.literal("typecast"),
  ttsSelection: TtsSelectionSchema,
  ttsVoiceId: ModelIdSchema.nullable(),
  ttsTempo: z.number().finite().min(0.7).max(1.3),
};
export function supportsImageQuality(
  model: string,
  quality: z.infer<typeof ImageQualitySchema>,
): boolean {
  return (
    !["xhigh", "max"].includes(quality) ||
    model === "gpt-image-2.5-sunburst" ||
    model === "gpt-image-2.5-flare"
  );
}
const compatibleQuality = (value: {
  readonly imageModel: string;
  readonly imageQuality: z.infer<typeof ImageQualitySchema>;
}) => supportsImageQuality(value.imageModel, value.imageQuality);
const qualityError = {
  path: ["imageQuality"],
  message: "xhigh/max 품질은 GPT Image 2.5 프리셋에서만 지원합니다.",
};
const compatibleScriptModel = (value: {
  readonly scriptProvider?: ScriptProvider | undefined;
  readonly scriptModel?: string | undefined;
}): boolean => {
  switch (value.scriptProvider) {
    case "openai":
      return !/^claude-/i.test(value.scriptModel ?? "");
    case "anthropic":
      return !/^(gpt-|o[134](?:-|$))/i.test(value.scriptModel ?? "");
    case "same":
    case undefined:
      return true;
    default:
      return value.scriptProvider satisfies never;
  }
};
const scriptModelError = {
  path: ["scriptModel"],
  message:
    "대본 공급자에 맞는 모델 ID를 입력하세요. OpenAI에는 OpenAI 모델, Anthropic에는 Claude 모델을 사용합니다.",
};
export const ModelSettingsSchema = z
  .object(settingsFields)
  .strict()
  .refine(compatibleQuality, qualityError)
  .refine(compatibleScriptModel, scriptModelError)
  .refine((value) => value.ttsSelection === "auto" || value.ttsVoiceId !== null, {
    path: ["ttsVoiceId"],
    message: "직접 선택 모드에서는 Typecast 보이스를 선택하거나 입력해야 합니다.",
  });
export type ModelSettings = Readonly<z.infer<typeof ModelSettingsSchema>>;
// 고정된 예전 작업의 ID는 그대로 읽는다. 공급자별 ID 검사는 새 설정 저장 경계에서만 한다.
export const ExecutionModelsSchema = z
  .object({
    ...settingsFields,
    textProvider: z.enum(["openai", "codex", "claudeCode", "none"]),
    capturedAt: z.iso.datetime(),
  })
  .strict()
  .refine(compatibleQuality, qualityError)
  .refine((value) => value.ttsSelection === "auto" || value.ttsVoiceId !== null, {
    path: ["ttsVoiceId"],
    message: "직접 선택 모드에서는 Typecast 보이스를 선택하거나 입력해야 합니다.",
  })
  .readonly();
export type ExecutionModels = z.infer<typeof ExecutionModelsSchema>;
export const ArtifactModelSchema = z
  .object({
    // typecast: 내레이션 합성, ffmpeg: 로컬 렌더(모션그래픽·최종 조립), flow: 사용자가 Google Flow 웹에서 만든 클립
    provider: z.enum([
      "openai",
      "codex",
      "claudeCode",
      "anthropic",
      "gemini",
      "typecast",
      "ffmpeg",
      "flow",
    ]),
    requestedModel: ModelIdSchema.nullable(),
    effectiveModel: ModelIdSchema.nullable(),
    quality: ImageQualitySchema.nullable(),
  })
  .strict();
export type ArtifactModel = Readonly<z.infer<typeof ArtifactModelSchema>>;
export type ModelResult<T> = { readonly value: T; readonly model: ArtifactModel };
