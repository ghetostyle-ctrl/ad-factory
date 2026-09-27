import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/store";
import { automationBrief } from "./automation-fixture";

test("duplicate occupied-port startup cannot recover or mutate a live database", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-entrypoint-"));
  const store = new JobStore(root);
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("occupied fixture"),
  });
  try {
    const job = store.create(automationBrief);
    const before = store.change(job.id, (draft) => {
      draft.status = "running";
    });
    const child = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env["PATH"] ?? "",
        PORT: String(occupied.port),
        DATA_DIR: root,
        NODE_ENV: "production",
        TEXT_PROVIDER: "none",
        OPENAI_API_KEY: "",
        META_ACCESS_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(output).toContain("EADDRINUSE");
    expect(store.get(job.id)).toEqual(before);
  } finally {
    await occupied.stop(true);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
