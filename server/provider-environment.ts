import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ImageQualitySchema, ModelIdSchema } from "../shared/models";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
  OPENAI_API_KEY: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  TYPECAST_API_KEY: z.string().default(""),
  GOOGLE_API_KEY: z.string().default(""),
  OPENAI_TEXT_MODEL: ModelIdSchema.default("gpt-5-mini"),
  OPENAI_IMAGE_MODEL: ModelIdSchema.default("gpt-image-2"),
  OPENAI_IMAGE_QUALITY: ImageQualitySchema.default("medium"),
  TYPECAST_VOICE_ID: z.union([z.literal(""), ModelIdSchema]).default(""),
  TYPECAST_TEMPO: z.coerce.number().finite().min(0.7).max(1.3).default(1),
  TEXT_PROVIDER: z.enum(["auto", "openai", "codex", "none"]).default("auto"),
  CODEX_MODEL: z.union([z.literal(""), ModelIdSchema]).default(""),
  CODEX_BIN: z.string().default(""),
  META_ACCESS_TOKEN: z.string().default(""),
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.0$/)
    .default("v26.0"),
  DATA_DIR: z.string().default("data"),
  NODE_ENV: z.string().default("development"),
});
export const env = EnvSchema.parse(process.env);
const windowsCodex = join(
  homedir(),
  ".npm-global/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
);
export const codexBin =
  env.CODEX_BIN || (existsSync(windowsCodex) ? windowsCodex : Bun.which("codex"));
export const dataDir = resolve(env.DATA_DIR);
export const envFilePath = resolve(".env");
export const credentials = {
  openai: env.OPENAI_API_KEY,
  gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
  meta: env.META_ACCESS_TOKEN,
  typecast: env.TYPECAST_API_KEY,
};

export async function persistCredentials(input: {
  readonly openaiApiKey?: string | undefined;
  readonly geminiApiKey?: string | undefined;
  readonly metaAccessToken?: string | undefined;
  readonly typecastApiKey?: string | undefined;
}): Promise<void> {
  const existing = await Bun.file(envFilePath)
    .text()
    .catch(() => "");
  let content = existing;
  for (const [key, value] of Object.entries({
    OPENAI_API_KEY: input.openaiApiKey,
    GEMINI_API_KEY: input.geminiApiKey,
    META_ACCESS_TOKEN: input.metaAccessToken,
    TYPECAST_API_KEY: input.typecastApiKey,
  })) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.trimEnd()}\n${line}\n`;
  }
  await Bun.write(envFilePath, content);
}
