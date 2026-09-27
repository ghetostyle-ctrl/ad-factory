import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ky from "ky";
import { z } from "zod";
import { type ExecutionModels, ModelIdSchema, type ModelResult } from "../shared/models";
import { codexBin, dataDir } from "./config";
import { BlockedError, MissingConnectionError, StudioError } from "./errors";
import { snapshotModels } from "./model-settings";
import { imageInput } from "./provider-image-input";
import { type OpenAIConnection, openAIConnection } from "./provider-transport";

const ResponseSchema = z.object({
  model: ModelIdSchema.optional(),
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  output: z
    .array(
      z.object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      }),
    )
    .nullable()
    .optional(),
});
export type TextTask<T> = {
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  readonly name: string;
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly models?: ExecutionModels;
  readonly image?: Uint8Array;
  readonly maxOutputTokens?: number;
};
export async function generateText<T>(task: TextTask<T>): Promise<T> {
  return (await generateTextResult(task)).value;
}
export async function generateTextResult<T>(
  task: TextTask<T>,
  connection: OpenAIConnection = openAIConnection(),
): Promise<ModelResult<T>> {
  task.signal.throwIfAborted();
  const models = task.models ?? snapshotModels(dataDir);
  switch (models.textProvider) {
    case "openai":
      return openaiText({ ...task, models }, connection);
    case "codex":
      return codexText({ ...task, models });
    case "none":
      throw new MissingConnectionError(
        "텍스트 공급자가 없습니다. OpenAI API 키 또는 Codex CLI 로그인을 설정하세요.",
      );
    default:
      return models.textProvider satisfies never;
  }
}
async function openaiText<T>(
  task: TextTask<T> & { readonly models: ExecutionModels },
  connection: OpenAIConnection,
): Promise<ModelResult<T>> {
  if (!connection.apiKey) throw new MissingConnectionError("OpenAI API 키가 설정되지 않았습니다.");
  const input = task.image
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: task.prompt },
            { type: "input_image", image_url: imageInput(task.image).dataUrl, detail: "auto" },
          ],
        },
      ]
    : task.prompt;
  const result = ResponseSchema.parse(
    await ky
      .post(new URL("responses", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.apiKey}` },
        timeout: 180000,
        retry: 0,
        signal: task.signal,
        json: {
          model: task.models.textModel,
          input,
          max_output_tokens: task.maxOutputTokens ?? 22000,
          reasoning: { effort: "low" },
          text: {
            format: {
              type: "json_schema",
              name: task.name,
              strict: true,
              schema: z.toJSONSchema(task.schema),
            },
          },
        },
      })
      .json(),
  );
  if (result.status && result.status !== "completed")
    throw new StudioError(
      "response_incomplete",
      `AI 응답이 완료되지 않았습니다 (${result.incomplete_details?.reason ?? "원인 미상"}). 응답을 검토하세요.`,
    );
  const text = (result.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
  return {
    value: task.schema.parse(JSON.parse(text)),
    model: {
      provider: "openai",
      requestedModel: task.models.textModel,
      effectiveModel: result.model ?? null,
      quality: null,
    },
  };
}
export function codexArguments(input: {
  readonly schemaPath: string;
  readonly resultPath: string;
  readonly model: string | null;
  readonly imagePath: string | null;
}): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--disable",
    "shell_tool",
    "-c",
    "hide_agent_reasoning=true",
    "-c",
    'web_search="disabled"',
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.resultPath,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.imagePath ? ["--image", input.imagePath] : []),
    "-",
  ];
}
async function codexText<T>(
  task: TextTask<T> & { readonly models: ExecutionModels },
): Promise<ModelResult<T>> {
  if (!codexBin) throw new MissingConnectionError("Codex CLI 실행 파일을 찾을 수 없습니다.");
  const binary = codexBin;
  await mkdir(task.directory, { recursive: true });
  const invocation = crypto.randomUUID();
  const schemaPath = join(task.directory, `${invocation}.schema.json`);
  const resultPath = join(task.directory, `${invocation}.result.json`);
  const imagePath = task.image
    ? join(task.directory, `${invocation}.${imageInput(task.image).extension}`)
    : null;
  if (task.image && imagePath) await Bun.write(imagePath, task.image);
  await Bun.write(schemaPath, JSON.stringify(z.toJSONSchema(task.schema)));
  const args = codexArguments({ schemaPath, resultPath, model: task.models.codexModel, imagePath });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: task.directory,
      windowsHide: true,
      shell: false,
      env: { ...process.env, OPENAI_API_KEY: undefined, META_ACCESS_TOKEN: undefined },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const abort = () => {
      child.kill();
    };
    task.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill(), 240000);
    child.once("error", () => {
      clearTimeout(timer);
      task.signal.removeEventListener("abort", abort);
      reject(new BlockedError("Codex CLI를 시작하지 못했습니다. 설치 경로와 로그인을 확인하세요."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      task.signal.removeEventListener("abort", abort);
      if (task.signal.aborted) reject(new DOMException("Cancelled", "AbortError"));
      else if (code !== 0)
        reject(
          new StudioError(
            "codex_exit",
            "Codex CLI가 완료되지 않았습니다. codex login status와 CLI 실행 상태를 확인하세요.",
          ),
        );
      else resolve();
    });
    child.stdin.end(task.prompt);
    if (task.signal.aborted) abort();
  });
  task.signal.throwIfAborted();
  return {
    value: task.schema.parse(JSON.parse(await Bun.file(resultPath).text())),
    model: {
      provider: "codex",
      requestedModel: task.models.codexModel,
      effectiveModel: null,
      quality: null,
    },
  };
}
