import type { ConfigStatus } from "../shared/schema";
import { getModelSettings, resolveTextProvider } from "./model-settings";
import { claudeCodeBin, codexBin, credentials, dataDir, env } from "./provider-environment";
import { ffmpegReady } from "./render/ffmpeg";
import { resolveFont } from "./render/fonts";

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
    claudeCode: Boolean(claudeCodeBin),
    anthropic: credentials.anthropic.length > 0,
    meta: credentials.meta.length > 0,
    typecast: credentials.typecast.length > 0,
    // ffmpeg 는 비동기 검사(ffmpegCapabilities) 가 한 번 성공한 뒤에만 true 가 된다(server/index.ts 가 기동 시 1회 실행).
    ffmpeg: ffmpegReady(),
    captionFont: resolveFont() !== null,
    textProvider: resolveTextProvider(modelSettings.textProvider),
    imageModel: modelSettings.imageModel,
    textModel: modelSettings.textModel,
    modelSettings,
    metaVersion: env.META_API_VERSION,
  };
}
