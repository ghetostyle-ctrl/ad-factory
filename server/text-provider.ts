import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import ky from "ky";
import { z } from "zod";
import {
  DEFAULT_ANTHROPIC_MODEL,
  defaultScriptModel,
  type ExecutionModels,
  ModelIdSchema,
  type ModelResult,
} from "../shared/models";
import { codexBin, credentials, dataDir } from "./config";
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
  // image 는 기존 호출부 호환(한 장). 여러 장(참조 이미지 + 후보)은 images 로 넘긴다. 둘 다 있으면 image 가 먼저.
  readonly image?: Uint8Array;
  readonly images?: readonly Uint8Array[];
  readonly maxOutputTokens?: number;
  // 영상 콘셉트·대본·검토는 scriptProvider 의 별도 공급자·모델 설정을 따른다.
  readonly stage?: "script";
};
function attachedImages<T>(task: TextTask<T>): Uint8Array[] {
  return [...(task.image ? [task.image] : []), ...(task.images ?? [])];
}
export async function generateText<T>(task: TextTask<T>): Promise<T> {
  return (await generateTextResult(task)).value;
}
export async function generateTextResult<T>(
  task: TextTask<T>,
  connection: OpenAIConnection = openAIConnection(),
): Promise<ModelResult<T>> {
  task.signal.throwIfAborted();
  const models = task.models ?? snapshotModels(dataDir);
  const scriptProvider = task.stage === "script" ? (models.scriptProvider ?? "same") : "same";
  switch (scriptProvider) {
    case "anthropic":
      return anthropicText({ ...task, models });
    case "openai":
      return openaiText(
        {
          ...task,
          models: {
            ...models,
            textModel: models.scriptModel ?? defaultScriptModel("openai", models.textModel),
          },
        },
        connection,
      );
    case "same":
      break;
    default:
      return scriptProvider satisfies never;
  }
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
  const images = attachedImages(task);
  const input =
    images.length > 0
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: task.prompt },
              ...images.map((image) => ({
                type: "input_image",
                image_url: imageInput(image).dataUrl,
                detail: "auto",
              })),
            ],
          },
        ]
      : task.prompt;
  const result = ResponseSchema.parse(
    await ky
      .post(new URL("responses", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.apiKey}` },
        // 큰 기획 JSON은 3분을 넘길 수 있다. 사용자 취소와 재시도 0회는 그대로 유지한다.
        timeout: 10 * 60 * 1000,
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
// Claude(Anthropic) 구조화 응답: 공식 SDK 의 messages.parse + zodOutputFormat. 생각은 모델 기본(adaptive)·effort medium.
// 이미지는 base64 블록으로 붙인다. 키는 .env 의 ANTHROPIC_API_KEY(또는 연결 화면)에서만 읽는다.
async function anthropicText<T>(
  task: TextTask<T> & { readonly models: ExecutionModels },
): Promise<ModelResult<T>> {
  if (!credentials.anthropic)
    throw new MissingConnectionError(
      "Anthropic API 키가 설정되지 않았습니다. 연결 화면에서 ANTHROPIC_API_KEY 를 추가하세요.",
    );
  const model = task.models.scriptModel ?? DEFAULT_ANTHROPIC_MODEL;
  const client = new Anthropic({ apiKey: credentials.anthropic, maxRetries: 1 });
  const images = attachedImages(task);
  const content: Anthropic.ContentBlockParam[] = [
    ...images.map((image): Anthropic.ImageBlockParam => {
      const input = imageInput(image);
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: input.mimeType as Anthropic.Base64ImageSource["media_type"],
          data: input.dataUrl.slice(input.dataUrl.indexOf(",") + 1),
        },
      };
    }),
    { type: "text", text: task.prompt },
  ];
  const response = await client.messages.parse(
    {
      model,
      max_tokens: Math.max(4096, task.maxOutputTokens ?? 22000),
      messages: [{ role: "user", content }],
      output_config: { effort: "medium", format: zodOutputFormat(task.schema) },
    },
    // SDK 는 max_tokens 가 크면 명시적 timeout 없이 비스트리밍 호출을 거부한다. 대본 1회는 수 분 안에 끝난다.
    { signal: task.signal, timeout: 15 * 60 * 1000 },
  );
  if (response.stop_reason === "refusal")
    throw new StudioError(
      "response_refused",
      `Claude 가 요청을 거부했습니다(${response.stop_details?.category ?? "분류 없음"}).`,
    );
  if (response.stop_reason === "max_tokens")
    throw new StudioError(
      "response_incomplete",
      "AI 응답이 토큰 한도에서 끊겼습니다. 응답을 검토하세요.",
    );
  if (response.parsed_output === null || response.parsed_output === undefined)
    throw new StudioError(
      "response_incomplete",
      "Claude 응답을 구조화된 형식으로 읽지 못했습니다.",
    );
  return {
    value: task.schema.parse(response.parsed_output),
    model: {
      provider: "anthropic",
      requestedModel: model,
      effectiveModel: response.model,
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
  // 제한: Codex CLI 경로는 --image 한 장만 넘긴다(첫 장). 참조 이미지 비교 검토는 OpenAI 경로에서만 완전하다.
  const [firstImage] = attachedImages(task);
  const imagePath = firstImage
    ? join(task.directory, `${invocation}.${imageInput(firstImage).extension}`)
    : null;
  if (firstImage && imagePath) await Bun.write(imagePath, firstImage);
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
