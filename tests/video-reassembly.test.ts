import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { automationServices } from "../server/automation-services";
import { StudioError } from "../server/errors";
import { jobRoutes } from "../server/job-routes";
import { MusicLibrary } from "../server/music-library";
import { Pipeline } from "../server/pipeline";
import { runFfmpeg } from "../server/render/ffmpeg";
import { RenderProduction } from "../server/render-production";
import {
  renderNames,
  renderStateOf,
  saveArtifactOnce,
  scriptDigest,
} from "../server/render-state-helpers";
import { VideoReassembly } from "../server/video-reassembly";
import { type VoiceManifest, VoiceManifestSchema } from "../server/voice-production";
import { buildTimeline, RenderTimelineSchema, timelineDigest } from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";
import { VideoScriptSchema } from "../shared/video-script";
import { renderProfile, sineWav } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
});
afterEach(async () => {
  await f.close();
});
const bytesOf = async (id: string, name: string) =>
  new Uint8Array(await (await f.production.assets.read(id, name)).arrayBuffer());
const renderer = () =>
  new RenderProduction(
    f.store,
    f.library,
    f.root,
    new MusicLibrary(join(f.root, "no-bgm")),
    renderProfile,
    runFfmpeg,
    { encoder: "libx264", preset: "ultrafast" },
  );
async function completed() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  await f.renderPipeline.run(job.id, signal());
  const final = new Uint8Array(await Bun.file(join(f.root, "media", "veo.mp4")).arrayBuffer());
  for (const asset of [
    { name: renderNames.final(1), kind: "video" as const, content: final },
    { name: renderNames.report(1), kind: "json" as const, content: '{"prior":true}' },
    { name: renderNames.captions(1), kind: "text" as const, content: "[Events]\n" },
  ])
    await saveArtifactOnce(f.production.assets, job.id, { ...asset, agentId: "production" });
  f.store.change(job.id, (draft) => {
    if (!draft.automation) throw new Error("fixture automation missing");
    draft.automation.status = "completed";
    draft.automation.phase = "finished";
    draft.automation.nextRunAt = null;
    draft.automation.operation = null;
    draft.status = "completed";
    renderStateOf(draft, 1).final = {
      name: renderNames.final(1),
      digest: sha256Hex(final),
      durationMs: 8000,
      bgmTrackId: null,
    };
  });
  return job.id;
}
function app(reassembly: VideoReassembly, engine = new AutomationEngine(f.store)) {
  const api = new Hono();
  api.route("/api/jobs", jobRoutes(f.store, new Pipeline(f.store), engine, reassembly));
  api.onError((error, c) =>
    c.json(
      { code: error instanceof StudioError ? error.code : "unknown" },
      error instanceof StudioError ? error.status : 503,
    ),
  );
  return api;
}
const post = (api: Hono, id: string) =>
  api.request(`/api/jobs/${id}/videos/1/reassemble`, { method: "POST" });

async function staleNineLineTimeline() {
  const id = await completed();
  const base = f.store.get(id).videoScripts[0];
  const firstCut = base?.cuts[0];
  const firstVoice = base?.voiceover[0];
  if (!base || !firstCut || !firstVoice) throw new Error("fixture script missing");
  const script = VideoScriptSchema.parse({
    ...base,
    durationSec: 45,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" },
    cuts: Array.from({ length: 9 }, (_, index) => ({
      ...firstCut,
      startSec: index * 5,
      endSec: (index + 1) * 5,
      source: "motion_graphic",
      veoClip: "",
      phase: "",
    })),
    voiceover: Array.from({ length: 9 }, (_, index) => ({
      ...firstVoice,
      text: `설명 문장 ${index + 1}입니다.`,
      fromCut: index,
      toCut: index,
      startSec: index * 5,
      endSec: (index + 1) * 5,
      callouts: [],
    })),
  });
  const digest = scriptDigest(script);
  const audio = sineWav(2500);
  const manifest: VoiceManifest = {
    number: 1,
    scriptDigest: digest,
    voiceId: "saved-nine-lines",
    selection: "manual",
    lines: script.voiceover.map((line, index) => ({
      index,
      text: line.text,
      textDigest: sha256Hex(line.text),
      name: renderNames.voice(1, index, 1),
      digest: sha256Hex(audio),
      durationMs: 2500,
      tempo: 1,
      attempt: 1,
      words: [{ text: line.text, start: 0.15, end: 2.4 }],
    })),
  };
  for (const line of manifest.lines)
    await saveArtifactOnce(f.production.assets, id, {
      name: line.name,
      kind: "audio",
      agentId: "production",
      content: audio,
    });
  await saveArtifactOnce(f.production.assets, id, {
    name: renderNames.voiceManifest(1),
    kind: "json",
    agentId: "production",
    content: JSON.stringify(manifest),
  });
  const built = buildTimeline(
    script,
    manifest.lines.map((line) => ({ ...line, artifactName: line.name })),
    { trimSilence: true, naturalTiming: true },
  );
  if (!("timeline" in built)) throw new Error("fixture timeline failed");
  const stale = structuredClone(built.timeline);
  const middle = stale.voice[4];
  if (!middle) throw new Error("fixture voice missing");
  middle.startMs += 700;
  await saveArtifactOnce(f.production.assets, id, {
    name: renderNames.timeline(1),
    kind: "json",
    agentId: "production",
    content: JSON.stringify(stale),
  });
  f.store.change(id, (draft) => {
    draft.videoScripts = [script];
    const render = renderStateOf(draft, 1);
    render.scriptDigest = digest;
    render.voice = {
      manifestName: renderNames.voiceManifest(1),
      voiceId: manifest.voiceId,
      timelineDigest: timelineDigest(stale),
    };
  });
  return { id, expected: built.timeline };
}

test("completed reassembly rebuilds nine saved voice placements without paid generation", async () => {
  const { id, expected } = await staleNineLineTimeline();
  const before = f.store.get(id);
  const timelineBytes = await bytesOf(id, renderNames.timeline(1));
  const counts = { ...f.counts };
  let observed = false;
  const production = renderer();
  await new VideoReassembly(f.store, {
    validateSavedInputs: production.validateSavedInputs.bind(production),
    run: async () => {
      const actual = RenderTimelineSchema.parse(
        await (await f.production.assets.read(id, renderNames.timeline(1))).json(),
      );
      expect(actual.voice).toEqual(expected.voice);
      expect(actual.cuts.map((cut) => cut.sourceRef)).toEqual(
        expected.cuts.map((cut) => cut.sourceRef),
      );
      expect(actual.scriptDigest).toBe(expected.scriptDigest);
      expect(f.store.get(id).renders[0]?.voice?.timelineDigest).toBe(timelineDigest(actual));
      observed = true;
    },
  }).run(id, 1, signal());
  expect(observed).toBe(true);
  expect(f.counts).toEqual(counts);
  expect(f.store.get(id).videoScripts).toEqual(before.videoScripts);
  const backups = f.store
    .get(id)
    .artifacts.filter((item) => item.name.includes("-before-reassembly-"));
  expect(backups).toHaveLength(4);
  const timelineBackup = backups.find((item) => item.name.startsWith("timeline-1-"));
  if (!timelineBackup) throw new Error("timeline backup missing");
  expect(await bytesOf(id, timelineBackup.name)).toEqual(timelineBytes);
});

test("failed refreshed reassembly restores timeline bytes and original voice digest", async () => {
  const { id, expected } = await staleNineLineTimeline();
  const before = f.store.get(id);
  const originalTimeline = await bytesOf(id, renderNames.timeline(1));
  const production = renderer();
  await expect(
    new VideoReassembly(f.store, {
      validateSavedInputs: production.validateSavedInputs.bind(production),
      run: async () => {
        const current = RenderTimelineSchema.parse(
          await (await f.production.assets.read(id, renderNames.timeline(1))).json(),
        );
        expect(current.voice).toEqual(expected.voice);
        await Bun.write(f.production.assets.path(id, renderNames.timeline(1)), "partial timeline");
        throw new StudioError("render_failed", "fixture render failure");
      },
    }).run(id, 1, signal()),
  ).rejects.toMatchObject({ code: "render_failed" });
  expect(f.store.get(id).renders).toEqual(before.renders);
  expect(await bytesOf(id, renderNames.timeline(1))).toEqual(originalTimeline);
}, 60_000);

test.each(["manifest text", "voice file"])(
  "timeline refresh rejects changed %s before any backup or state update",
  async (mode) => {
    const { id } = await staleNineLineTimeline();
    if (mode === "manifest text") {
      const manifest = VoiceManifestSchema.parse(
        await (await f.production.assets.read(id, renderNames.voiceManifest(1))).json(),
      );
      const line = manifest.lines[4];
      if (!line) throw new Error("fixture voice missing");
      line.text = "바뀐 대사";
      line.textDigest = sha256Hex(line.text);
      await Bun.write(
        f.production.assets.path(id, renderNames.voiceManifest(1)),
        JSON.stringify(manifest),
      );
    } else {
      await Bun.write(f.production.assets.path(id, renderNames.voice(1, 4, 1)), "changed voice");
    }
    const before = f.store.get(id);
    const originalTimeline = await bytesOf(id, renderNames.timeline(1));
    const final = await bytesOf(id, renderNames.final(1));
    const counts = { ...f.counts };
    await expect(new VideoReassembly(f.store, renderer()).run(id, 1, signal())).rejects.toThrow();
    expect(f.store.get(id)).toEqual(before);
    expect(await bytesOf(id, renderNames.timeline(1))).toEqual(originalTimeline);
    expect(await bytesOf(id, renderNames.final(1))).toEqual(final);
    expect(f.counts).toEqual(counts);
  },
  60_000,
);

test("HTTP local reassembly keeps paid inputs and backs up all prior outputs", async () => {
  // Given
  const id = await completed();
  const other = f.fresh();
  const before = f.store.get(id);
  const counts = { ...f.counts };
  const original = new Map(
    await Promise.all(
      before.artifacts.map(
        async (asset) => [asset.name, sha256Hex(await bytesOf(id, asset.name))] as const,
      ),
    ),
  );
  // When
  const response = await post(app(new VideoReassembly(f.store, renderer())), id);
  // Then
  expect(response.status).toBe(200);
  const after = f.store.get(id);
  expect(after.automation).toEqual(before.automation);
  expect(after.status).toBe("completed");
  expect(after.videoScripts).toEqual(before.videoScripts);
  expect(after.executionModels).toEqual(before.executionModels);
  expect(after.renders[0]?.scriptApproval).toEqual(before.renders[0]?.scriptApproval);
  expect(after.renders[0]?.voice).toEqual(before.renders[0]?.voice);
  expect(after.renders[0]?.clips).toEqual(before.renders[0]?.clips);
  expect(f.counts).toEqual(counts);
  expect(f.store.get(other.id)).toEqual(other);
  expect(after.renders[0]?.final?.digest).not.toBe(before.renders[0]?.final?.digest);
  const outputs = [renderNames.final(1), renderNames.report(1), renderNames.captions(1)];
  const backups = after.artifacts.filter((asset) => asset.name.includes("-before-reassembly-"));
  expect(backups).toHaveLength(3);
  for (const output of outputs) {
    const backup = backups.find((asset) =>
      asset.name.startsWith(output.slice(0, output.lastIndexOf("."))),
    );
    if (!backup) throw new Error("output backup missing");
    const digest = original.get(output);
    if (!digest) throw new Error("original output digest missing");
    expect(sha256Hex(await bytesOf(id, backup.name))).toBe(digest);
  }
  for (const [name, digest] of original)
    if (!outputs.includes(name)) expect(sha256Hex(await bytesOf(id, name))).toBe(digest);
}, 60_000);

test("reassembly restores usable previous outputs and completed state after a partial save failure", async () => {
  // Given
  const id = await completed();
  const before = f.store.get(id);
  const names = [renderNames.final(1), renderNames.report(1), renderNames.captions(1)];
  const originals = await Promise.all(names.map((name) => bytesOf(id, name)));
  const production = renderer();
  const reassembly = new VideoReassembly(f.store, {
    validateSavedInputs: production.validateSavedInputs.bind(production),
    run: async () => {
      for (const name of names)
        await Bun.write(f.production.assets.path(id, name), "partial output");
      throw new StudioError("render_failed", "fixture persistence failure");
    },
  });
  // When
  await expect(reassembly.run(id, 1, signal())).rejects.toMatchObject({ code: "render_failed" });
  // Then
  const after = f.store.get(id);
  expect(after.automation).toEqual(before.automation);
  expect(after.status).toEqual(before.status);
  expect(after.renders).toEqual(before.renders);
  expect(after.agents).toEqual(before.agents);
  for (const [index, name] of names.entries()) {
    const expected = originals[index];
    if (!expected) throw new Error("original output missing");
    expect(await bytesOf(id, name)).toEqual(expected);
  }
});

test.each(["busy", "unfinished", "missing voice", "changed timeline"])(
  "reassembly rejects %s before replacing the final video",
  async (mode) => {
    // Given
    const id = await completed();
    if (mode === "busy" || mode === "unfinished")
      f.store.change(id, (draft) => {
        if (draft.automation) draft.automation.status = mode === "busy" ? "running" : "waiting";
        if (mode === "busy") draft.status = "running";
      });
    if (mode === "missing voice")
      f.store.change(id, (draft) => {
        renderStateOf(draft, 1).voice = null;
      });
    if (mode === "changed timeline")
      await Bun.write(f.production.assets.path(id, renderNames.timeline(1)), "{}");
    const before = f.store.get(id);
    const final = await bytesOf(id, renderNames.final(1));
    const counts = { ...f.counts };
    // When
    const response = await post(app(new VideoReassembly(f.store, renderer())), id);
    // Then
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.store.get(id).automation).toEqual(before.automation);
    expect(await bytesOf(id, renderNames.final(1))).toEqual(final);
    expect(f.counts).toEqual(counts);
    expect(f.store.get(id).artifacts).toEqual(before.artifacts);
  },
);

test("duplicate requests and the scheduler cannot start work during local reassembly", async () => {
  // Given
  const id = await completed();
  const production = renderer();
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new AutomationEngine(
    f.store,
    automationServices(f.store, {
      production: f.production,
      renderPipeline: f.renderPipeline,
    }),
  );
  const api = app(
    new VideoReassembly(f.store, {
      validateSavedInputs: production.validateSavedInputs.bind(production),
      run: async () => {
        enter();
        await gate;
        throw new StudioError("render_failed", "fixture cancellation");
      },
    }),
    engine,
  );
  const counts = { ...f.counts };
  const first = post(api, id);
  await entered;
  try {
    // When
    const duplicate = await post(api, id);
    await engine.tick();
    // Then
    expect(duplicate.status).toBe(409);
    expect(f.store.get(id).automation).toMatchObject({ status: "running", nextRunAt: null });
    expect(engine.active.size).toBe(0);
    expect(f.counts).toEqual(counts);
  } finally {
    release();
    await first;
  }
});
