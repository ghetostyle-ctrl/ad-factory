import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { StudioError } from "../server/errors";
import { MusicLibrary } from "../server/music-library";
import { type PreflightDeps, REQUIRED_FILTERS, renderPreflight } from "../server/render/preflight";
import { RenderPipeline, TEST_PROVIDER_BLOCKED } from "../server/render-pipeline";
import { RenderProduction } from "../server/render-production";
import { renderStateOf } from "../server/render-state-helpers";
import { VoiceProduction } from "../server/voice-production";
import { sha256Hex } from "../shared/sha256";
import { videoTargetSeconds } from "../shared/video-script";
import { renderProfile, renderScript } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

// 재개 안전성: preflight 크레딧 조건, 중지 후 불확실 클립 재개, 완성본 기록 복원, 조립 전 digest 재대조,
// 테스트 환경에서 실제 유료 공급자 차단. 공급자는 전부 스텁이고 ffmpeg 렌더 호출은 없다.
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
});
afterEach(async () => {
  await f.close();
});
async function enroll() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  return job.id;
}
// 내레이션·시작 이미지·클립까지 스텁으로 끝낸 상태(조립만 남음)
async function readyToAssemble() {
  const id = await enroll();
  await f.renderPipeline.run(id, signal());
  return id;
}
function preflightDeps(overrides: Partial<PreflightDeps> = {}): {
  deps: PreflightDeps;
  subscriptions: () => number;
} {
  let subscriptions = 0;
  const deps: PreflightDeps = {
    capabilities: async () => ({
      version: "8.1",
      filters: new Set<string>(REQUIRED_FILTERS),
      encoders: new Set(["libx264", "aac"]),
    }),
    resolveFont: () => ({ dir: f.root, family: "Pretendard", bold: "b.ttf", medium: "m.ttf" }),
    music: new MusicLibrary(join(f.root, "no-bgm")),
    subscription: async () => {
      subscriptions++;
      return { plan: "lite", planCredits: 1_000_000, usedCredits: 0, concurrencyLimit: 3 };
    },
    credentials: () => ({ openai: "k", gemini: "k", typecast: "k" }),
    encoder: "libx264",
    ...overrides,
  };
  return { deps, subscriptions: () => subscriptions };
}

test("preflight asks nothing of Typecast once the narration of that video is synthesized", async () => {
  const id = await enroll();
  const noKey = preflightDeps({
    credentials: () => ({ openai: "k", gemini: "k", typecast: "" }),
    subscription: async () => {
      throw new Error("Typecast must not be queried");
    },
  });
  // 합성 전에는 키가 필요하다
  await expect(renderPreflight(f.store.get(id), 1, noKey.deps)).rejects.toMatchObject({
    name: "MissingConnectionError",
  });
  await f.renderPipeline.run(id, signal());
  expect(f.store.get(id).renders[0]?.voice).not.toBeNull();
  // 합성 뒤에는 키·크레딧 조회가 모두 생략된다(남은 단계는 Typecast 를 부르지 않는다)
  const result = await renderPreflight(f.store.get(id), 1, noKey.deps);
  expect(result.warnings.filter((warning) => warning.includes("Typecast"))).toEqual([]);
  const lowCredit = preflightDeps({
    subscription: async () => ({
      plan: "lite",
      planCredits: 10,
      usedCredits: 9,
      concurrencyLimit: 3,
    }),
  });
  await renderPreflight(f.store.get(id), 1, lowCredit.deps);
  expect(lowCredit.subscriptions()).toBe(0);
});

test("preflight only demands credits for sentences that still have to be synthesized", async () => {
  const id = await enroll();
  const real = f.providers.voice;
  if (!real) throw new Error("fixture voice provider missing");
  let calls = 0;
  await expect(
    new VoiceProduction(f.store, async (task) => {
      if (++calls > 6) throw new StudioError("typecast_credit", "크레딧 부족(스텁)", 409);
      return real(task);
    }).run(id, 1, signal(), { concurrencyLimit: 1 }),
  ).rejects.toMatchObject({ code: "typecast_credit" });
  const job = f.store.get(id);
  const script = job.videoScripts[0];
  if (!script) throw new Error("script missing");
  const total = script.voiceover.reduce((sum, line) => sum + [...line.text].length, 0);
  const done = (job.renders[0]?.voiceLines ?? []).reduce(
    (sum, line) => sum + [...line.text].length,
    0,
  );
  expect(done).toBeGreaterThan(0);
  const remaining = total - done;
  const enough = preflightDeps({
    subscription: async () => ({
      plan: "lite",
      planCredits: Math.ceil(remaining * 1.5),
      usedCredits: 0,
      concurrencyLimit: 3,
    }),
  });
  // 남은 문장 몫만 있으면 시작할 수 있고, 전체 몫(재합성 여유 포함)에는 모자라다
  await renderPreflight(job, 1, enough.deps);
  expect(Math.ceil(total * 1.5)).toBeGreaterThan(Math.ceil(remaining * 1.5));
  const short = preflightDeps({
    subscription: async () => ({
      plan: "lite",
      planCredits: Math.ceil(remaining * 1.5) - 1,
      usedCredits: 0,
      concurrencyLimit: 3,
    }),
  });
  await expect(renderPreflight(job, 1, short.deps)).rejects.toMatchObject({
    code: "typecast_credit",
  });
});

test("resume after a stop with an uncertain Veo request shows the warning first and recreates only after a second resume", async () => {
  const id = await enroll();
  f.store.change(id, (draft) => {
    const target = renderStateOf(draft, 1);
    target.clips.B = {
      name: null,
      digest: null,
      attempts: 0,
      pendingSince: new Date().toISOString(),
      operation: null,
    };
    if (draft.automation) {
      draft.automation.status = "stopped";
      draft.automation.operation = "clips";
    }
  });
  const enrollment = new AutomationEnrollment(f.store);
  const first = enrollment.resume(id);
  // 첫 재개: 경고가 보이는 attention 으로 바뀔 뿐 재생성 표시는 지우지 않는다
  expect(first.automation?.status).toBe("attention");
  expect(first.automation?.lastError).toContain("중복 과금 가능성");
  expect(first.renders[0]?.clips.B?.pendingSince).not.toBeNull();
  const second = enrollment.resume(id);
  expect(second.automation?.status).toBe("queued");
  expect(second.renders[0]?.clips.B?.pendingSince).toBeNull();
});

test("a stopped job without uncertain clips resumes in one step", async () => {
  const id = await enroll();
  f.store.change(id, (draft) => {
    if (draft.automation) draft.automation.status = "stopped";
  });
  expect(new AutomationEnrollment(f.store).resume(id).automation?.status).toBe("queued");
});

test("the pipeline restores a missing final record instead of skipping the video as if it were done", async () => {
  const id = await readyToAssemble();
  await f.production.assets.save(id, {
    name: "video-final-1.mp4",
    kind: "video",
    agentId: "production",
    content: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  });
  let renders = 0;
  const pipeline = new RenderPipeline(f.store, {
    ...f.deps,
    render: {
      run: async () => {
        renders++;
      },
    },
  });
  const before = { ...f.counts };
  await pipeline.run(id, signal());
  // renders[1].final 이 비어 있으니 조립 단계(복원)를 한 번 부르고 유료 단계는 다시 돌지 않는다
  expect(renders).toBe(1);
  expect(f.counts).toEqual(before);
  f.store.change(id, (draft) => {
    const render = draft.renders[0];
    if (render)
      render.final = { name: "video-final-1.mp4", digest: "d", durationMs: 1, bgmTrackId: null };
  });
  await pipeline.run(id, signal());
  expect(renders).toBe(1);
});

test("assembly reconciles a saved final video from its report and restores the captions", async () => {
  const id = await readyToAssemble();
  const finalBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);
  await f.production.assets.save(id, {
    name: "video-final-1.mp4",
    kind: "video",
    agentId: "production",
    content: finalBytes,
  });
  await f.production.assets.save(id, {
    name: "render-report-1.json",
    kind: "json",
    agentId: "production",
    content: JSON.stringify({ measuredDurationMs: 41234, bgm: { id: "calm-01" } }),
  });
  const ffmpegCalls: string[][] = [];
  const production = new RenderProduction(
    f.store,
    f.library,
    f.root,
    new MusicLibrary(join(f.root, "no-bgm")),
    renderProfile,
    async (args) => {
      ffmpegCalls.push([...args]);
      return { stderrTail: "" };
    },
  );
  await production.run(id, 1, signal());
  const job = f.store.get(id);
  expect(job.renders[0]?.final).toEqual({
    name: "video-final-1.mp4",
    digest: sha256Hex(finalBytes),
    durationMs: 41234,
    bgmTrackId: "calm-01",
  });
  expect(job.artifacts.filter((asset) => asset.name === "captions-1.ass")).toHaveLength(1);
  expect(job.artifacts.filter((asset) => asset.name === "video-final-1.mp4")).toHaveLength(1);
  expect(ffmpegCalls).toEqual([]);
});

test("assembly refuses a replaced narration wav or approved image", async () => {
  const id = await readyToAssemble();
  const ffmpegCalls: string[][] = [];
  const production = new RenderProduction(
    f.store,
    f.library,
    f.root,
    new MusicLibrary(join(f.root, "no-bgm")),
    renderProfile,
    async (args) => {
      ffmpegCalls.push([...args]);
      return { stderrTail: "" };
    },
  );
  const image = f.store.get(id).artifacts.find((asset) => asset.kind === "image");
  if (!image) throw new Error("approved image missing");
  const imagePath = f.production.assets.path(id, image.name);
  const original = new Uint8Array(await Bun.file(imagePath).arrayBuffer());
  await Bun.write(imagePath, "replaced image");
  await expect(production.run(id, 1, signal())).rejects.toThrow("대표 이미지");
  await Bun.write(imagePath, original);
  await Bun.write(f.production.assets.path(id, "voice-1-02-1.wav"), "replaced voice");
  await expect(production.run(id, 1, signal())).rejects.toThrow("내레이션");
  expect(ffmpegCalls).toEqual([]);
});

test("the default render pipeline refuses real paid providers under bun test unless they are injected", async () => {
  expect(process.env.NODE_ENV).toBe("test");
  const id = await enroll();
  const job = f.store.get(id);
  const pipeline = new RenderPipeline(f.store, {});
  for (const stage of [pipeline.voice, pipeline.stills, pipeline.startImages, pipeline.clips])
    await expect(stage.run(id, 1, signal())).rejects.toMatchObject({
      code: TEST_PROVIDER_BLOCKED,
    });
  await expect(pipeline.preflight(job, 1, signal())).rejects.toMatchObject({
    code: TEST_PROVIDER_BLOCKED,
  });
  // 주입한 단계는 막지 않는다
  const injected = new RenderPipeline(f.store, f.deps);
  await injected.run(id, signal());
  expect(f.store.get(id).renders[0]?.clips.A?.name).toBe("clip-1-A-1.mp4");
  // 운영(NODE_ENV 가 test 가 아님)에서는 기본 공급자를 그대로 쓴다
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const production = new RenderPipeline(f.store, {});
    expect(production.voice).toBeInstanceOf(VoiceProduction);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("assembly refuses a replaced still image or a still without a recorded digest", async () => {
  const id = await readyToAssemble();
  const state = f.store.get(id).renders[0]?.stills["S1"];
  if (!state) throw new Error("still S1 missing");
  const ffmpegCalls: string[][] = [];
  const production = new RenderProduction(
    f.store,
    f.library,
    f.root,
    new MusicLibrary(join(f.root, "no-bgm")),
    renderProfile,
    async (args) => {
      ffmpegCalls.push([...args]);
      return { stderrTail: "" };
    },
  );
  const path = f.production.assets.path(id, state.name);
  const original = new Uint8Array(await Bun.file(path).arrayBuffer());
  await Bun.write(path, "replaced still");
  await expect(production.run(id, 1, signal())).rejects.toThrow("정지 이미지 S1");
  expect(ffmpegCalls).toEqual([]);
  await Bun.write(path, original);
  // 기록의 digest 가 비어 있어도(파일은 있어도) 검증할 수 없으므로 조립하지 않는다
  f.store.change(id, (draft) => {
    const record = draft.renders[0]?.stills["S1"];
    if (record) record.digest = "";
  });
  await expect(production.run(id, 1, signal())).rejects.toThrow("정지 이미지 S1");
  expect(ffmpegCalls).toEqual([]);
});

test("a script without declared stills never runs the stills stage", async () => {
  const g = await renderRuntimeFixture({
    stubRender: true,
    clipReview: false,
    script: (job, hypothesisId, number) => {
      const base = renderScript(number, hypothesisId, videoTargetSeconds(job.id, number));
      return {
        ...base,
        stills: [],
        cuts: base.cuts.map((cut) =>
          cut.source === "still_image"
            ? { ...cut, source: "approved_image" as const, stillId: "" as const }
            : cut,
        ),
      };
    },
  });
  try {
    const job = new AutomationEnrollment(g.store).start(g.fresh().id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await g.production.run(job.id, signal());
    const pipeline = new RenderPipeline(g.store, {
      ...g.deps,
      stills: {
        run: async () => {
          throw new Error("stills stage must be skipped");
        },
      },
    });
    await pipeline.run(job.id, signal());
    expect(g.counts.still).toBe(0);
    expect(g.store.get(job.id).renders[0]?.stills).toEqual({});
    expect(g.store.get(job.id).renders[0]?.clips.A?.name).toBe("clip-1-A-1.mp4");
  } finally {
    await g.close();
  }
});

test("preflight needs the OpenAI key for stills even without any Veo clip", async () => {
  const id = await enroll();
  const job = f.store.get(id);
  const script = job.videoScripts[0];
  if (!script) throw new Error("script missing");
  const stillOnly = {
    ...job,
    videoScripts: [{ ...script, veoClips: [] }],
  };
  const noOpenai = preflightDeps({
    credentials: () => ({ openai: "", gemini: "", typecast: "k" }),
  });
  await expect(renderPreflight(stillOnly, 1, noOpenai.deps)).rejects.toThrow("정지 이미지");
  await expect(renderPreflight(stillOnly, 1, noOpenai.deps)).rejects.toMatchObject({
    name: "MissingConnectionError",
  });
  // 정지 이미지만 쓰는 영상은 Gemini(Veo) 키를 요구하지 않는다
  const openaiOnly = preflightDeps({
    credentials: () => ({ openai: "k", gemini: "", typecast: "k" }),
  });
  await renderPreflight(stillOnly, 1, openaiOnly.deps);
  // 이미지가 전혀 필요 없는 대본은 OpenAI 키도 요구하지 않는다
  const noImages = {
    ...job,
    videoScripts: [{ ...script, veoClips: [], stills: [] }],
  };
  await renderPreflight(noImages, 1, noOpenai.deps);
});
