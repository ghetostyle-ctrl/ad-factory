import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { automationServices } from "../server/automation-services";
import { BlockedError } from "../server/errors";
import { RenderTimelineSchema } from "../shared/render-timeline";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";

// 엔진 E2E: 기획·대본·이미지(AutomaticProduction) → preflight → voice → stills → startImages → clips → graphics → assemble.
// 유료 공급자는 전부 스텁(호출 수 기록), 미디어는 lavfi, 108x192/10fps 로 실제 ffmpeg 조립까지 돈다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 렌더 E2E 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
beforeEach(async () => {
  f = await renderRuntimeFixture();
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
});
afterEach(async () => {
  engine.close();
  await f.close();
});
const phasesSeen = (id: string) => {
  const seen: string[] = [];
  f.store.listeners.add(() => {
    const phase = f.store.get(id).automation?.phase;
    if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
  });
  return seen;
};
const snapshot = () => ({ ...f.counts });

test.skipIf(!hasFfmpeg)(
  "renders two finished videos in stage order with the expected artifact set and an empty-BGM warning",
  async () => {
    const job = f.fresh();
    const phases = phasesSeen(job.id);
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 2,
      scriptApproval: "auto",
    });
    await settle(engine);
    const result = f.store.get(job.id);
    expect(result.automation?.lastError).toBeNull();
    expect(result.automation?.status).toBe("completed");
    expect(result.result).toContain("완성 영상 2개");
    expect(result.result).toContain("Veo 클립 8개");
    expect(result.result).toContain("BGM 없음");
    // 단계 순서(영상 1): preflight → voice → still → startImage → veo create → veo await → ffmpeg
    const order = [
      "preflight",
      "voice",
      "still",
      "startImage",
      "veo.create",
      "veo.await",
      "ffmpeg",
    ].map((item) => f.log.indexOf(item));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.every((index) => index >= 0)).toBe(true);
    const phaseOrder = ["voice", "stills", "startImages", "clips", "graphics", "assemble"].map(
      (item) => phases.indexOf(item),
    );
    expect(phaseOrder.every((index) => index >= 0)).toBe(true);
    expect(phaseOrder).toEqual([...phaseOrder].sort((left, right) => left - right));
    const names = new Set(result.artifacts.map((asset) => asset.name));
    for (const name of [
      "voice-1-01-1.wav",
      "voice-1.json",
      "timeline-1.json",
      "still-1-S1-1.png",
      "still-review-1-S1-1.json",
      "start-1-A-1.png",
      "start-review-1-A-1.json",
      "clip-1-A-1.mp4",
      "clip-review-1-A-1.json",
      "captions-1.ass",
      "video-final-1.mp4",
      "render-report-1.json",
      "video-final-2.mp4",
    ])
      expect(names.has(name)).toBe(true);
    const final = result.artifacts.find((asset) => asset.name === "video-final-1.mp4");
    expect(final?.kind).toBe("video");
    expect(final?.model?.provider).toBe("ffmpeg");
    expect(final?.model?.requestedModel).toMatch(/^ffmpeg-/);
    expect(result.artifacts.find((asset) => asset.name === "captions-1.ass")?.kind).toBe("text");
    expect(result.artifacts.find((asset) => asset.name === "voice-1-01-1.wav")?.kind).toBe("audio");
    const render = result.renders.find((item) => item.number === 1);
    expect(render?.final?.name).toBe("video-final-1.mp4");
    expect(render?.final?.bgmTrackId).toBeNull();
    expect(render?.voice?.timelineDigest).toMatch(/^[0-9a-f]{64}$/);
    const timeline = RenderTimelineSchema.parse(
      JSON.parse(await Bun.file(join(f.store.root, "artifacts", job.id, "timeline-1.json")).text()),
    );
    expect(Math.abs((render?.final?.durationMs ?? 0) - timeline.durationMs)).toBeLessThanOrEqual(
      250,
    );
    expect(
      timeline.cuts.some(
        (cut) => cut.sourceRef.kind === "project" && cut.sourceRef.audio === "keep",
      ),
    ).toBe(true);
    expect(timeline.cuts.some((cut) => cut.sourceRef.kind === "card")).toBe(true);
    // 정지 이미지: 컷은 still 소스로 타임라인에 들어가고, 파일은 renders 기록(digest)과 함께 저장된다
    expect(timeline.cuts.some((cut) => cut.sourceRef.kind === "still")).toBe(true);
    const stillIds = (result.videoScripts[0]?.stills ?? []).map((still) => still.id);
    expect(stillIds).toContain("S1");
    for (const stillId of stillIds) {
      const state = render?.stills[stillId];
      expect(state).toMatchObject({
        name: `still-1-${stillId}-1.png`,
        attempts: 1,
        status: "pass",
      });
      expect(state?.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    // 정지 이미지 호출은 영상마다 선언한 장수만큼(검토 통과라 장당 1회), 시작 이미지는 클립 수만큼
    expect(f.counts.still).toBe(
      result.videoScripts.reduce((sum, script) => sum + script.stills.length, 0),
    );
    expect(f.counts.startImage).toBe(8);
    expect(result.events.some((event) => event.message.includes("BGM"))).toBe(true);
    expect(f.counts.veoCreate).toBe(8);
    expect(f.counts.voice).toBe(
      result.videoScripts.reduce((sum, script) => sum + script.voiceover.length, 0),
    );
    // 세그먼트 캐시는 artifacts 에 등록하지 않는다
    expect(result.artifacts.some((asset) => asset.name.startsWith("seg-"))).toBe(false);
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "a second run after completion makes zero paid calls and reuses cached segments on re-assembly",
  async () => {
    const job = f.fresh();
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await settle(engine);
    expect(f.store.get(job.id).automation?.status).toBe("completed");
    const before = snapshot();
    f.store.change(job.id, (draft) => {
      if (draft.automation) {
        draft.automation.status = "queued";
        draft.automation.nextRunAt = new Date().toISOString();
      }
    });
    await settle(engine);
    expect(f.store.get(job.id).automation?.status).toBe("completed");
    expect(snapshot()).toEqual({ ...before, preflight: before.preflight });
    // 완성본만 지우고 다시 돌리면 세그먼트는 캐시에서 재사용된다(세그먼트 렌더 0회, concat·최종·검증만)
    const segmentCalls = f.ffmpegCalls.length;
    f.store.change(job.id, (draft) => {
      draft.artifacts = draft.artifacts.filter((asset) => asset.name !== "video-final-1.mp4");
      const render = draft.renders[0];
      if (render) render.final = null;
      if (draft.automation) {
        draft.automation.status = "queued";
        draft.automation.nextRunAt = new Date().toISOString();
      }
    });
    await settle(engine);
    expect(f.store.get(job.id).automation?.status).toBe("completed");
    const again = f.ffmpegCalls.slice(segmentCalls);
    expect(again.some((args) => args.includes("-filter_complex"))).toBe(false);
    expect(again.some((args) => args[0] === "-f" && args[1] === "concat")).toBe(true);
    // 두 번째 실행은 완성본이 있어 영상 전체를 건너뛰었고(preflight 0회), 세 번째만 preflight 를 다시 돌았다.
    // 내레이션이 이미 합성돼 있어 Typecast 구독(크레딧) 조회는 하지 않는다.
    expect(snapshot()).toEqual({ ...before, preflight: before.preflight + 1 });
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "stop during a clip await and resume with a new engine keeps paid call counts identical",
  async () => {
    const job = f.fresh();
    let release = () => {};
    f.control.holdAwait = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await engine.tick();
    // 첫 await 가 붙잡힐 때까지 기다린다
    for (let waited = 0; f.counts.veoAwait === 0 && waited < 200; waited++) await Bun.sleep(50);
    expect(f.counts.veoAwait).toBe(1);
    await engine.stop(job.id);
    expect(f.store.get(job.id).automation?.status).toBe("stopped");
    const stopped = snapshot();
    expect(stopped.veoCreate).toBe(4);
    f.control.holdAwait = null;
    release();
    const second = new AutomationEngine(
      f.store,
      automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
    );
    try {
      second.resume(job.id);
      await settle(second);
      const result = f.store.get(job.id);
      expect(result.automation?.lastError).toBeNull();
      expect(result.automation?.status).toBe("completed");
      const after = snapshot();
      expect(after.voice).toBe(stopped.voice);
      expect(after.image).toBe(stopped.image);
      expect(after.veoCreate).toBe(4);
      expect(after.veoAwait).toBe(1 + 4);
    } finally {
      second.close();
    }
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "a tampered start image blocks the clip stage before any Veo request",
  async () => {
    const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await f.production.run(job.id, signal());
    await f.deps.voice?.run(job.id, 1, signal(), { concurrencyLimit: 3 });
    await f.deps.startImages?.run(job.id, 1, signal());
    await Bun.write(join(f.store.root, "artifacts", job.id, "start-1-B-1.png"), "changed bytes");
    const failure = f.renderPipeline.run(job.id, signal());
    await expect(failure).rejects.toBeInstanceOf(BlockedError);
    await expect(failure).rejects.toThrow("변경");
    expect(f.counts.veoCreate).toBe(0);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "a missing Typecast key blocks before any synthesis and wakeBlocked resumes to completion",
  async () => {
    f.control.credentials.typecast = "";
    const job = f.fresh();
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await settle(engine);
    const blocked = f.store.get(job.id);
    expect(blocked.automation?.status).toBe("blocked");
    expect(blocked.automation?.lastError).toContain("Typecast");
    expect(f.counts.voice).toBe(0);
    expect(f.counts.veoCreate).toBe(0);
    // /api/connections 가 하는 일: 키 저장 뒤 wakeBlocked (.env 영속은 테스트에서 건너뛴다)
    f.control.credentials.typecast = "k";
    engine.wakeBlocked();
    await settle(engine);
    expect(f.store.get(job.id).automation?.status).toBe("completed");
    expect(f.counts.veoCreate).toBe(4);
  },
  300_000,
);

test.skipIf(!hasFfmpeg)(
  "narration that cannot fit stops with voice_overflow before any Veo request",
  async () => {
    f.control.durationScale = 3;
    const job = f.fresh();
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "auto",
    });
    await settle(engine);
    const result = f.store.get(job.id);
    expect(result.automation?.status).toBe("attention");
    expect(result.automation?.lastError).toContain("내레이션");
    expect(f.counts.veoCreate).toBe(0);
    expect(f.counts.startImage).toBe(0);
    // 템포 재합성(attempt 2)은 시도했다
    expect(f.counts.voice).toBeGreaterThan(result.videoScripts[0]?.voiceover.length ?? 0);
  },
  120_000,
);

test.skipIf(!hasFfmpeg)(
  "a fake FFMPEG_PATH stops preflight with render_unavailable (attention) and resume is allowed after the fix",
  async () => {
    const previous = process.env["FFMPEG_PATH"];
    process.env["FFMPEG_PATH"] = join(f.root, "no-such-ffmpeg.exe");
    const job = f.fresh();
    try {
      engine.start(job.id, {
        mode: "creative",
        imageCount: 1,
        videoCount: 1,
        scriptApproval: "auto",
      });
      await settle(engine);
      const result = f.store.get(job.id);
      expect(result.automation?.status).toBe("attention");
      expect(result.automation?.lastError).toContain("ffmpeg");
      expect(f.counts.voice).toBe(0);
      expect(f.counts.veoCreate).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["FFMPEG_PATH"];
      else process.env["FFMPEG_PATH"] = previous;
    }
    engine.resume(job.id);
    await settle(engine);
    expect(f.store.get(job.id).automation?.status).toBe("completed");
  },
  300_000,
);
