import type { ConfigStatus } from "../shared/schema";
import { getModelSettings, resolveTextProvider } from "./model-settings";
import { codexBin, credentials, dataDir, env } from "./provider-environment";

export {
  codexBin,
  credentials,
  dataDir,
  env,
  envFilePath,
  persistCredentials,
} from "./provider-environment";
export function configStatus(root: string = dataDir): ConfigStatus {
  const modelSettings = getModelSettings(root);
  return {
    openai: credentials.openai.length > 0,
    gemini: credentials.gemini.length > 0,
    codex: Boolean(codexBin),
    meta: credentials.meta.length > 0,
    typecast: credentials.typecast.length > 0,
    textProvider: resolveTextProvider(modelSettings.textProvider),
    imageModel: modelSettings.imageModel,
    textModel: modelSettings.textModel,
    modelSettings,
    metaVersion: env.META_API_VERSION,
  };
}
