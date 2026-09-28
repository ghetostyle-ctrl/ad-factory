import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { JobStore } from "../server/store";
import { CreateJobSchema } from "../shared/schema";

const origin = `http://127.0.0.1:${env.PORT}`;
const brief = CreateJobSchema.parse({
  name: "Delete target",
  productUrl: "https://example.com/product",
  productDescription: "스테인리스 재질의 500ml 보온 텀블러, 12시간 보온",
  audience: "출퇴근하는 직장인",
});

test("deletes an idle job and its artifact folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-job-delete-"));
  const store = new JobStore(root);
  try {
    const job = store.create(brief);
    const folder = join(root, "artifacts", job.id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "strategy.json"), "{}");
    const response = await createApp(store).request(
      new Request(`${origin}/api/jobs/${job.id}`, {
        method: "DELETE",
        headers: { Origin: origin },
      }),
    );
    expect(response.status).toBe(200);
    expect(store.list().some((item) => item.id === job.id)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to delete a running job or a cross-origin request", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-job-delete-"));
  const store = new JobStore(root);
  try {
    const job = store.create(brief);
    const app = createApp(store);
    const crossOrigin = await app.request(
      new Request(`${origin}/api/jobs/${job.id}`, {
        method: "DELETE",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(crossOrigin.status).toBe(403);
    store.change(job.id, (draft) => {
      draft.status = "running";
    });
    const running = await app.request(
      new Request(`${origin}/api/jobs/${job.id}`, {
        method: "DELETE",
        headers: { Origin: origin },
      }),
    );
    expect(running.status).toBe(409);
    expect(store.list().some((item) => item.id === job.id)).toBe(true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
