import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExecutionModels, ModelResult } from "../shared/models";
import { type CliRunner, requireCliSuccess, runCliProcess } from "./cli-process";
import { MissingConnectionError, StudioError } from "./errors";
import { claudeCodeBin, codexBin } from "./provider-environment";
import { imageInput } from "./provider-image-input";
import type { TextTask } from "./text-provider";

export function codexArguments(input: {
  readonly schemaPath: string;
  readonly resultPath: string;
  readonly model: string | null;
  readonly imagePath?: string | null;
  readonly imagePaths?: readonly string[];
}): string[] {
  const images = [...(input.imagePath ? [input.imagePath] : []), ...(input.imagePaths ?? [])];
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
    ...images.flatMap((path) => ["--image", path]),
    "-",
  ];
}
export function claudeCodeArguments(schema: string, model: string | null): string[] {
  return [
    "--print",
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--input-format",
    "stream-json",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    ...(model ? ["--model", model] : []),
  ];
}
export function claudeCodeInput<T>(task: TextTask<T>): string {
  const images = [...(task.image ? [task.image] : []), ...(task.images ?? [])];
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: task.prompt },
        ...images.map((bytes) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: imageInput(bytes).mimeType,
            data: Buffer.from(bytes).toString("base64"),
          },
        })),
      ],
    },
  })}\n`;
}
const ClaudeResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  structured_output: z.unknown().optional(),
});
export async function cliText<T>(
  task: TextTask<T> & { readonly models: ExecutionModels },
  dependencies: { readonly run?: CliRunner; readonly binary?: string } = {},
): Promise<ModelResult<T>> {
  const provider = task.models.textProvider;
  if (provider !== "codex" && provider !== "claudeCode")
    throw new StudioError("cli_provider", "CLI 공급자를 선택하세요.");
  const label = provider === "codex" ? "Codex" : "Claude Code";
  const binary = dependencies.binary ?? (provider === "codex" ? codexBin : claudeCodeBin);
  if (!binary)
    throw new MissingConnectionError(
      `${label} 실행 파일을 찾을 수 없습니다. 설치 후 앱을 다시 실행하세요.`,
    );
  const run = dependencies.run ?? runCliProcess;
  const directory = join(task.directory, crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const model =
    provider === "codex" ? task.models.codexModel : (task.models.claudeCodeModel ?? null);
  const schema = JSON.stringify(z.toJSONSchema(task.schema));
  let value: unknown;
  if (provider === "codex") {
    const schemaPath = join(directory, "schema.json");
    const resultPath = join(directory, "result.json");
    await Bun.write(schemaPath, schema);
    const images = [...(task.image ? [task.image] : []), ...(task.images ?? [])];
    const imagePaths: string[] = [];
    for (const [index, bytes] of images.entries()) {
      const path = join(directory, `input-${index + 1}.${imageInput(bytes).extension}`);
      await Bun.write(path, bytes);
      imagePaths.push(path);
    }
    const result = await run({
      binary,
      args: codexArguments({ schemaPath, resultPath, model, imagePaths }),
      directory,
      stdin: task.prompt,
      signal: task.signal,
    });
    requireCliSuccess(result, label);
    value = JSON.parse(await Bun.file(resultPath).text());
  } else {
    const result = await run({
      binary,
      args: claudeCodeArguments(schema, model),
      directory,
      stdin: claudeCodeInput(task),
      signal: task.signal,
    });
    requireCliSuccess(result, label);
    const response = ClaudeResultSchema.parse(JSON.parse(result.stdout));
    if (
      response.is_error ||
      response.subtype !== "success" ||
      response.structured_output === undefined
    )
      throw new StudioError(
        "claude_code_result",
        "Claude Code가 구조화된 결과를 완료하지 못했습니다. 로그인·사용 한도·모델을 확인한 뒤 재개하세요.",
      );
    value = response.structured_output;
  }
  task.signal.throwIfAborted();
  return {
    value: task.schema.parse(value),
    model: { provider, requestedModel: model, effectiveModel: null, quality: null },
  };
}
