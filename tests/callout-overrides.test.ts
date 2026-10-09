import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { applyCalloutOverrides, CalloutOverrides } from "../server/callout-overrides";
import { StudioError } from "../server/errors";
import { jobRoutes } from "../server/job-routes";
import { MusicLibrary } from "../server/music-library";
import { Pipeline } from "../server/pipeline";
import { runFfmpeg } from "../server/render/ffmpeg";
import { DEFAULT_PROFILE } from "../server/render/theme";
import { RenderProduction } from "../server/render-production";
import { renderNames, renderStateOf, saveArtifactOnce } from "../server/render-state-helpers";
import { VideoReassembly } from "../server/video-reassembly";
import { CalloutOverridesViewSchema } from "../shared/callout-overrides";
import { RenderTimelineSchema, timelineDigest } from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";
import { renderProfile } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
}, 30_000);
afterEach(async () => {
  await f.close();
}, 30_000);
async function completed() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, new AbortController().signal);
  await f.renderPipeline.run(job.id, new AbortController().signal);
  // 타임라인은 제작 경로가 저장한 그대로 둔다(마지막 문장의 픽스처 콜아웃 1개 포함).
  // 재조립은 저장 음성으로 타임라인을 다시 계산하므로, 손으로 고친 타임라인은 지문이 어긋나 보정이 버려진다.
  const timeline = RenderTimelineSchema.parse(
    await (await f.production.assets.read(job.id, renderNames.timeline(1))).json(),
  );
  if ((timeline.callouts?.length ?? 0) === 0) throw new Error("fixture callout missing");
  const final = new Uint8Array(await Bun.file(join(f.root, "media", "veo.mp4")).arrayBuffer());
  await saveArtifactOnce(f.production.assets, job.id, {
    name: renderNames.final(1),
    kind: "video",
    content: final,
    agentId: "production",
  });
  f.store.change(job.id, (draft) => {
    if (!draft.automation) throw new Error("fixture automation missing");
    draft.automation.status = "completed";
    draft.automation.operation = null;
    draft.automation.nextRunAt = null;
    draft.status = "completed";
    const render = renderStateOf(draft, 1);
    if (!render.voice) throw new Error("fixture voice missing");
    render.voice.timelineDigest = timelineDigest(timeline);
    render.final = {
      name: renderNames.final(1),
      digest: sha256Hex(final),
      durationMs: timeline.durationMs,
      bgmTrackId: null,
    };
  });
  const app = new Hono();
  app.route("/api/jobs", jobRoutes(f.store, new Pipeline(f.store), new AutomationEngine(f.store)));
  app.onError((error, c) =>
    c.json(
      { code: error instanceof StudioError ? error.code : "invalid" },
      error instanceof StudioError ? error.status : error instanceof ZodError ? 400 : 503,
    ),
  );
  const url = `/api/jobs/${job.id}/videos/1/callout-overrides`;
  return { id: job.id, app, url, timeline };
}
const points = [
  { at: 0, target: { x: 0.2, y: 0.3 }, label: { x: 0.7, y: 0.3 } },
  { at: 0.5, target: { x: 0.4, y: 0.4 }, label: { x: 0.7, y: 0.4 } },
  { at: 1, target: { x: 0.6, y: 0.5 }, label: { x: 0.7, y: 0.5 } },
];
const edit = (fingerprint: string) => ({
  fingerprint,
  confirmReviewed: true,
  callouts: [{ index: 0, targetId: "capsule", keyframes: points }],
});
const put = (app: Hono, url: string, body: unknown) =>
  app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("HTTP confirmed path is saved separately without changing the timeline or invoking providers", async () => {
  // Given
  const { id, app, url, timeline } = await completed();
  const original = await (await f.production.assets.read(id, renderNames.timeline(1))).text();
  const counts = { ...f.counts };
  const response = await app.request(url);
  expect(response.status).toBe(200);
  const view = CalloutOverridesViewSchema.parse(await response.json());
  const context = { timeline, profile: DEFAULT_PROFILE, fingerprint: view.fingerprint };
  // When
  const saved = await put(app, url, edit(view.fingerprint));
  // Then
  expect(saved.status).toBe(200);
  expect(CalloutOverridesViewSchema.parse(await saved.json()).callouts[0]?.motion).toMatchObject({
    verification: "verified",
    verifiedSource: view.fingerprint,
    keyframes: points,
  });
  expect(await (await f.production.assets.read(id, renderNames.timeline(1))).text()).toBe(original);
  expect(f.counts).toEqual(counts);
  const trusted = await applyCalloutOverrides(f.production.assets, f.store.get(id), 1, context);
  expect(trusted.callouts?.[0]?.motion?.verifiedSource).toBe(view.fingerprint);
  const stale = await applyCalloutOverrides(f.production.assets, f.store.get(id), 1, {
    ...context,
    timeline: trusted,
    fingerprint: "0".repeat(64),
  });
  expect(stale.callouts?.[0]?.motion).toBeUndefined();
}, 30_000);

test.each(["stale", "busy", "unconfirmed", "forged", "out of range"])(
  "HTTP rejects %s paths without a sidecar",
  async (mode) => {
    // Given
    const { id, app, url } = await completed();
    const view = CalloutOverridesViewSchema.parse(await (await app.request(url)).json());
    const input = edit(mode === "stale" ? "0".repeat(64) : view.fingerprint);
    if (mode === "busy")
      f.store.change(id, (draft) => {
        draft.status = "running";
      });
    const body =
      mode === "unconfirmed"
        ? { ...input, confirmReviewed: false }
        : mode === "forged"
          ? { ...input, verifiedSource: view.fingerprint }
          : mode === "out of range"
            ? { ...input, callouts: [{ ...input.callouts[0], index: 999 }] }
            : input;
    // When
    const response = await put(app, url, body);
    // Then
    expect(response.status).toBe(
      mode === "unconfirmed" || mode === "forged" || mode === "out of range" ? 400 : 409,
    );
    expect(f.store.get(id).artifacts.some((item) => item.name === "callout-overrides-1.json")).toBe(
      false,
    );
  },
  30_000,
);

test("HTTP saved motion reaches the real local reassembly without modifying paid inputs", async () => {
  // Given
  const { id, url, timeline } = await completed();
  for (const item of [
    { name: renderNames.report(1), kind: "json" as const, content: "{}" },
    { name: renderNames.captions(1), kind: "text" as const, content: "[Events]" },
  ])
    await saveArtifactOnce(f.production.assets, id, { ...item, agentId: "production" });
  const renderer = new RenderProduction(
    f.store,
    f.library,
    f.root,
    new MusicLibrary(join(f.root, "no-bgm")),
    renderProfile,
    runFfmpeg,
    { encoder: "libx264", preset: "ultrafast", durationBounds: [1, 60] },
  );
  const api = new Hono();
  api.route(
    "/api/jobs",
    jobRoutes(
      f.store,
      new Pipeline(f.store),
      new AutomationEngine(f.store),
      new VideoReassembly(f.store, renderer),
      new CalloutOverrides(f.store, renderer),
    ),
  );
  const view = CalloutOverridesViewSchema.parse(await (await api.request(url)).json());
  expect((await put(api, url, edit(view.fingerprint))).status).toBe(200);
  const before = f.store.get(id);
  const counts = { ...f.counts };
  // When
  const response = await api.request(`/api/jobs/${id}/videos/1/reassemble`, { method: "POST" });
  // Then
  expect(response.status).toBe(200);
  const captions = await (await f.production.assets.read(id, renderNames.captions(1))).text();
  const paths = captions
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:") && line.includes(",MotionTarget,"));
  // 동작 경로는 콜아웃과 그 컷이 겹치는 구간을 출력 프레임 격자(1000/fps ms)로 표본화한다.
  const callout = timeline.callouts?.[0];
  const cut = timeline.cuts.find((item) => item.index === callout?.cutIndex);
  if (!callout || !cut) throw new Error("fixture callout or cut missing");
  const stepMs = 1000 / renderProfile.fps;
  const overlapMs = Math.min(cut.endMs, callout.endMs) - Math.max(cut.startMs, callout.startMs);
  expect(overlapMs).toBeGreaterThanOrEqual(1000);
  expect(paths.length).toBeGreaterThanOrEqual(Math.floor(overlapMs / stepMs));
  expect(paths.length).toBeLessThanOrEqual(Math.ceil(overlapMs / stepMs) + 1);
  expect(new Set(paths.map((line) => line.match(/\\pos\(([^)]+)\)/)?.[1])).size).toBeGreaterThan(
    paths.length / 2,
  );
  expect(f.counts).toEqual(counts);
  expect(f.store.get(id).renders[0]?.clips).toEqual(before.renders[0]?.clips);
  expect(await (await f.production.assets.read(id, renderNames.timeline(1))).json()).toEqual(
    timeline,
  );
}, 90_000);
