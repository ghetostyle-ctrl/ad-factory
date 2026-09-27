import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";
import { mergeSourceContent } from "../shared/source-image-preview";

test("keeps manually entered facts when image and URL drafts are merged", () => {
  const initial = "직접 확인한 규격: 500ml";
  const urlDraft = "상품명: 데일리 텀블러\n직접 확인한 규격: 500ml";
  const imageDraft = "[상세페이지.png] 구성품: 본체, 뚜껑";
  expect(mergeSourceContent(mergeSourceContent(initial, urlDraft), imageDraft)).toBe(
    "직접 확인한 규격: 500ml\n상품명: 데일리 텀블러\n[상세페이지.png] 구성품: 본체, 뚜껑",
  );
});

test("image preview requires a selected file and does not save product data", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-source-image-"));
  const store = new JobStore(root);
  try {
    const project = new ProjectStore(store.db).createProject({
      name: "Preview test",
      description: "",
    });
    const origin = `http://127.0.0.1:${env.PORT}`;
    const response = await createApp(store).request(
      new Request(`${origin}/api/projects/${project.id}/source-image-preview`, {
        method: "POST",
        headers: { Origin: origin },
        body: new FormData(),
      }),
    );
    expect(response.status).toBe(400);
    expect(new ProjectStore(store.db).listSources(project.id)).toEqual([]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
