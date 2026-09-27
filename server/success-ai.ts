import ky, { HTTPError, type KyInstance, TimeoutError } from "ky";
import { ZodError } from "zod";
import {
  type SuccessAiExport,
  SuccessAiExportSchema,
  type SuccessAiPreview,
} from "../shared/sources";
import { StudioError } from "./errors";
import { logger } from "./logger";

export async function previewSuccessAi(
  input: SuccessAiPreview,
  transport: KyInstance = ky,
): Promise<SuccessAiExport> {
  try {
    const response = await transport.get("http://localhost:3000/api/references/export", {
      searchParams: { platform: input.platform, keyword: input.keyword, limit: input.limit },
      redirect: "error",
      retry: 0,
      timeout: 10000,
      signal: AbortSignal.timeout(10000),
    });
    if (Number(response.headers.get("content-length")) > 2000000)
      throw new StudioError(
        "reference_size",
        "레퍼런스 응답이 너무 큽니다. 가져올 개수를 줄이세요.",
        413,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new StudioError("reference_format", "Success AI 응답이 비어 있습니다.", 503);
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 2000000) {
          await reader.cancel();
          throw new StudioError(
            "reference_size",
            "레퍼런스 응답이 너무 큽니다. 가져올 개수를 줄이세요.",
            413,
          );
        }
        body += decoder.decode(result.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const exported = SuccessAiExportSchema.parse(JSON.parse(body));
    if (exported.items.length > input.limit)
      throw new StudioError(
        "reference_limit",
        "Success AI가 요청한 개수보다 많은 자료를 반환했습니다.",
        503,
      );
    return exported;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    if (error instanceof HTTPError && error.response.status === 404)
      throw new StudioError(
        "reference_missing",
        "저장된 브랜드·키워드와 광고 자료를 Success AI에서 확인하세요.",
        404,
      );
    if (error instanceof ZodError || error instanceof SyntaxError) {
      logger.warn(
        { code: "reference_format", platform: input.platform },
        "reference.preview_failed",
      );
      throw new StudioError(
        "reference_format",
        "Success AI 내보내기 형식이 맞지 않습니다. 연결된 앱을 업데이트하세요.",
        503,
      );
    }
    if (
      error instanceof HTTPError ||
      error instanceof TimeoutError ||
      error instanceof TypeError ||
      (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    ) {
      logger.warn(
        { code: "reference_unavailable", platform: input.platform },
        "reference.preview_failed",
      );
      throw new StudioError(
        "reference_unavailable",
        "Success AI 연결을 완료하지 못했습니다. 로컬 3000 포트의 앱 실행 상태를 확인하세요.",
        503,
      );
    }
    throw error;
  }
}
