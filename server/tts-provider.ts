import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import type { ExecutionModels, ModelResult } from "../shared/models";
import { probeAudio } from "./audio-probe";
import { MissingConnectionError, StudioError } from "./errors";
import { type TypecastConnection, typecastConnection } from "./provider-transport";

// Typecast 문장 합성 공급자. with-timestamps(JSON+base64 WAV) 하나만 쓴다(단어 타임스탬프 확보).
export const TYPECAST_MODEL = "ssfm-v30";
export const TYPECAST_TARGET_LUFS = -16;
const MAX_WAV_BYTES = 60 * 1024 * 1024;
// 응답 audio_duration 과 ffprobe 실측 길이가 이 이상 어긋나면 응답을 믿지 않는다.
const DURATION_TOLERANCE_MS = 50;

export type VoiceTask = {
  readonly text: string;
  readonly previousText?: string;
  readonly nextText?: string;
  readonly voiceId: string;
  readonly tempo: number;
  readonly signal: AbortSignal;
  readonly models: ExecutionModels;
};
export type VoiceWord = { text: string; start: number; end: number };
export type VoiceAudio = {
  readonly audio: Uint8Array;
  readonly durationMs: number;
  readonly words: VoiceWord[];
};
export type VoiceProvider = (task: VoiceTask) => Promise<ModelResult<VoiceAudio>>;

const TypecastTimestampsSchema = z.object({
  audio: z.string().min(1),
  audio_format: z.enum(["wav", "mp3"]),
  audio_duration: z.number().nonnegative(),
  words: z
    .array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
    .nullable()
    .optional(),
});
const SubscriptionSchema = z.object({
  plan: z.string(),
  credits: z.object({ plan_credits: z.number(), used_credits: z.number() }),
  limits: z.object({ concurrency_limit: z.number().int().positive() }),
});
export type TypecastSubscription = {
  readonly plan: string;
  readonly planCredits: number;
  readonly usedCredits: number;
  readonly concurrencyLimit: number;
};
export type SubscriptionProvider = () => Promise<TypecastSubscription>;

// 이모지·제어문자 제거, 공백 정리. 숫자·영문의 한글 표기는 대본 프롬프트 책임이다.
export function normalizeNarration(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function requireKey(connection: TypecastConnection): void {
  if (!connection.apiKey)
    throw new MissingConnectionError(
      "내레이션 합성에는 Typecast API 키가 필요합니다. 연결 설정에서 키를 입력하면 재개할 수 있습니다.",
    );
}
async function detail(error: HTTPError): Promise<string> {
  try {
    const parsed = z
      .object({ detail: z.unknown().optional(), message: z.string().optional() })
      .parse(await error.response.clone().json());
    return typeof parsed.detail === "string" ? parsed.detail : (parsed.message ?? "");
  } catch {
    return "";
  }
}
// HTTP 상태 → 앱 오류. 401 은 키 재입력(blocked), 402/422/429 는 코드로 구분해 호출부가 처리한다.
export async function typecastError(error: unknown): Promise<Error> {
  if (!(error instanceof HTTPError))
    return error instanceof Error ? error : new Error(String(error));
  const status = error.response.status;
  const message = await detail(error);
  switch (status) {
    case 401:
      return new MissingConnectionError(
        "Typecast API 키가 거부되었습니다. 연결 설정에서 다시 입력하세요.",
      );
    case 402:
      return new StudioError(
        "typecast_credit",
        "Typecast 크레딧이 부족합니다. 충전 후 작업을 재개하세요.",
      );
    case 422:
      return new StudioError(
        "typecast_text",
        `Typecast 가 문장을 합성할 수 없습니다${message ? `: ${message}` : ""}.`,
      );
    case 429:
      return new StudioError("typecast_rate", "Typecast 동시 요청 한도를 넘었습니다.");
    default:
      return new StudioError(
        "typecast_request",
        `Typecast 요청 실패 (HTTP ${status})${message ? `: ${message}` : ""}. 연결·권한·잔액을 확인하세요.`,
      );
  }
}
function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 44 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  );
}

export async function generateVoiceResult(
  task: VoiceTask,
  connection: TypecastConnection = typecastConnection(),
): Promise<ModelResult<VoiceAudio>> {
  task.signal.throwIfAborted();
  requireKey(connection);
  if (!Number.isFinite(task.tempo) || task.tempo < 0.7 || task.tempo > 1.3)
    throw new StudioError("typecast_tempo", "Typecast 내레이션 속도는 0.7~1.3 범위여야 합니다.");
  const text = normalizeNarration(task.text);
  if (!text) throw new StudioError("typecast_text", "합성할 문장이 비어 있습니다.");
  const url = new URL("v1/text-to-speech/with-timestamps", connection.baseUrl);
  url.searchParams.set("granularity", "word");
  let raw: unknown;
  try {
    raw = await ky
      .post(url, {
        headers: { "X-API-KEY": connection.apiKey, "Content-Type": "application/json" },
        retry: 0,
        timeout: 120_000,
        signal: task.signal,
        json: {
          voice_id: task.voiceId,
          text,
          model: TYPECAST_MODEL,
          language: "kor",
          prompt: {
            emotion_type: "smart",
            ...(task.previousText ? { previous_text: normalizeNarration(task.previousText) } : {}),
            ...(task.nextText ? { next_text: normalizeNarration(task.nextText) } : {}),
          },
          // volume 은 target_lufs 와 같이 보낼 수 없다.
          output: {
            audio_format: "wav",
            audio_tempo: task.tempo,
            target_lufs: TYPECAST_TARGET_LUFS,
          },
        },
      })
      .json();
  } catch (error) {
    throw await typecastError(error);
  }
  const parsed = TypecastTimestampsSchema.parse(raw);
  if (parsed.audio_format !== "wav")
    throw new StudioError("typecast_format", "Typecast 가 WAV 가 아닌 형식을 반환했습니다.");
  const audio = new Uint8Array(Buffer.from(parsed.audio, "base64"));
  if (!isWav(audio) || audio.length > MAX_WAV_BYTES)
    throw new StudioError("typecast_format", "Typecast 응답이 올바른 WAV 파일이 아닙니다.");
  const durationMs = await crossCheckDuration(audio, parsed.audio_duration, task.signal);
  return {
    value: {
      audio,
      durationMs,
      words: (parsed.words ?? []).map((word) => ({
        text: word.text,
        start: word.start,
        end: word.end,
      })),
    },
    model: {
      provider: "typecast",
      requestedModel: TYPECAST_MODEL,
      effectiveModel: TYPECAST_MODEL,
      quality: null,
    },
  };
}
// 응답의 audio_duration 과 ffprobe 실측을 교차검증(±50ms). 실측값을 타임라인에 쓴다.
async function crossCheckDuration(
  audio: Uint8Array,
  declaredSec: number,
  signal: AbortSignal,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "typecast-check-"));
  try {
    const path = join(directory, "voice.wav");
    await Bun.write(path, audio);
    const probed = await probeAudio(path, signal);
    if (Math.abs(probed.durationMs - declaredSec * 1000) > DURATION_TOLERANCE_MS)
      throw new StudioError(
        "typecast_duration",
        `Typecast 응답 길이(${declaredSec.toFixed(3)}초)와 파일 실측(${(probed.durationMs / 1000).toFixed(3)}초)이 다릅니다.`,
      );
    return probed.durationMs;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function getSubscription(
  connection: TypecastConnection = typecastConnection(),
): Promise<TypecastSubscription> {
  requireKey(connection);
  let raw: unknown;
  try {
    raw = await ky
      .get(new URL("v1/users/me/subscription", connection.baseUrl), {
        headers: { "X-API-KEY": connection.apiKey },
        retry: 0,
        timeout: 30_000,
      })
      .json();
  } catch (error) {
    throw await typecastError(error);
  }
  const parsed = SubscriptionSchema.parse(raw);
  return {
    plan: parsed.plan,
    planCredits: parsed.credits.plan_credits,
    usedCredits: parsed.credits.used_credits,
    concurrencyLimit: parsed.limits.concurrency_limit,
  };
}
