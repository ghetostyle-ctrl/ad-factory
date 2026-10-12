import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifacts } from "./artifacts";
import { StudioError } from "./errors";
import { type FfmpegRunner, runFfmpeg } from "./render/ffmpeg";
import type { JobStore } from "./store";

// 완성 영상의 포스터(JPG) 한 장. 개요 탭 영상 보드가 <video> 대신 이 이미지를 쓴다.
// 파일은 data/render/<jobId>/poster-<n>-<digest8>.jpg (final.digest 앞 8자) — 완성본이 바뀌면 이름이 달라진다.
// 작업 삭제·자동 운영 초기화가 data/render/<jobId> 를 통째로 지우므로 별도 정리는 없다.
const POSTER_WIDTH = 360;
const POSTER_SEEK_SEC = 0.5;
const POSTER_TIMEOUT_MS = 30_000;
const POSTER_HEADERS = {
  "Content-Type": "image/jpeg",
  "Cache-Control": "private, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
} as const;

function digestPart(digest: string): string {
  return digest.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "0";
}
export function posterPath(root: string, jobId: string, n: number, digest: string): string {
  return join(root, "render", jobId, `poster-${n}-${digestPart(digest)}.jpg`);
}
// 영상 번호는 1~10 정수만 받는다("01"·"1.5"·"abc" 거부).
export function parsePosterNumber(value: string): number {
  if (!/^(?:[1-9]|10)$/.test(value))
    throw new StudioError("poster_number", "영상 번호는 1~10 이어야 합니다.", 400);
  return Number(value);
}

export type EnsurePosterInput = {
  readonly root: string;
  readonly finalPath: string;
  readonly jobId: string;
  readonly n: number;
  readonly digest: string;
  readonly runner?: FfmpegRunner;
};
const inflight = new Map<string, Promise<string>>();

async function present(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
}
const posterUnavailable = () =>
  new StudioError(
    "render_unavailable",
    "포스터를 만들 수 없습니다. ffmpeg 설치와 완성 영상 파일을 확인하세요.",
    503,
  );

// 포스터가 있으면 그 경로를, 없으면 ffmpeg 로 한 장 추출해 저장하고 경로를 돌려준다.
// 같은 (작업, 번호, 완성본) 의 동시 요청은 추출을 한 번만 한다. ffmpeg 가 없거나 실패하면 503 render_unavailable.
export async function ensurePoster(input: EnsurePosterInput): Promise<string> {
  const out = posterPath(input.root, input.jobId, input.n, input.digest);
  if (await present(out)) return out;
  const running = inflight.get(out);
  if (running) return running;
  const job = extract(input, out);
  inflight.set(out, job);
  try {
    return await job;
  } finally {
    if (inflight.get(out) === job) inflight.delete(out);
  }
}
async function extract(input: EnsurePosterInput, out: string): Promise<string> {
  const run = input.runner ?? runFfmpeg;
  await mkdir(join(input.root, "render", input.jobId), { recursive: true });
  // 임시 이름(.part.jpg)으로 만든 뒤 옮겨 반쯤 쓴 파일이 서빙되지 않게 한다.
  const part = out.replace(
    /\.jpg$/,
    `.${process.pid}.${Math.random().toString(36).slice(2)}.part.jpg`,
  );
  const attempt = async (seek: number): Promise<boolean> => {
    await run(
      [
        "-ss",
        String(seek),
        "-i",
        input.finalPath,
        "-frames:v",
        "1",
        "-vf",
        `scale=${POSTER_WIDTH}:-2`,
        "-q:v",
        "3",
        part,
      ],
      { signal: new AbortController().signal, timeoutMs: POSTER_TIMEOUT_MS },
    );
    return present(part);
  };
  try {
    // 영상이 0.5초보다 짧으면 ffmpeg 는 오류 없이 프레임 0장을 내므로 첫 프레임으로 다시 시도한다.
    if (!(await attempt(POSTER_SEEK_SEC)) && !(await attempt(0))) throw posterUnavailable();
    await rename(part, out);
  } catch (error) {
    await rm(part, { force: true });
    if (error instanceof StudioError && error.code === "render_unavailable") throw error;
    throw posterUnavailable();
  }
  await removeStalePosters(input, out);
  return out;
}
// 완성본이 다시 만들어져 digest 가 바뀐 뒤 남은 같은 번호의 옛 포스터를 지운다(실패해도 무시).
async function removeStalePosters(input: EnsurePosterInput, keep: string): Promise<void> {
  const dir = join(input.root, "render", input.jobId);
  const pattern = new RegExp(`^poster-${input.n}-[A-Za-z0-9]+\\.jpg$`);
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (pattern.test(name) && path !== keep) await rm(path, { force: true });
    }
  } catch {
    // 정리는 보조 동작이다.
  }
}

const missing = () => Response.json({ error: "poster_missing" }, { status: 404 });
// GET /api/jobs/:id/videos/:n/poster.jpg 본문. 작업·완성본·파일이 없으면 404 poster_missing.
export async function servePoster(input: {
  readonly store: JobStore;
  readonly assets: Artifacts;
  readonly jobId: string;
  readonly n: string;
  readonly runner?: FfmpegRunner;
}): Promise<Response> {
  const n = parsePosterNumber(input.n);
  let job: ReturnType<JobStore["get"]>;
  try {
    job = input.store.get(input.jobId);
  } catch (error) {
    if (error instanceof StudioError && error.status === 404) return missing();
    throw error;
  }
  const final = job.renders.find((item) => item.number === n)?.final;
  if (!final) return missing();
  const finalPath = input.assets.path(job.id, final.name);
  if (!(await present(finalPath))) return missing();
  const path = await ensurePoster({
    root: input.store.root,
    finalPath,
    jobId: job.id,
    n,
    digest: final.digest,
    ...(input.runner ? { runner: input.runner } : {}),
  });
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return new Response(bytes, {
    headers: { ...POSTER_HEADERS, "Content-Length": String(bytes.byteLength) },
  });
}
