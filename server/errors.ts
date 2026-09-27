import { HTTPError, TimeoutError } from "ky";
import { ZodError } from "zod";

export class StudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 503 = 409,
  ) {
    super(message);
    this.name = "StudioError";
  }
}
export class BlockedError extends StudioError {
  constructor(message: string) {
    super("blocked", message);
    this.name = "BlockedError";
  }
}
export class MissingConnectionError extends BlockedError {
  constructor(message: string) {
    super(message);
    this.name = "MissingConnectionError";
  }
}
export function publicError(error: unknown): string {
  if (error instanceof StudioError) return error.message;
  if (error instanceof HTTPError)
    return `공급자 요청 실패 (HTTP ${error.response.status}). 서버 설정과 공급자 권한을 확인하세요.`;
  if (error instanceof TimeoutError)
    return "공급자 응답 시간이 초과되었습니다. 외부 결과를 확인한 후 다시 시도하세요.";
  if (error instanceof ZodError) return "입력 또는 공급자 응답이 지원 형식과 일치하지 않습니다.";
  if (error instanceof Error && error.name === "AbortError") return "작업이 취소되었습니다.";
  return "작업 처리에 실패했습니다. 서버 진단 로그를 확인하세요.";
}
