import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { posterPath } from "../server/poster";
import { type FfmpegRunner, runFfmpeg } from "../server/render/ffmpeg";
import { JobStore } from "../server/store";
import { emptyRenderState } from "../shared/render-state";
import { CreateJobSchema } from "../shared/schema";
import { tinyClip } from "./render-fixture";

// 완성 영상 포스터 라우트(GET /api/jobs/:id/videos/:n/poster.jpg). 유료 호출 0, lavfi 로 만든 108x192 1초 mp4.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 포스터 추출 테스트를 건너뜁니다.");

const origin = `http://127.0.0.1:${env.PORT}`;
const brief = CreateJobSchema.parse({
  name: "Poster target",
  productUrl: "https://example.com/product",
  productDescription: "스테인리스 재질의 500ml 보온 텀블러, 12시간 보온",
  audience: "출퇴근하는 직장인",
});
const DIGEST = "0123456789abcdef0123456789abcdef";
const OTHER_DIGEST = "fedcba9876543210fedcba9876543210";

let root = "";
let store: JobStore;
let jobId = "";
let calls = 0;
let failing = false;
let app: ReturnType<typeof createApp>;
const counting: FfmpegRunner = (args, options) => {
  calls += 1;
  if (failing) throw new Error("ffmpeg unavailable");
  return runFfmpeg(args, options);
};
const get = (id: string, n: string) =>
  app.request(new Request(`${origin}/api/jobs/${id}/videos/${n}/poster.jpg`));
const renderDir = () => join(root, "render", jobId);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-poster-"));
  store = new JobStore(root);
  const job = store.create(brief);
  jobId = job.id;
  const folder = join(root, "artifacts", jobId);
  await mkdir(folder, { recursive: true });
  const finals: [number, string][] = [
    [1, "video-final-1.mp4"],
    [5, "video-final-5.mp4"],
  ];
  if (hasFfmpeg) for (const [, name] of finals) tinyClip(join(folder, name), 1);
  await writeFile(join(folder, "video-final-6.mp4"), "not a real mp4");
  store.change(jobId, (draft) => {
    for (const [number, name] of [...finals, [6, "video-final-6.mp4"] as [number, string]]) {
      draft.renders.push({
        ...emptyRenderState(number),
        final: { name, digest: DIGEST, durationMs: 1000, bgmTrackId: null },
      });
      draft.artifacts.push({
        id: crypto.randomUUID(),
        name,
        kind: "video",
        agentId: "production",
        url: `/api/artifacts/${jobId}/${name}`,
        model: null,
      });
    }
    draft.renders.push(emptyRenderState(3)); // 완성본 없음
    draft.renders.push({
      ...emptyRenderState(4),
      final: { name: "video-final-4.mp4", digest: DIGEST, durationMs: 1000, bgmTrackId: null },
    }); // 기록만 있고 파일 없음
  });
  app = createApp(store, undefined, undefined, { poster: { runner: counting } });
});
afterAll(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("존재하지 않는 작업은 404 poster_missing", async () => {
  const response = await get(crypto.randomUUID(), "1");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "poster_missing" });
});

test("완성본이 없는 영상(번호 없음·final null·파일 없음)은 404 poster_missing", async () => {
  const before = calls;
  for (const n of ["2", "3", "4"]) {
    const response = await get(jobId, n);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "poster_missing" });
  }
  expect(calls).toBe(before);
});

test.skipIf(!hasFfmpeg)(
  "완성본이 있으면 200 JPEG 와 불변 캐시 헤더, 파일이 render 폴더에 생긴다",
  async () => {
    const response = await get(jobId, "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(Number(response.headers.get("Content-Length"))).toBe(bytes.byteLength);
    const file = join(renderDir(), "poster-1-01234567.jpg");
    expect(file).toBe(posterPath(root, jobId, 1, DIGEST));
    expect(existsSync(file)).toBe(true);
    expect((await Bun.file(file).arrayBuffer()).byteLength).toBe(bytes.byteLength);
  },
);

test.skipIf(!hasFfmpeg)(
  "동시 요청도 추출은 한 번, 두 번째 이후 요청은 ffmpeg 를 다시 부르지 않는다",
  async () => {
    const before = calls;
    const [first, second] = await Promise.all([get(jobId, "5"), get(jobId, "5")]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls - before).toBe(1);
    const third = await get(jobId, "5");
    expect(third.status).toBe(200);
    expect(third.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(calls - before).toBe(1);
  },
);

test.skipIf(!hasFfmpeg)(
  "완성본 digest 가 바뀌면 새 포스터를 만들고 같은 번호의 옛 포스터를 지운다",
  async () => {
    const oldFile = posterPath(root, jobId, 5, DIGEST);
    expect(existsSync(oldFile)).toBe(true);
    store.change(jobId, (draft) => {
      const render = draft.renders.find((item) => item.number === 5);
      if (render?.final) render.final.digest = OTHER_DIGEST;
    });
    const response = await get(jobId, "5");
    expect(response.status).toBe(200);
    expect(existsSync(posterPath(root, jobId, 5, OTHER_DIGEST))).toBe(true);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(posterPath(root, jobId, 1, DIGEST))).toBe(true);
  },
);

test("ffmpeg 를 실행할 수 없으면 503 render_unavailable 이고 부분 파일을 남기지 않는다", async () => {
  failing = true;
  try {
    const response = await get(jobId, "6");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("render_unavailable");
    expect(existsSync(posterPath(root, jobId, 6, DIGEST))).toBe(false);
  } finally {
    failing = false;
  }
});

test("영상 번호가 1~10 정수가 아니면 400", async () => {
  const before = calls;
  for (const n of ["0", "11", "abc", "1.5", "01"]) {
    const response = await get(jobId, n);
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(before);
});
