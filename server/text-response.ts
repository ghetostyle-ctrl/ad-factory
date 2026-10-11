import type { z } from "zod";
import type { ArtifactModel, ModelResult } from "../shared/models";

export type TextResponse = {
  readonly text: string;
  readonly model: ArtifactModel;
};
export type TextResponseParser<T> = (response: TextResponse) => Promise<T>;

export async function parseTextResponse<T>(
  schema: z.ZodType<T>,
  response: TextResponse,
  parser?: TextResponseParser<T>,
): Promise<ModelResult<T>> {
  return {
    value: parser ? await parser(response) : schema.parse(JSON.parse(response.text)),
    model: response.model,
  };
}
