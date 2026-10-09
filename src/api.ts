import ky, { HTTPError } from "ky";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { type InstructionsStatus, InstructionsStatusSchema } from "../shared/instructions-status";
import type { Job, StudioState } from "../shared/schema";
import { JobSchema, StateSchema } from "../shared/schema";
import { setThresholds } from "../shared/thresholds";

export const api = ky.create({ prefixUrl: "/api", timeout: 30000, retry: 0 });
// 지시 파일 상태(GET /api/instructions). 임계값(thresholds.json 의 지금 값)을 화면의 규칙 미리 검사(ScriptEditor 의
// classifyScriptProblems 등)에 주입한다 — 서버가 같은 값으로 검사하므로 저장 전 경고와 서버 400 이 어긋나지 않는다.
export async function fetchInstructions(): Promise<InstructionsStatus> {
  const status = InstructionsStatusSchema.parse(await api.get("instructions").json());
  if (status.loaded) setThresholds(status.thresholds);
  return status;
}
const ApiErrorSchema = z.object({ error: z.string() });
export async function errorMessage(error: unknown): Promise<string> {
  if (error instanceof HTTPError) {
    const body: unknown = await error.response.json().catch(() => null);
    const parsed = ApiErrorSchema.safeParse(body);
    return parsed.success
      ? parsed.data.error
      : `요청을 완료하지 못했습니다. (${error.response.status})`;
  }
  return error instanceof Error ? error.message : "요청을 완료하지 못했습니다. 다시 시도해 주세요.";
}
export async function postJob(path: string, body?: unknown): Promise<Job> {
  return JobSchema.parse(await api.post(path, body === undefined ? {} : { json: body }).json());
}
export function useStudio() {
  const [state, setState] = useState<StudioState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setState(StateSchema.parse(await api.get("state").json()));
      setError(null);
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    // 임계값 주입은 실패해도 화면은 기본값으로 검사한다(서버가 최종 판정).
    void fetchInstructions().catch(() => undefined);
    const stream = new EventSource("/api/events");
    stream.onopen = () => setLive(true);
    stream.onerror = () => setLive(false);
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed = StateSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) {
          setState(parsed.data);
          setLoading(false);
          setError(null);
        } else setError("서버 상태 형식을 읽지 못했습니다. 새로고침해 주세요.");
      } catch (cause) {
        if (cause instanceof Error) setError("실시간 상태를 읽지 못했습니다. 새로고침해 주세요.");
      }
    };
    stream.addEventListener("state", receive);
    return () => {
      stream.close();
    };
  }, [refresh]);
  return { state, error, loading, live, refresh };
}
const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function timeLabel(value: string): string {
  return timeFormatter.format(new Date(value));
}
export function moneyLabel(amount: number, currency: string): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KRW" || currency === "JPY" ? 0 : 2,
  }).format(amount);
}
