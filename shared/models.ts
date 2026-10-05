import { z } from "zod";

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
const settingsFields = {
  textProvider: z.enum(["auto", "openai", "codex", "none"]),
  textModel: ModelIdSchema,
  codexModel: ModelIdSchema.nullable(),
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
export const ModelSettingsSchema = z
  .object(settingsFields)
  .strict()
  .refine(compatibleQuality, qualityError)
  .refine((value) => value.ttsSelection === "auto" || value.ttsVoiceId !== null, {
    path: ["ttsVoiceId"],
    message: "직접 선택 모드에서는 Typecast 보이스를 선택하거나 입력해야 합니다.",
  });
export type ModelSettings = Readonly<z.infer<typeof ModelSettingsSchema>>;
export const ExecutionModelsSchema = z
  .object({
    ...settingsFields,
    textProvider: z.enum(["openai", "codex", "none"]),
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
    provider: z.enum(["openai", "codex", "gemini", "typecast", "ffmpeg", "flow"]),
    requestedModel: ModelIdSchema.nullable(),
    effectiveModel: ModelIdSchema.nullable(),
    quality: ImageQualitySchema.nullable(),
  })
  .strict();
export type ArtifactModel = Readonly<z.infer<typeof ArtifactModelSchema>>;
export type ModelResult<T> = { readonly value: T; readonly model: ArtifactModel };
