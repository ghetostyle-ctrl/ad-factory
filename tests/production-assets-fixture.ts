import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { JobStore } from "../server/store";
import { ProductionAssetSchema } from "../shared/production-assets";
import { ProjectSchema } from "../shared/sources";

const prefix = join(tmpdir(), "studio-production-");
export const resources = new Map<string, JobStore>();
export const origin = `http://127.0.0.1:${env.PORT}`;
let fixtureRoot = "";
export const footage = {
  video: new Uint8Array(0),
  mov: new Uint8Array(0),
  webm: new Uint8Array(0),
};
beforeAll(async () => {
  fixtureRoot = await mkdtemp(prefix);
  const path = join(fixtureRoot, "clip.mp4");
  const result = Bun.spawnSync([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=96x64:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    path,
  ]);
  expect(result.exitCode).toBe(0);
  footage.video = new Uint8Array(await Bun.file(path).arrayBuffer());
  const formats = [
    { extension: "mov", codecs: ["-c", "copy"] },
    { extension: "webm", codecs: ["-c:v", "libvpx-vp9", "-c:a", "libopus"] },
  ] as const;
  for (const format of formats) {
    const output = join(fixtureRoot, `clip.${format.extension}`);
    const encoded = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path,
      ...format.codecs,
      output,
    ]);
    expect(encoded.exitCode).toBe(0);
    footage[format.extension] = new Uint8Array(await Bun.file(output).arrayBuffer());
  }
});
afterEach(async () => {
  for (const [root, store] of resources) {
    store.close();
    if (resolve(root).startsWith(resolve(prefix))) await rm(root, { recursive: true, force: true });
  }
  resources.clear();
});
afterAll(async () => {
  if (resolve(fixtureRoot).startsWith(resolve(prefix)))
    await rm(fixtureRoot, { recursive: true, force: true });
});
export function json(path: string, body: unknown, method = "POST") {
  return new Request(`${origin}/api${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export async function setup() {
  const store = new JobStore(await mkdtemp(prefix));
  resources.set(store.root, store);
  const app = createApp(store);
  const response = await app.request(json("/projects", { name: "Production project" }));
  expect(response.status).toBe(201);
  const project = ProjectSchema.parse(await response.json());
  return { store, app, path: `/projects/${project.id}/production-assets`, project };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
export function upload(
  context: Fixture,
  files: File | readonly File[] | string = new File([footage.video], "clip.mp4", {
    type: "video/mp4",
  }),
) {
  const body = new FormData();
  if (typeof files !== "string")
    for (const file of files instanceof File ? [files] : files) body.append("file", file);
  return context.app.request(`${origin}/api${context.path}`, {
    method: "POST",
    headers:
      typeof files === "string"
        ? { Origin: origin, "Content-Type": "multipart/form-data; boundary=broken" }
        : { Origin: origin },
    body: typeof files === "string" ? files : body,
  });
}
export async function saved() {
  const context = await setup();
  const response = await upload(context);
  expect(response.status).toBe(201);
  return { ...context, asset: ProductionAssetSchema.parse(await response.json()) };
}

export const rejectedUploads = [
  { name: "image", body: new File(["image"], "image.png", { type: "image/png" }) },
  { name: "corrupt", body: new File(["not a movie"], "clip.mp4", { type: "video/mp4" }) },
  { name: "empty", body: new File([], "clip.mp4", { type: "video/mp4" }) },
  { name: "missing", body: [] },
  { name: "duplicate", body: [new File(["a"], "one.mp4"), new File(["b"], "two.mp4")] },
  { name: "malformed multipart", body: "invalid multipart body" },
] as const;
