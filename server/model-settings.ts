import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExecutionModels,
  ExecutionModelsSchema,
  type ModelSettings,
  ModelSettingsSchema,
} from "../shared/models";
import { codexBin, credentials, env } from "./provider-environment";

export function getModelSettings(root: string): ModelSettings {
  const path = join(root, "model-settings.json");
  return ModelSettingsSchema.parse(
    existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : {
          textProvider: env.TEXT_PROVIDER,
          textModel: env.OPENAI_TEXT_MODEL,
          codexModel: env.CODEX_MODEL || null,
          claudeCodeModel: env.CLAUDE_CODE_MODEL || null,
          imageModel: env.OPENAI_IMAGE_MODEL,
          imageQuality: env.OPENAI_IMAGE_QUALITY,
          ttsProvider: "typecast",
          ttsSelection: env.TYPECAST_VOICE_ID ? "manual" : "auto",
          ttsVoiceId: env.TYPECAST_VOICE_ID || null,
          ttsTempo: env.TYPECAST_TEMPO,
        },
  );
}
export function saveModelSettings(root: string, input: unknown): ModelSettings {
  const settings = ModelSettingsSchema.parse(input);
  mkdirSync(root, { recursive: true });
  const temporary = join(root, `model-settings-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, join(root, "model-settings.json"));
  return settings;
}
export function resolveTextProvider(
  requested: ModelSettings["textProvider"],
): ExecutionModels["textProvider"] {
  switch (requested) {
    case "auto":
      return credentials.openai ? "openai" : codexBin ? "codex" : "none";
    case "openai":
      return "openai";
    case "codex":
      return "codex";
    case "claudeCode":
      return "claudeCode";
    case "none":
      return "none";
    default:
      return requested satisfies never;
  }
}
export function snapshotModels(root: string): ExecutionModels {
  const settings = getModelSettings(root);
  return ExecutionModelsSchema.parse({
    ...settings,
    textProvider: resolveTextProvider(settings.textProvider),
    ...(["codex", "claudeCode"].includes(settings.textProvider)
      ? { scriptProvider: "same", scriptModel: undefined }
      : {}),
    capturedAt: new Date().toISOString(),
  });
}
