import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";

export function installStatic(app: Hono, root = "./dist"): void {
  app.get("/robots.txt", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.text("User-agent: *\nDisallow: /\n");
  });
  app.use("/assets/*", compress());
  app.use(
    "/assets/*",
    serveStatic({
      root,
      onFound: (_path, c) => {
        const hashed = /\/assets\/[^/]+-[\w-]{8,}\.[a-z\d]+$/i.test(c.req.path);
        c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  app.get("/assets/*", (c) => c.notFound());
  app.use(
    "/*",
    serveStatic({ root, onFound: (_path, c) => c.header("Cache-Control", "no-cache") }),
  );
  app.get(
    "/*",
    serveStatic({
      path: join(root, "index.html"),
      onFound: (_path, c) => c.header("Cache-Control", "no-cache"),
    }),
  );
}
