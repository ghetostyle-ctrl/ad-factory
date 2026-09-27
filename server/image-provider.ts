import ky from "ky";
import { z } from "zod";
import { type ExecutionModels, ModelIdSchema, type ModelResult } from "../shared/models";
import { dataDir } from "./config";
import { BlockedError, MissingConnectionError } from "./errors";
import { snapshotModels } from "./model-settings";
import { imageInput } from "./provider-image-input";
import { type OpenAIConnection, openAIConnection } from "./provider-transport";

const ImagesSchema = z.object({
  model: ModelIdSchema.optional(),
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});
export type ImageTask = {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly models: ExecutionModels;
};
export async function generateImage(prompt: string, signal: AbortSignal): Promise<Uint8Array> {
  return (await generateImageResult({ prompt, signal, models: snapshotModels(dataDir) })).value;
}
export async function generateImageResult(
  task: ImageTask,
  connection: OpenAIConnection = openAIConnection(),
): Promise<ModelResult<Uint8Array>> {
  task.signal.throwIfAborted();
  if (!connection.apiKey)
    throw new MissingConnectionError(
      "자동 이미지 생성에 OpenAI API 키가 필요합니다. 연결 설정에서 키를 입력하면 재개할 수 있습니다.",
    );
  const result = ImagesSchema.parse(
    await ky
      .post(new URL("images/generations", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.apiKey}` },
        timeout: 300000,
        retry: 0,
        signal: task.signal,
        json: {
          model: task.models.imageModel,
          prompt: task.prompt,
          n: 1,
          size: "1024x1024",
          quality: task.models.imageQuality,
          output_format: "png",
        },
      })
      .json(),
  );
  const first = result.data[0];
  if (!first) throw new BlockedError("이미지 공급자가 결과를 반환하지 않았습니다.");
  const value = new Uint8Array(Buffer.from(first.b64_json, "base64"));
  imageInput(value);
  return {
    value,
    model: {
      provider: "openai",
      requestedModel: task.models.imageModel,
      effectiveModel: result.model ?? null,
      quality: task.models.imageQuality,
    },
  };
}
