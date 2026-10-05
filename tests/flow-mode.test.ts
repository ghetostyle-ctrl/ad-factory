import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFlowCli } from "../scripts/flow-cli";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { scopeDigest } from "../server/automation-guard";
import { automationServices } from "../server/automation-services";
import { env } from "../server/config";
import { WaitingError } from "../server/errors";
import { FlowImport } from "../server/flow-import";
import { Pipeline } from "../server/pipeline";
import { AutomationPolicySchema } from "../shared/automation";
import {
  buildFlowExport,
  clipModeOf,
  FlowExportSchema,
  flowModelId,
  flowReady,
  pendingFlowClips,
  suggestedFlowModel,
} from "../shared/flow-mode";
import { tinyClip, wideClip } from "./render-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";

// Flow 모드: Veo API 를 부르지 않고 시작 이미지·프롬프트를 내보낸 뒤 waiting 으로 멈추고,
// 업로드(HTTP/CLI)된 클립으로 이어서 완성본을 만든다. 유료 공급자는 전부 스텁, 미디어는 lavfi.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 Flow 모드 테스트를 건너뜁니다.");
const origin = `http://127.0.0.1:${env.PORT}`;
const flowPolicy = {
  mode: "creative",
  imageCount: 1,
  videoCount: 1,
  scriptApproval: "auto",
  clipMode: "flow",
} as const;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
let app: ReturnType<typeof createApp>;
let media: string;
beforeEach(async () => {
  f = await renderRuntimeFixture();
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
  app = createApp(f.store, new Pipeline(f.store), engine);
  media = await mkdtemp(join(tmpdir(), "flow-media-"));
});
afterEach(async () => {
  engine.close();
  await f.close();
  await rm(media, { recursive: true, force: true });
});
const bytesOf = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer());
// 클립 단계에서 Flow 업로드를 기다리는 상태까지 돌린다
async function waitingJob() {
  const job = f.fresh();
  engine.start(job.id, flowPolicy);
  await settle(engine);
  return job.id;
}
function upload(
  id: string,
  clipId: string,
  body: BodyInit,
  options: { number?: number; origin?: string; query?: string; type?: string } = {},
) {
  return app.request(
    new Request(
      `${origin}/api/jobs/${id}/videos/${options.number ?? 1}/clips/${clipId}${options.query ?? ""}`,
      {
        method: "POST",
        headers: {
          Origin: options.origin ?? origin,
          "Content-Type": options.type ?? "video/mp4",
        },
        body,
      },
    ),
  );
}
async function errorOf(response: Response) {
  return (await response.json()) as { error: string; code?: string };
}

test("policy accepts clipMode, defaults to api and is covered by the scope digest", () => {
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", videoCount: 1, clipMode: "flow" }).success,
  ).toBe(true);
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", videoCount: 1, clipMode: "other" })
      .success,
  ).toBe(false);
  const job = f.fresh();
  expect(clipModeOf(job)).toBe("api");
  const api = AutomationPolicySchema.parse({ mode: "creative", videoCount: 1 });
  const flow = AutomationPolicySchema.parse(flowPolicy);
  expect(scopeDigest(job, api)).not.toBe(scopeDigest(job, flow));
  // 예전 정책(clipMode 없음)의 범위 해시는 clipMode: undefined 를 넣어도 같다
  expect(scopeDigest(job, api)).toBe(
    scopeDigest(job, AutomationPolicySchema.parse({ mode: "creative", videoCount: 1 })),
  );
});

test("model labels are normalized into artifact model ids", () => {
  expect(flowModelId("Veo 3.1 - Fast")).toBe("veo-3.1-fast");
  expect(flowModelId("  ")).toBeNull();
  expect(flowModelId(null)).toBeNull();
  expect(suggestedFlowModel("veo-3.1-generate-preview")).toBe("Veo 3.1 - Quality");
  expect(suggestedFlowModel("veo-3.1-fast-generate-preview")).toBe("Veo 3.1 - Fast");
  expect(suggestedFlowModel("veo-3.1-lite-generate-preview")).toBe("Veo 3.1 - Lite");
  expect(flowModelId("Veo 3.1 - Lite")).toBe("veo-3.1-lite");
  expect(suggestedFlowModel(undefined)).toBe("Veo 3.1 - Quality");
});

test.skipIf(!hasFfmpeg)(
  "flow mode exports the bundle and waits without a single Veo call or Gemini key",
  async () => {
    f.control.credentials.gemini = "";
    const id = await waitingJob();
    const job = f.store.get(id);
    expect(f.counts.veoCreate).toBe(0);
    expect(f.counts.veoAwait).toBe(0);
    // 대기는 실패가 아니다: waiting + 예약 없음 + 오류 없음, 메시지는 남은 클립 수
    expect(job.automation?.status).toBe("waiting");
    expect(job.automation?.nextRunAt).toBeNull();
    expect(job.automation?.lastError).toBeNull();
    expect(job.automation?.phase).toBe("clips");
    expect(job.automation?.operation).toBeNull();
    expect(job.status).toBe("review");
    expect(job.result).toBe("클립 4개를 Flow에서 만들어 업로드해 주세요");
    expect(pendingFlowClips(job, 1)).toEqual(["A", "B", "C", "D"]);
    expect(flowReady(job)).toBe(false);
    // 내보내기 산출물: JSON(kind json) + 같은 데이터에서 만든 MD(kind text)
    const json = job.artifacts.find((asset) => asset.name === "flow-export-1.json");
    const md = job.artifacts.find((asset) => asset.name === "flow-export-1.md");
    expect(json?.kind).toBe("json");
    expect(md?.kind).toBe("text");
    const data = FlowExportSchema.parse(
      JSON.parse(await Bun.file(join(f.root, "artifacts", id, "flow-export-1.json")).text()),
    );
    expect(data.number).toBe(1);
    expect(data.jobId).toBe(id);
    expect(data.title).toBe(job.videoScripts[0]?.title ?? "");
    expect(data.checklist.length).toBeGreaterThan(3);
    expect(data.clips.map((clip) => clip.id)).toEqual(["A", "B", "C", "D"]);
    for (const clip of data.clips) {
      const script = job.videoScripts[0]?.veoClips.find((item) => item.id === clip.id);
      expect(clip.startImageArtifact).toBe(`start-1-${clip.id}-1.png`);
      expect(job.artifacts.some((asset) => asset.name === clip.startImageArtifact)).toBe(true);
      // API 모드와 같은 프롬프트: 클립 프롬프트 + 고정 접미
      expect(clip.prompt.startsWith(script?.prompt ?? "?")).toBe(true);
      expect(clip.prompt).toContain("Start exactly from the supplied image");
      expect(clip.aspectRatio).toBe("9:16");
      expect(clip.durationSec).toBe(8);
      expect(clip.suggestedModel).toBe("Veo 3.1 - Quality");
      expect(clip.outputFile).toBe(`flow-1-${clip.id}.mp4`);
      expect(clip.importCommand).toContain(`flow import ${id} 1 ${clip.id}`);
    }
    expect(data).toEqual(buildFlowExport(job, 1));
    const markdown = await Bun.file(join(f.root, "artifacts", id, "flow-export-1.md")).text();
    for (const clip of data.clips) {
      expect(markdown).toContain(`## 클립 ${clip.id}`);
      expect(markdown).toContain(clip.prompt);
      expect(markdown).toContain(clip.startImageFile);
    }
    expect(markdown).toContain("미검증");
    // 대기 중에는 엔진이 다시 돌아도 아무 유료 호출도 하지 않는다
    const before = { ...f.counts };
    await settle(engine);
    expect(f.counts).toEqual(before);
    expect(f.store.get(id).automation?.status).toBe("waiting");
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "a waiting flow job can be re-checked manually without any paid call",
  async () => {
    const id = await waitingJob();
    const before = { ...f.counts };
    engine.resume(id);
    await settle(engine);
    expect(f.store.get(id).automation?.status).toBe("waiting");
    expect(f.store.get(id).result).toBe("클립 4개를 Flow에서 만들어 업로드해 주세요");
    // 점검(preflight, 0원)만 다시 돌고 유료 호출은 늘지 않는다
    expect({ ...f.counts, preflight: 0 }).toEqual({ ...before, preflight: 0 });
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "rejects uploads for a wrong clip id, non-mp4, horizontal, too short and too long clips",
  async () => {
    const id = await waitingJob();
    const good = await bytesOf(tinyClip(join(media, "good.mp4"), 8));
    // 선언되지 않은 클립 ID(대본은 A~D)
    const wrongId = await upload(id, "E", good);
    expect(wrongId.status).toBe(400);
    expect((await errorOf(wrongId)).code).toBe("flow_clip");
    // 클립 ID 형식 자체가 틀림
    expect((await upload(id, "Z", good)).status).toBe(400);
    // 없는 영상 번호
    expect((await errorOf(await upload(id, "A", good, { number: 3 }))).code).toBe("flow_video");
    // mp4 가 아님
    const text = await upload(id, "A", new TextEncoder().encode("not a video at all, just text"));
    expect(text.status).toBe(400);
    expect((await errorOf(text)).code).toBe("flow_format");
    expect((await upload(id, "A", new Uint8Array())).status).toBe(400);
    // 가로 영상
    const wide = await upload(id, "A", await bytesOf(wideClip(join(media, "wide.mp4"), 8)));
    expect(wide.status).toBe(400);
    expect((await errorOf(wide)).code).toBe("flow_orientation");
    // 너무 짧음 / 너무 김
    const short = await upload(id, "A", await bytesOf(tinyClip(join(media, "short.mp4"), 2)));
    expect(short.status).toBe(400);
    expect((await errorOf(short)).code).toBe("flow_duration");
    const long = await upload(id, "A", await bytesOf(tinyClip(join(media, "long.mp4"), 13)));
    expect(long.status).toBe(400);
    expect((await errorOf(long)).code).toBe("flow_duration");
    // 'ftyp' 만 흉내 낸 가짜 파일은 ffprobe 에서 걸린다
    const fake = new Uint8Array(64);
    fake.set(new TextEncoder().encode("ftyp"), 4);
    expect((await errorOf(await upload(id, "A", fake))).code).toBe("flow_invalid");
    // 같은 출처가 아닌 요청은 다른 POST 와 똑같이 거부
    expect((await upload(id, "A", good, { origin: "https://evil.example" })).status).toBe(403);
    // 거부된 요청은 아무것도 기록하지 않는다
    const job = f.store.get(id);
    expect(job.artifacts.some((asset) => /^clip-1-/.test(asset.name))).toBe(false);
    expect(job.renders[0]?.clips.A).toBeUndefined();
    expect(job.automation?.status).toBe("waiting");
  },
  120_000,
);

test("an upload to a job that is not in flow mode is refused", async () => {
  const job = f.fresh();
  const response = await upload(job.id, "A", new Uint8Array([0, 0, 0, 0]));
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("flow_mode");
});

test.skipIf(!hasFfmpeg)(
  "importing every clip resumes the pipeline to a final mp4 with no paid call and no clip review",
  async () => {
    const id = await waitingJob();
    const before = { ...f.counts };
    const clip = await bytesOf(tinyClip(join(media, "clip.mp4"), 8));
    for (const clipId of ["A", "B", "C"]) {
      const response = await upload(id, clipId, clip, { query: "?model=Veo%203.1%20-%20Fast" });
      expect(response.status).toBe(200);
      await settle(engine);
      // 아직 한 개가 남아 있으니 계속 기다린다
      expect(f.store.get(id).automation?.status).toBe("waiting");
    }
    expect(f.store.get(id).result).toBe("클립 4개를 Flow에서 만들어 업로드해 주세요");
    const last = await upload(id, "D", clip);
    expect(last.status).toBe(200);
    await settle(engine);
    const job = f.store.get(id);
    expect(job.automation?.lastError).toBeNull();
    expect(job.automation?.status).toBe("completed");
    expect(job.result).toContain("완성 영상 1개");
    expect(job.result).toContain("Veo 클립 4개");
    const render = job.renders.find((item) => item.number === 1);
    expect(render?.final?.name).toBe("video-final-1.mp4");
    expect(existsSync(join(f.root, "artifacts", id, "video-final-1.mp4"))).toBe(true);
    // API 클립과 같은 기록: 이름·digest·시도 1·핸들 없음
    for (const clipId of ["A", "B", "C", "D"] as const) {
      const state = render?.clips[clipId];
      expect(state?.name).toBe(`clip-1-${clipId}-1.mp4`);
      expect(state?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(state?.attempts).toBe(1);
      expect(state?.operation).toBeNull();
      expect(state?.pendingSince).toBeNull();
      const artifact = job.artifacts.find((asset) => asset.name === `clip-1-${clipId}-1.mp4`);
      expect(artifact?.kind).toBe("video");
      expect(artifact?.model?.provider).toBe("flow");
      expect(artifact?.model?.requestedModel).toBe("veo-3.1-quality");
    }
    expect(job.artifacts.find((asset) => asset.name === "clip-1-A-1.mp4")?.model).toMatchObject({
      effectiveModel: "veo-3.1-fast",
    });
    expect(job.artifacts.find((asset) => asset.name === "clip-1-D-1.mp4")?.model).toMatchObject({
      effectiveModel: null,
    });
    // 이어서 한 일은 로컬 렌더뿐: Veo·내레이션·이미지·검토 호출 증가 없음
    expect(f.counts.veoCreate).toBe(0);
    expect(f.counts.veoAwait).toBe(0);
    expect(f.counts.voice).toBe(before.voice);
    expect(f.counts.image).toBe(before.image);
    expect(f.counts.review).toBe(before.review);
    // 완성본이 생기면 클립을 더 바꿀 수 없다
    const late = await upload(id, "A", clip);
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("flow_final");
    // 업로드된 클립은 Range 로 받을 수 있다
    const ranged = await app.request(
      new Request(`${origin}/api/artifacts/${id}/clip-1-A-1.mp4`, {
        headers: { Range: "bytes=0-99" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "clips imported before the clip stage let the run continue without ever waiting",
  async () => {
    // 엔진을 돌리지 않고 등록만 한 뒤 대본·이미지까지(스텁) 만들고, 클립을 미리 올린다
    const job = new AutomationEnrollment(f.store).start(f.fresh().id, flowPolicy);
    await f.production.run(job.id, new AbortController().signal);
    const clip = await bytesOf(tinyClip(join(media, "early.mp4"), 8));
    for (const clipId of ["A", "B", "C", "D"])
      expect((await upload(job.id, clipId, clip)).status).toBe(200);
    await settle(engine);
    const result = f.store.get(job.id);
    expect(result.automation?.status).toBe("completed");
    expect(result.artifacts.some((asset) => asset.name === "flow-export-1.json")).toBe(false);
    expect(f.counts.veoCreate).toBe(0);
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "re-importing a clip creates the next attempt name and clears that video's render cache",
  async () => {
    const id = await waitingJob();
    const first = await bytesOf(tinyClip(join(media, "first.mp4"), 8, "blue"));
    const second = await bytesOf(tinyClip(join(media, "second.mp4"), 6, "red"));
    expect((await upload(id, "B", first)).status).toBe(200);
    expect(f.store.get(id).renders[0]?.clips.B?.name).toBe("clip-1-B-1.mp4");
    const firstDigest = f.store.get(id).renders[0]?.clips.B?.digest;
    // 영상별 렌더 캐시 폴더를 흉내 낸다
    const scratch = join(f.root, "render", id, "video-1");
    await mkdir(scratch, { recursive: true });
    await Bun.write(join(scratch, "seg-000-deadbeef.mp4"), "stale");
    expect((await upload(id, "B", second)).status).toBe(200);
    const job = f.store.get(id);
    const state = job.renders[0]?.clips.B;
    expect(state?.name).toBe("clip-1-B-2.mp4");
    expect(state?.attempts).toBe(2);
    expect(state?.digest).not.toBe(firstDigest);
    // 이전 시도 파일은 그대로 남고 기록만 새 파일을 가리킨다
    expect(job.artifacts.some((asset) => asset.name === "clip-1-B-1.mp4")).toBe(true);
    expect(job.artifacts.filter((asset) => asset.name === "clip-1-B-2.mp4")).toHaveLength(1);
    expect(existsSync(scratch)).toBe(false);
    expect(job.events.some((event) => event.message.includes("이전 클립을 교체"))).toBe(true);
    expect(pendingFlowClips(job, 1)).toEqual(["A", "C", "D"]);
    // 대기 상태는 그대로(아직 A·C·D 가 없다)
    expect(job.automation?.status).toBe("waiting");
    // 실행 중인 작업은 이미 올린 클립을 교체할 수 없다
    f.store.change(id, (draft) => {
      draft.status = "running";
    });
    const busy = await upload(id, "B", first);
    expect(busy.status).toBe(409);
    expect((await errorOf(busy)).code).toBe("flow_busy");
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "multipart upload works and the model field is recorded",
  async () => {
    const id = await waitingJob();
    const form = new FormData();
    form.set("file", new File([await bytesOf(tinyClip(join(media, "m.mp4"), 8))], "clip.mp4"));
    form.set("model", "Veo 3.1 - Quality");
    const response = await app.request(
      new Request(`${origin}/api/jobs/${id}/videos/1/clips/C`, {
        method: "POST",
        headers: { Origin: origin },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    expect(
      f.store.get(id).artifacts.find((asset) => asset.name === "clip-1-C-1.mp4")?.model,
    ).toMatchObject({ provider: "flow", effectiveModel: "veo-3.1-quality" });
  },
  120_000,
);

test("a waiting error parks the run and an already-ready input requeues it immediately", async () => {
  const base = automationServices(f.store, {
    production: f.production,
    renderPipeline: f.renderPipeline,
  });
  let ready = false;
  const parking = new AutomationEngine(f.store, {
    ...base,
    produce: async () => {
      throw new WaitingError("클립 2개를 Flow에서 만들어 업로드해 주세요", () => ready);
    },
  });
  try {
    const job = f.fresh();
    parking.start(job.id, { mode: "creative", imageCount: 1, videoCount: 0 });
    await settle(parking);
    const waiting = f.store.get(job.id);
    expect(waiting.automation?.status).toBe("waiting");
    expect(waiting.automation?.nextRunAt).toBeNull();
    expect(waiting.status).toBe("review");
    // 대기 중에는 다시 돌지 않는다
    await settle(parking);
    expect(f.store.get(job.id).automation?.status).toBe("waiting");
    // 대기에 들어가는 순간 입력이 이미 도착해 있으면(업로드 경합) 기다리지 않고 다시 큐에 넣는다
    ready = true;
    f.store.change(job.id, (draft) => {
      if (draft.automation) {
        draft.automation.status = "queued";
        draft.automation.nextRunAt = new Date().toISOString();
      }
    });
    await parking.tick();
    await Promise.all([...parking.active.values()].map((task) => task.promise));
    expect(f.store.get(job.id).automation?.status).toBe("queued");
    expect(f.store.get(job.id).automation?.nextRunAt).not.toBeNull();
  } finally {
    parking.close();
  }
});

test.skipIf(!hasFfmpeg)(
  "the CLI exports the bundle layout and imports through the API with a same-origin header",
  async () => {
    const id = await waitingJob();
    const dataDir = join(media, "data");
    const lines: string[] = [];
    const errors: string[] = [];
    const seen: { url: string; origin: string | null; method: string }[] = [];
    const context = {
      baseUrl: origin,
      dataDir,
      out: (line: string) => lines.push(line),
      err: (line: string) => errors.push(line),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push({
          url: request.url,
          origin: request.headers.get("Origin"),
          method: request.method,
        });
        return app.request(request);
      }) as typeof fetch,
    };
    const code = await runFlowCli(["export", id, "1"], context);
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const bundle = join(dataDir, "flow", id, "video-1");
    expect(existsSync(join(bundle, "prompts.md"))).toBe(true);
    expect(existsSync(join(bundle, "flow-export.json"))).toBe(true);
    const data = FlowExportSchema.parse(
      JSON.parse(await Bun.file(join(bundle, "flow-export.json")).text()),
    );
    for (const clip of data.clips) {
      const copied = await bytesOf(join(bundle, clip.startImageFile));
      const original = await bytesOf(join(f.root, "artifacts", id, clip.startImageArtifact));
      expect(copied).toEqual(original);
    }
    const prompts = await Bun.file(join(bundle, "prompts.md")).text();
    expect(prompts).toContain("## 클립 A");
    expect(prompts).toContain(data.clips[0]?.prompt ?? "?");
    expect(lines.join("\n")).toContain(bundle);
    // 키·토큰류는 출력에 없다
    expect(lines.join("\n")).not.toMatch(/api[_-]?key|sk-[A-Za-z0-9]/i);
    // import: 로컬 API 를 부르고 같은 출처의 Origin 헤더를 붙인다
    const file = tinyClip(join(media, "cli.mp4"), 8);
    lines.length = 0;
    expect(
      await runFlowCli(["import", id, "1", "A", file, "--model", "Veo 3.1 - Fast"], context),
    ).toBe(0);
    const post = seen.find((item) => item.method === "POST");
    expect(post?.origin).toBe(origin);
    expect(post?.url).toContain(`/api/jobs/${id}/videos/1/clips/A`);
    expect(lines.join("\n")).toContain("clip-1-A-1.mp4");
    expect(lines.join("\n")).toContain("아직 올리지 않은 클립: B, C, D");
    expect(f.store.get(id).renders[0]?.clips.A?.name).toBe("clip-1-A-1.mp4");
    // 서버 검증 실패는 사유를 그대로 보여 주고 종료 코드 1
    errors.length = 0;
    const horizontal = wideClip(join(media, "wide-cli.mp4"), 8);
    expect(await runFlowCli(["import", id, "1", "B", horizontal], context)).toBe(1);
    expect(errors.join("\n")).toContain("세로 영상");
    expect(await runFlowCli(["import", id, "1", "B", join(media, "missing.mp4")], context)).toBe(1);
    expect(await runFlowCli(["frobnicate", id, "1"], context)).toBe(2);
    expect(await runFlowCli(["export", id, "2"], context)).toBe(1);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "refuses a clip shorter than the span its cuts read instead of silently truncating the video",
  async () => {
    const id = await waitingJob();
    // 대본: 클립 A 는 컷 0~3초 구간과 27~29초 컷이 이어 읽어 5초 지점까지, B 는 4초 지점까지 읽는다.
    const four = await bytesOf(tinyClip(join(media, "four.mp4"), 4));
    const short = await upload(id, "A", four);
    expect(short.status).toBe(400);
    const error = await errorOf(short);
    expect(error.code).toBe("flow_short");
    expect(error.error).toContain("5.0초");
    expect(error.error).toContain("4.0초");
    // 거부된 업로드는 아무것도 기록하지 않는다
    expect(f.store.get(id).renders[0]?.clips.A).toBeUndefined();
    expect(f.store.get(id).artifacts.some((asset) => asset.name === "clip-1-A-1.mp4")).toBe(false);
    // 오차 허용(0.2초) 안쪽은 받고, 그보다 짧으면 거부
    expect(
      (await upload(id, "A", await bytesOf(tinyClip(join(media, "a48.mp4"), 4.7)))).status,
    ).toBe(400);
    expect(
      (await upload(id, "A", await bytesOf(tinyClip(join(media, "a49.mp4"), 4.9)))).status,
    ).toBe(200);
    // B 는 4초 지점까지만 읽으므로 4초 클립으로 충분하다
    expect((await upload(id, "B", four)).status).toBe(200);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "refuses a short clip uploaded before the narration timeline exists, from the script alone",
  async () => {
    const job = new AutomationEnrollment(f.store).start(f.fresh().id, flowPolicy);
    await f.production.run(job.id, new AbortController().signal);
    // 대본 단계가 renders[n](검토 기록)을 먼저 만들지만 내레이션은 아직 없다
    expect(f.store.get(job.id).renders[0]?.voice ?? null).toBeNull();
    const four = await bytesOf(tinyClip(join(media, "early-four.mp4"), 4));
    expect((await errorOf(await upload(job.id, "A", four))).code).toBe("flow_short");
    expect((await upload(job.id, "D", four)).status).toBe(200);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "assembly stops with attention when a stored Flow clip is shorter than the confirmed timeline reads",
  async () => {
    const id = await waitingJob();
    // 업로드 검증을 건너뛴 경로(예전에 저장된 클립)를 흉내 낸다: 길이를 8초로 속이는 측정기
    const lenient = new FlowImport(f.store, async () => ({ width: 108, height: 192, sec: 8 }));
    const four = await bytesOf(tinyClip(join(media, "lenient-four.mp4"), 4));
    for (const clipId of ["A", "B", "C", "D"] as const)
      await lenient.import({ jobId: id, number: 1, clipId, bytes: four });
    expect(engine.wakeFlow(id)).toBe(true);
    await settle(engine);
    const job = f.store.get(id);
    expect(job.automation?.status).toBe("attention");
    expect(job.automation?.lastError).toContain("말없이 잘리므로 조립하지 않습니다");
    expect(job.artifacts.some((asset) => asset.name === "video-final-1.mp4")).toBe(false);
  },
  300_000,
);
