import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ModelResult } from "../shared/models";
import { BlockedError, MissingConnectionError, StudioError } from "./errors";
import { probeProductionVideo } from "./production-video-probe";
import { credentials } from "./provider-environment";

const OperationSchema = z.object({
  name: z.string(),
  done: z.boolean().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  response: z
    .object({
      generateVideoResponse: z.object({
        generatedSamples: z.array(z.object({ video: z.object({ uri: z.url() }) })),
      }),
    })
    .optional(),
});
const baseUrl = "https://generativelanguage.googleapis.com/v1beta/";
const maxVideoBytes = 100 * 1024 * 1024;
// 폴링 데드라인은 await 를 시작한 시점 기준(생성 요청 시각 기준이 아님): 서버 재시작 후 재개해도 20분을 다시 준다.
export const VEO_POLL_DEADLINE_MS = 20 * 60000;
export const VEO_POLL_INTERVAL_MS = 10000;
export type VideoModel =
  | "veo-3.1-lite-generate-preview"
  | "veo-3.1-fast-generate-preview"
  | "veo-3.1-generate-preview";
export type VideoResolution = "720p" | "1080p";
export type VeoConnection = { readonly apiKey: string; readonly baseUrl: string };
// 생성 요청(POST)만 하는 작업
export type VideoCreateTask = {
  readonly image: Uint8Array;
  readonly prompt: string;
  readonly model: VideoModel;
  readonly signal: AbortSignal;
  readonly resolution?: VideoResolution;
};
// 저장된 핸들로 폴링·다운로드·검증만 하는 작업
export type VideoAwaitTask = {
  readonly operationName: string;
  readonly startedAt: string;
  readonly signal: AbortSignal;
  readonly pollDeadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly model?: VideoModel;
};
// 예전 단일 함수 호환: create → await 를 한 번에
export type VideoTask = VideoCreateTask & {
  readonly operationName?: string;
  readonly startedAt?: string;
  readonly onOperationName?: (name: string) => void;
};

export function veoConnection(): VeoConnection {
  return { apiKey: credentials.gemini, baseUrl };
}
function requireKey(connection: VeoConnection): void {
  if (!connection.apiKey)
    throw new MissingConnectionError(
      "Veo 영상 제작에는 Gemini API 키가 필요합니다. 연결 설정에서 입력해 주세요.",
    );
}
function headersFor(connection: VeoConnection) {
  return { "x-goog-api-key": connection.apiKey, "Content-Type": "application/json" };
}
const requestSignal = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(60000)]);

// 시작 이미지를 inlineData 로 보낸다. 매직 바이트만 보고 PNG/JPEG 를 구분한다(검토용 imageInput 보다 느슨:
// 테스트 픽스처는 4바이트 서명만 쓴다).
export function inlineImage(bytes: Uint8Array): { mimeType: string; data: string } {
  if (bytes.length > 15 * 1024 * 1024)
    throw new StudioError("image_size", "Veo 시작 이미지는 15MB 이하여야 합니다.");
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg)
    throw new StudioError("image_format", "Veo 시작 이미지는 PNG 또는 JPEG 여야 합니다.");
  return {
    mimeType: png ? "image/png" : "image/jpeg",
    data: Buffer.from(bytes).toString("base64"),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response
      .clone()
      .text()
      .catch(() => "")
      .then((text) => {
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          return parsed.error?.message ?? "";
        } catch {
          return "";
        }
      });
    throw new StudioError(
      "veo_request",
      `Veo 요청 실패 (HTTP ${response.status})${detail ? `: ${detail}` : ""}. 연결·권한·잔액을 확인하세요.`,
    );
  }
  return response.json();
}
async function boundedVideo(response: Response): Promise<Uint8Array> {
  if (!response.ok)
    throw new StudioError("veo_download", `Veo 영상 다운로드 실패 (HTTP ${response.status}).`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxVideoBytes)
    throw new StudioError("veo_size", "Veo 영상 파일이 100MiB를 넘었습니다.");
  const reader = response.body?.getReader();
  if (!reader) throw new BlockedError("Veo 영상 본문이 없습니다.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maxVideoBytes) {
      await reader.cancel();
      throw new StudioError("veo_size", "Veo 영상 파일이 100MiB를 넘었습니다.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function verifyVideo(bytes: Uint8Array): Promise<void> {
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp")
    throw new StudioError("veo_format", "Veo가 올바른 MP4 파일을 반환하지 않았습니다.");
  const directory = await mkdtemp(join(tmpdir(), "veo-check-"));
  try {
    const path = join(directory, "output.mp4");
    await Bun.write(path, bytes);
    const video = await probeProductionVideo(path, "mp4");
    if (video.width >= video.height || video.durationSec < 7 || video.durationSec > 9)
      throw new StudioError("veo_format", "Veo 결과가 8초 세로 MP4 규격에 맞지 않습니다.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// image-to-video 생성 요청. 모델 ID 는 그대로 보낸다(Lite 선택 시 Lite 요금). 반환 핸들은 호출자가 저장한다.
export async function createVideoOperation(
  task: VideoCreateTask,
  connection: VeoConnection = veoConnection(),
): Promise<{ name: string; startedAt: string }> {
  requireKey(connection);
  task.signal.throwIfAborted();
  const image = inlineImage(task.image);
  const operation = OperationSchema.parse(
    await responseJson(
      await fetch(new URL(`models/${task.model}:predictLongRunning`, connection.baseUrl), {
        method: "POST",
        headers: headersFor(connection),
        signal: requestSignal(task.signal),
        body: JSON.stringify({
          instances: [{ prompt: task.prompt, image: { inlineData: image } }],
          parameters: {
            aspectRatio: "9:16",
            durationSeconds: "8",
            resolution: task.resolution ?? "720p",
            personGeneration: "allow_adult",
          },
        }),
      }),
    ),
  );
  return { name: operation.name, startedAt: new Date().toISOString() };
}

// 저장된 핸들 폴링(첫 폴링 즉시, 이후 10초 간격) → 다운로드 → 검증. 데드라인은 이 함수 시작 기준.
export async function awaitVideoOperation(
  task: VideoAwaitTask,
  connection: VeoConnection = veoConnection(),
): Promise<ModelResult<Uint8Array>> {
  requireKey(connection);
  task.signal.throwIfAborted();
  const headers = headersFor(connection);
  const deadline = Date.now() + (task.pollDeadlineMs ?? VEO_POLL_DEADLINE_MS);
  const interval = task.pollIntervalMs ?? VEO_POLL_INTERVAL_MS;
  let operation = OperationSchema.parse({ name: task.operationName, done: false });
  for (let attempt = 0; !operation.done; attempt++) {
    if (attempt > 0) await Bun.sleep(interval);
    task.signal.throwIfAborted();
    operation = OperationSchema.parse(
      await responseJson(
        await fetch(new URL(operation.name, connection.baseUrl), {
          headers,
          signal: requestSignal(task.signal),
        }),
      ),
    );
    if (!operation.done && Date.now() >= deadline) break;
  }
  if (!operation.done)
    throw new BlockedError(
      "Veo 영상 생성이 20분 안에 완료되지 않았습니다. 작업 기록을 확인해 주세요.",
    );
  if (operation.error)
    throw new StudioError("veo_failed", `Veo 영상 생성 실패: ${operation.error.message}`);
  const uri = operation.response?.generateVideoResponse.generatedSamples[0]?.video.uri;
  if (!uri) throw new BlockedError("Veo가 영상 다운로드 주소를 반환하지 않았습니다.");
  const downloadUrl = new URL(uri);
  const providerUrl = new URL(connection.baseUrl);
  if (
    downloadUrl.protocol !== providerUrl.protocol ||
    downloadUrl.hostname !== providerUrl.hostname
  )
    throw new StudioError("veo_url", "Veo 다운로드 주소를 확인할 수 없습니다.");
  const downloaded = await fetch(downloadUrl, {
    headers: { "x-goog-api-key": connection.apiKey },
    signal: requestSignal(task.signal),
  });
  const value = await boundedVideo(downloaded);
  await verifyVideo(value);
  return {
    value,
    model: {
      provider: "gemini",
      requestedModel: task.model ?? null,
      effectiveModel: task.model ?? null,
      quality: null,
    },
  };
}

// 예전 호출부 호환 래퍼: 핸들이 없으면 생성 후 폴링, 있으면 폴링만.
export async function generateVideoResult(
  task: VideoTask,
  connection: VeoConnection = veoConnection(),
): Promise<ModelResult<Uint8Array>> {
  let operationName = task.operationName;
  let startedAt = task.startedAt ?? new Date().toISOString();
  if (!operationName) {
    const created = await createVideoOperation(task, connection);
    operationName = created.name;
    startedAt = created.startedAt;
    task.onOperationName?.(operationName);
  }
  return awaitVideoOperation(
    { operationName, startedAt, signal: task.signal, model: task.model },
    connection,
  );
}
