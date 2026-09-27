import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../server/app";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";
import { ProductionAssetSchema, ProductionAssetsSchema } from "../shared/production-assets";
import { JobSchema } from "../shared/schema";
import { CreateSourceSchema, ProjectSchema } from "../shared/sources";
import { automationBrief } from "./automation-fixture";
import {
  footage,
  json,
  origin,
  rejectedUploads,
  resources,
  saved,
  setup,
  upload,
} from "./production-assets-fixture";

test("extracts real video metadata and defaults when a local MP4 is uploaded", async () => {
  // Given
  const context = await setup();
  // When
  const response = await upload(context);
  // Then
  expect(response.status).toBe(201);
  const asset = ProductionAssetSchema.parse(await response.json());
  expect(asset).toMatchObject({
    projectId: context.project.id,
    filename: "clip.mp4",
    contentType: "video/mp4",
    bytes: footage.video.length,
    sha256: createHash("sha256").update(footage.video).digest("hex"),
    width: 96,
    height: 64,
    hasAudio: true,
    settings: {
      usage: "required",
      startSec: 0,
      endSec: null,
      placement: "auto",
      targets: { mode: "all" },
      audio: "mute",
      notes: "",
    },
  });
  expect(asset.durationSec).toBeCloseTo(2, 1);
});

test("streams original bytes when an uploaded video is opened", async () => {
  // Given
  const { app, path, asset } = await saved();
  // When
  const response = await app.request(`${origin}/api${path}/${asset.id}/file`);
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(footage.video);
});

test("stores trim, placement, targets and audio when settings are updated", async () => {
  // Given
  const { app, path, asset } = await saved();
  const settings = {
    usage: "optional",
    startSec: 0.25,
    endSec: 1.75,
    placement: "opening",
    targets: { mode: "selected", videoNumbers: [1, 10] },
    audio: "keep",
    notes: "Opening product footage",
  };
  // When
  const response = await app.request(
    json(`${path}/${asset.id}`, { title: "Product opening", settings }, "PUT"),
  );
  // Then
  expect(response.status).toBe(200);
  expect(ProductionAssetSchema.parse(await response.json())).toMatchObject({
    id: asset.id,
    title: "Product opening",
    settings,
  });
});

test("restores asset metadata when the database reopens", async () => {
  // Given
  const { store, path, asset } = await saved();
  store.close();
  const reopened = new JobStore(store.root);
  resources.set(store.root, reopened);
  // When
  const response = await createApp(reopened).request(`${origin}/api${path}`);
  // Then
  expect(response.status).toBe(200);
  expect(ProductionAssetsSchema.parse(await response.json()).assets).toEqual([asset]);
});

test.each(["GET", "PUT", "DELETE"])(
  "rejects cross-project %s access to an asset",
  async (method) => {
    // Given
    const { app, asset } = await saved();
    const other = ProjectSchema.parse(
      await (await app.request(json("/projects", { name: "Other" }))).json(),
    );
    const path = `/projects/${other.id}/production-assets/${asset.id}`;
    // When
    const response = await app.request(
      method === "GET"
        ? `${origin}/api${path}/file`
        : json(path, { title: asset.title, settings: asset.settings }, method),
    );
    // Then
    expect(response.status).toBe(404);
  },
);

test("lists only assets belonging to the requested project", async () => {
  // Given
  const { app } = await saved();
  const other = ProjectSchema.parse(
    await (await app.request(json("/projects", { name: "Other" }))).json(),
  );
  // When
  const response = await app.request(`${origin}/api/projects/${other.id}/production-assets`);
  // Then
  expect(ProductionAssetsSchema.parse(await response.json()).assets).toEqual([]);
});

test.each(["list", "file"])(
  "preserves archive %s behavior when an asset was deleted",
  async (surface) => {
    // Given
    const { app, path, asset } = await saved();
    const removed = await app.request(json(`${path}/${asset.id}`, {}, "DELETE"));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    // When
    const response = await app.request(
      `${origin}/api${path}${surface === "file" ? `/${asset.id}/file` : ""}`,
    );
    // Then
    expect(response.status).toBe(200);
    if (surface === "file")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(footage.video);
    else expect(ProductionAssetsSchema.parse(await response.json()).assets).toEqual([]);
  },
);

test.each([
  { startSec: -1 },
  { startSec: 2 },
  { startSec: 0.5, endSec: 0.5 },
  { endSec: 3 },
  { endSec: 0 },
  { startSec: "0" },
  { targets: { mode: "selected", videoNumbers: [] } },
  { targets: { mode: "selected", videoNumbers: [1, 1] } },
  { targets: { mode: "selected", videoNumbers: [0] } },
  { targets: { mode: "selected", videoNumbers: [11] } },
  { targets: { mode: "selected", videoNumbers: [1.5] } },
  { audio: "loud" },
])("rejects invalid settings when updated: %j", async (changes) => {
  // Given
  const { app, path, asset } = await saved();
  // When
  const response = await app.request(
    json(
      `${path}/${asset.id}`,
      { title: asset.title, settings: { ...asset.settings, ...changes } },
      "PUT",
    ),
  );
  // Then
  expect(response.status).toBe(400);
});

test.each(["bytes=2-11", "bytes=2-", "bytes=-10"])(
  "supports playback when requesting %s",
  async (range) => {
    // Given
    const { app, path, asset } = await saved();
    const expected =
      range === "bytes=2-11"
        ? footage.video.slice(2, 12)
        : range === "bytes=2-"
          ? footage.video.slice(2)
          : footage.video.slice(-10);
    const start = range === "bytes=-10" ? footage.video.length - 10 : 2;
    // When
    const response = await app.request(`${origin}/api${path}/${asset.id}/file`, {
      headers: { Range: range },
    });
    // Then
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes ${start}-${start + expected.length - 1}/${footage.video.length}`,
    );
    expect(response.headers.get("content-length")).toBe(String(expected.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  },
);

test.each(["bytes=999999999-", "bytes=8-2", "bytes=0-1,4-5", "bytes=-0"])(
  "rejects unsatisfiable or multiple ranges: %s",
  async (range) => {
    // Given
    const { app, path, asset } = await saved();
    // When
    const response = await app.request(`${origin}/api${path}/${asset.id}/file`, {
      headers: { Range: range },
    });
    // Then
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${footage.video.length}`);
  },
);

test.each([...rejectedUploads])("rejects invalid upload: %j", async (input) => {
  // Given
  const context = await setup();
  // When
  const response = await upload(context, input.body);
  // Then
  expect(response.status).toBe(400);
});

test("accepts a valid video larger than 16 MiB when using the upload route", async () => {
  // Given
  const context = await setup();
  const padding = new Uint8Array(17 * 1024 * 1024);
  new DataView(padding.buffer).setUint32(0, padding.length);
  padding.set(new TextEncoder().encode("free"), 4);
  const file = new File([footage.video, padding], "large.mp4", { type: "video/mp4" });
  // When
  const response = await upload(context, file);
  // Then
  expect(response.status).toBe(201);
  expect(ProductionAssetSchema.parse(await response.json()).bytes).toBe(file.size);
});

test("retains the 16 MiB limit when posting to a normal JSON route", async () => {
  // Given
  const { app } = await setup();
  // When
  const response = await app.request(json("/projects", { name: "x".repeat(17 * 1024 * 1024) }));
  // Then
  expect(response.status).toBe(413);
});

test("freezes uploaded source settings when the original asset is later edited and archived", async () => {
  // Given
  const { app, store, path, asset, project } = await saved();
  new ProjectStore(store.db).addSource(
    project.id,
    CreateSourceSchema.parse({
      kind: "product_fact",
      title: "Fixture product",
      content: automationBrief.productDescription,
    }),
  );
  const created = await app.request(json("/jobs", { ...automationBrief, projectId: project.id }));
  expect(created.status).toBe(201);
  const job = JobSchema.parse(await created.json());
  // When
  const changed = await app.request(
    json(
      `${path}/${asset.id}`,
      {
        title: "Changed footage",
        settings: {
          ...asset.settings,
          startSec: 0.5,
          endSec: 1,
          audio: "keep",
          targets: { mode: "selected", videoNumbers: [3] },
        },
      },
      "PUT",
    ),
  );
  expect(changed.status).toBe(200);
  const removed = await app.request(json(`${path}/${asset.id}`, {}, "DELETE"));
  // Then
  expect(removed.status).toBe(200);
  expect(store.get(job.id).productionSourceSnapshot?.assets).toEqual([asset]);
  expect((await app.request(`${origin}/api${path}/${asset.id}/file`)).status).toBe(200);
});

test.each(["mov", "webm"] as const)("accepts a real %s video with audio", async (format) => {
  // Given
  const context = await setup();
  const contentType = format === "mov" ? "video/quicktime" : "video/webm";
  const file = new File([footage[format]], `clip.${format}`, { type: contentType });
  // When
  const response = await upload(context, file);
  // Then
  expect(response.status).toBe(201);
  expect(ProductionAssetSchema.parse(await response.json())).toMatchObject({
    filename: file.name,
    contentType,
    width: 96,
    height: 64,
    hasAudio: true,
  });
});
