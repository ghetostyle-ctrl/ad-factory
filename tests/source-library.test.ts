import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { ProjectStore } from "../server/project-store";
import { factualSources } from "../server/source-evidence";
import { JobStore } from "../server/store";
import { ReferenceDataSchema } from "../shared/reference-schema";
import { SourceFilesSchema } from "../shared/source-files";
import {
  CreateSourceSchema,
  ProjectDetailSchema,
  ProjectSchema,
  ProjectSourceSchema,
  ProjectsSchema,
  SourceImportResultSchema,
} from "../shared/sources";

const resources = new Map<string, JobStore>();
const origin = `http://127.0.0.1:${env.PORT}`;
const fact = CreateSourceSchema.parse({
  kind: "product_fact",
  title: "Product capacity",
  content: "Capacity: 500 ml.",
});
const referenceData = ReferenceDataSchema.parse({
  platform: "meta",
  brand: "Example",
  headlines: [],
  bodies: [],
  transcriptSegments: [],
  media: [],
  observations: [],
});
afterEach(async () => {
  for (const store of resources.values()) {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
  resources.clear();
});
async function setup() {
  const store = new JobStore(await mkdtemp(join(tmpdir(), "studio-sources-")));
  resources.set(store.root, store);
  const library = new ProjectStore(store.db);
  const project = library.createProject({ name: "Project Alpha", description: "" });
  return { store, library, project, app: createApp(store) };
}
function request(path: string, body: unknown, method = "POST") {
  return new Request(`${origin}/api${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function eventProjects(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  const event = new TextDecoder().decode(chunk.value);
  expect(event).toContain("event: state");
  const data = z.string().parse(/^data: (.+)$/m.exec(event)?.[1]);
  return ProjectsSchema.parse(JSON.parse(data)).projects;
}

test("creates a project when a valid same-origin request supplies its identity", async () => {
  // Given
  const { app } = await setup();
  // When
  const response = await app.request(request("/projects", { name: "Project Beta" }));
  // Then
  expect(response.status).toBe(201);
  expect(ProjectSchema.parse(await response.json()).name).toBe("Project Beta");
});

test("restores projects, sources and revision history when the database reopens", async () => {
  // Given
  const { store, library, project } = await setup();
  const first = library.addSource(project.id, fact);
  const revised = library.updateSource(project.id, first.id, {
    ...fact,
    content: "Capacity: 750 ml.",
  });
  store.close();
  // When
  const reopened = new JobStore(store.root);
  resources.set(store.root, reopened);
  const restored = new ProjectStore(reopened.db);
  // Then
  expect(restored.getProject(project.id)).toMatchObject({ name: "Project Alpha", revision: 3 });
  expect(restored.listSources(project.id)).toEqual([revised]);
  const rows = z
    .array(z.object({ body: z.string() }))
    .parse(
      reopened.db
        .query("SELECT body FROM project_source_revisions WHERE source_id = ? ORDER BY revision")
        .all(first.id),
    );
  expect(rows.map((row) => ProjectSourceSchema.parse(JSON.parse(row.body)).content)).toEqual([
    "Capacity: 500 ml.",
    "Capacity: 750 ml.",
  ]);
});

test("returns only the requested project's sources when reading its detail", async () => {
  // Given
  const { app, library, project } = await setup();
  library.addSource(project.id, fact);
  const other = library.createProject({ name: "Other project", description: "" });
  // When
  const response = await app.request(`${origin}/api/projects/${other.id}`);
  // Then
  expect(ProjectDetailSchema.parse(await response.json()).sources).toEqual([]);
});

test("returns 404 when a source is updated through another project", async () => {
  // Given
  const { app, library, project } = await setup();
  const source = library.addSource(project.id, fact);
  const other = library.createProject({ name: "Other project", description: "" });
  // When
  const response = await app.request(
    request(`/projects/${other.id}/sources/${source.id}`, fact, "PUT"),
  );
  // Then
  expect(response.status).toBe(404);
  expect(library.getSource(project.id, source.id)).toEqual(source);
});

test("keeps URL-only input as metadata when a source is added without fetching it", async () => {
  // Given
  const { app, project } = await setup();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.error());
  try {
    // When
    const response = await app.request(
      request(`/projects/${project.id}/sources`, {
        kind: "reference",
        title: "Ad URL",
        url: "https://example.invalid/ad/7",
      }),
    );
    // Then
    expect(response.status).toBe(201);
    expect(ProjectSourceSchema.parse(await response.json())).toMatchObject({
      content: "",
      contentStatus: "metadata_only",
    });
    expect(fetch).toHaveBeenCalledTimes(0);
  } finally {
    fetch.mockRestore();
  }
});

test("stores product detail image files on a product source", async () => {
  // Given
  const { app, library, project } = await setup();
  const source = library.addSource(project.id, fact);
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3,
    253, 160, 130, 104, 39, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const body = new FormData();
  body.append("files", new File([png], "detail.png", { type: "image/png" }));
  // When
  const uploaded = await app.request(
    `${origin}/api/projects/${project.id}/sources/${source.id}/files`,
    {
      method: "POST",
      headers: { Origin: origin },
      body,
    },
  );
  const listed = await app.request(
    `${origin}/api/projects/${project.id}/sources/${source.id}/files`,
  );
  // Then
  expect(uploaded.status).toBe(201);
  const files = SourceFilesSchema.parse(await listed.json()).files;
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ filename: "detail.png", contentType: "image/png" });
  const opened = await app.request(
    `${origin}/api/projects/${project.id}/sources/${source.id}/files/${files[0]?.id}`,
  );
  expect(opened.status).toBe(200);
  expect(opened.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await opened.arrayBuffer())).toEqual(png);
});

test("retains hypotheses and references while separating factual eligibility", async () => {
  // Given
  const { library, project } = await setup();
  const evidence = library.addSource(project.id, fact);
  const offer = library.addSource(project.id, { ...fact, kind: "offer" });
  library.addSource(project.id, { ...fact, evidence: "hypothesis" });
  library.addSource(project.id, { ...fact, kind: "review" });
  library.addSource(project.id, { ...fact, kind: "reference", referenceData });
  library.addSource(project.id, { ...fact, content: "", url: "https://example.invalid/product" });
  // When
  const snapshot = library.snapshot(project.id);
  // Then
  expect(snapshot.sources).toHaveLength(6);
  expect(factualSources(snapshot).map((source) => source.id)).toEqual([evidence.id, offer.id]);
});

test("excludes expired and inactive sources when capturing a snapshot", async () => {
  // Given
  const { library, project } = await setup();
  const eligible = library.addSource(project.id, fact);
  library.addSource(project.id, { ...fact, expiresAt: "2000-01-01T00:00:00.000Z" });
  library.addSource(project.id, { ...fact, status: "inactive" });
  // When
  const snapshot = library.snapshot(project.id);
  // Then
  expect(snapshot.sources).toEqual([eligible]);
});

test("preserves a detached snapshot when the source changes afterward", async () => {
  // Given
  const { library, project } = await setup();
  const source = library.addSource(project.id, { ...fact, kind: "reference", referenceData });
  const frozen = library.snapshot(project.id);
  const original = structuredClone(frozen);
  // When
  library.updateSource(project.id, source.id, {
    ...fact,
    kind: "reference",
    referenceData: { ...referenceData, headlines: ["Updated"] },
  });
  // Then
  expect(frozen).toEqual(original);
  expect(library.snapshot(project.id).digest).not.toBe(frozen.digest);
});

test("deduplicates unchanged imports when their external identity belongs to the same project", async () => {
  // Given
  const { app, library, project } = await setup();
  const item = { ...fact, provenance: { ...fact.provenance, externalId: "remote-7" } };
  const existing = library.addSource(project.id, item);
  const before = library.getProject(project.id).revision;
  // When
  const response = await app.request(request(`/projects/${project.id}/import`, { items: [item] }));
  // Then
  expect(SourceImportResultSchema.parse(await response.json()).sources).toEqual([existing]);
  expect(library.getProject(project.id).revision).toBe(before);
});

test("increments source revision when an imported external identity has changed content", async () => {
  // Given
  const { library, project } = await setup();
  const item = { ...fact, provenance: { ...fact.provenance, externalId: "remote-7" } };
  const existing = library.addSource(project.id, item);
  // When
  const [updated] = library.importSources(project.id, [{ ...item, content: "Capacity: 750 ml." }]);
  // Then
  expect(updated).toMatchObject({ id: existing.id, revision: 2, content: "Capacity: 750 ml." });
  expect(updated?.digest).not.toBe(existing.digest);
});

test("creates a distinct source when another project imports the same external identity", async () => {
  // Given
  const { library, project } = await setup();
  const item = { ...fact, provenance: { ...fact.provenance, externalId: "remote-7" } };
  const existing = library.addSource(project.id, item);
  const other = library.createProject({ name: "Other project", description: "" });
  // When
  const [imported] = library.importSources(other.id, [item]);
  // Then
  expect(imported).toMatchObject({ projectId: other.id, revision: 1 });
  expect(imported?.id).not.toBe(existing.id);
});

test.each([
  { ...fact, extra: true },
  { ...fact, content: "", url: null },
  { ...fact, url: "file:///private" },
  { ...fact, url: "https://user:secret@example.invalid" },
  { ...fact, expiresAt: "yesterday" },
  { ...fact, provenance: { ...fact.provenance, extra: true } },
  { ...fact, referenceData },
  { ...fact, provenance: { ...fact.provenance, origin: "success_ai" } },
  { ...fact, kind: "reference", referenceData: { ...referenceData, extra: true } },
  {
    ...fact,
    kind: "reference",
    referenceData: {
      ...referenceData,
      observations: [{ name: "roas", value: 8, observedAt: null, source: "meta_ad_library" }],
    },
  },
])("rejects malformed or extra source data when submitted: %j", async (body) => {
  // Given
  const { app, project } = await setup();
  // When
  const response = await app.request(request(`/projects/${project.id}/sources`, body));
  // Then
  expect(response.status).toBe(400);
});

test.each([{ items: [] }, { items: [fact], extra: true }, { items: [fact], schemaVersion: 2 }])(
  "rejects malformed import envelopes when submitted: %j",
  async (body) => {
    // Given
    const { app, project } = await setup();
    // When
    const response = await app.request(request(`/projects/${project.id}/import`, body));
    // Then
    expect(response.status).toBe(400);
  },
);

test("publishes a new project revision over SSE when a source is added", async () => {
  // Given
  const { app, project } = await setup();
  const events = await app.request(`${origin}/api/events`);
  const reader = events.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  try {
    expect(await eventProjects(reader)).toEqual([project]);
    // When
    const response = await app.request(request(`/projects/${project.id}/sources`, fact));
    // Then
    expect(response.status).toBe(201);
    expect(await eventProjects(reader)).toMatchObject([{ id: project.id, revision: 2 }]);
  } finally {
    await reader.cancel();
  }
});
