import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";

test("creates a project job without a fixed product summary or audience when product facts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-project-job-"));
  const store = new JobStore(root);
  try {
    const library = new ProjectStore(store.db);
    const project = library.createProject({ name: "Product project", description: "" });
    const origin = `http://127.0.0.1:${env.PORT}`;
    const create = () =>
      createApp(store).request(
        new Request(`${origin}/api/jobs`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            name: "Product campaign",
            productUrl: "https://example.com/product",
            productDescription: "",
            audience: "",
          }),
        }),
      );
    expect((await create()).status).toBe(400);
    const fact = library.addSource(project.id, {
      kind: "product_fact",
      title: "Verified product",
      content: "용량 500ml, 스테인리스 재질의 상품",
      url: "https://example.com/product",
      evidence: "observed",
      status: "eligible",
      expiresAt: null,
      provenance: { origin: "user", externalId: null, capturedAt: null, author: null },
    });
    const response = await create();
    expect(response.status).toBe(201);
    const job = await response.json();
    expect(job.productDescription).toBe("");
    expect(job.audience).toBe("");
    expect(job.dailyBudget).toBeNull();
    expect(job.sourceSnapshot.sources.map((source: { id: string }) => source.id)).toContain(
      fact.id,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
