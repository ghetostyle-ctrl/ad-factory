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
export type VideoTask = {
  readonly image: Uint8Array;
  readonly prompt: string;
  readonly model:
    | "veo-3.1-lite-generate-preview"
    | "veo-3.1-fast-generate-preview"
    | "veo-3.1-generate-preview";
  readonly signal: AbortSignal;
  readonly operationName?: string;
  readonly startedAt?: string;
  readonly onOperationName?: (name: string) => void;
};

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

export async function generateVideoResult(
  task: VideoTask,
  connection: { readonly apiKey: string; readonly baseUrl: string } = {
    apiKey: credentials.gemini,
    baseUrl,
  },
): Promise<ModelResult<Uint8Array>> {
  if (!connection.apiKey)
    throw new MissingConnectionError(
      "Veo 영상 제작에는 Gemini API 키가 필요합니다. 연결 설정에서 입력해 주세요.",
    );
  task.signal.throwIfAborted();
  const headers = { "x-goog-api-key": connection.apiKey, "Content-Type": "application/json" };
  const requestSignal = () => AbortSignal.any([task.signal, AbortSignal.timeout(60000)]);
  const deadline = Date.parse(task.startedAt ?? new Date().toISOString()) + 20 * 60000;
  let operation = task.operationName
    ? OperationSchema.parse({ name: task.operationName, done: false })
    : OperationSchema.parse(
        await responseJson(
          await fetch(
            new URL(
              `models/${task.model}:predictLongRunning`,
              connection.baseUrl,
            ),
            {
              method: "POST",
              headers,
              signal: requestSignal(),
              body: JSON.stringify({
                instances: [{ prompt: task.prompt }],
                parameters: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" },
              }),
            },
          ),
        ),
      );
  if (!task.operationName) task.onOperationName?.(operation.name);
  for (let attempt = 0; attempt < 120 && !operation.done; attempt++) {
    if (!task.operationName || attempt > 0) await Bun.sleep(10000);
    task.signal.throwIfAborted();
    operation = OperationSchema.parse(
      await responseJson(
        await fetch(new URL(operation.name, connection.baseUrl), {
          headers,
          signal: requestSignal(),
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
    signal: requestSignal(),
  });
  const value = await boundedVideo(downloaded);
  await verifyVideo(value);
  return {
    value,
    model: {
      provider: "gemini",
      requestedModel: task.model,
      effectiveModel: task.model,
      quality: null,
    },
  };
}
