import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { installStatic } from "../server/static";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-static-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  const content = "const message = 'compressed static fixture';\n".repeat(4000);
  await Bun.write(join(root, "assets", "index-abcdefgh.js"), content);
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Fixture shell</title>");
  const app = new Hono();
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "state", data: "{}" });
    }),
  );
  installStatic(app, root);
  return { app, content };
}
test("hashed static assets negotiate compression and immutable cache", async () => {
  const { app, content } = await fixture();
  const response = await app.request("http://localhost/assets/index-abcdefgh.js", {
    headers: { "Accept-Encoding": "gzip" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Encoding")).toBe("gzip");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(response.headers.get("Vary")).toContain("Accept-Encoding");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.length).toBeLessThan(content.length / 10);
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(content);
  const identity = await app.request("http://localhost/assets/index-abcdefgh.js");
  expect(identity.headers.has("Content-Encoding")).toBe(false);
  expect(await identity.text()).toBe(content);
});
test("robots is plaintext, missing assets are404, and HTML is not immutable", async () => {
  const { app } = await fixture();
  const robots = await app.request("http://localhost/robots.txt");
  expect(robots.headers.get("Content-Type")).toContain("text/plain");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  expect((await app.request("http://localhost/assets/missing.js")).status).toBe(404);
  const shell = await app.request("http://localhost/");
  expect(shell.status).toBe(200);
  expect(shell.headers.get("Cache-Control")).toBe("no-cache");
});
test("SSE remains uncompressed and readable with Accept-Encoding gzip", async () => {
  const { app } = await fixture();
  const response = await app.request("http://localhost/api/events", {
    headers: { "Accept-Encoding": "gzip" },
  });
  expect(response.headers.has("Content-Encoding")).toBe(false);
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  expect(await response.text()).toContain("event: state");
});
