import { Hono } from "hono";
import { validator } from "hono-openapi";
import { SourceUrlPreviewRequestSchema } from "../shared/source-url-preview";
import {
  CreateProjectSchema,
  CreateSourceSchema,
  ImportSourcesSchema,
  SuccessAiPreviewSchema,
} from "../shared/sources";
import { MediaAnalyzer } from "./media-analysis";
import { productionAssetRoutes } from "./production-asset-routes";
import { ProjectMedia } from "./project-media";
import type { ProjectStore } from "./project-store";
import { SourceFiles } from "./source-files";
import { previewSourceImage } from "./source-image-preview";
import { previewSourceUrl } from "./source-url-preview";
import { previewSuccessAi } from "./success-ai";

export function projectRoutes(library: ProjectStore, root: string): Hono {
  const routes = new Hono();
  const media = new ProjectMedia(library.db, root, library.onChange);
  const analyzer = new MediaAnalyzer(library.db, root, media, library.onChange);
  const sourceFiles = new SourceFiles(library.db, root);
  routes.route("/", productionAssetRoutes(library, root));
  routes.get("/", (c) => c.json({ projects: library.listProjects() }));
  routes.post("/", validator("json", CreateProjectSchema), (c) =>
    c.json(library.createProject(c.req.valid("json")), 201),
  );
  routes.get("/:id", (c) =>
    c.json({
      project: library.getProject(c.req.param("id")),
      sources: library.listSources(c.req.param("id")),
    }),
  );
  routes.put("/:id", validator("json", CreateProjectSchema), (c) =>
    c.json(library.updateProject(c.req.param("id"), c.req.valid("json"))),
  );
  routes.post(
    "/:id/source-url-preview",
    validator("json", SourceUrlPreviewRequestSchema),
    async (c) => {
      library.getProject(c.req.param("id"));
      return c.json(await previewSourceUrl(c.req.valid("json").url));
    },
  );
  routes.post("/:id/source-image-preview", async (c) => {
    library.getProject(c.req.param("id"));
    const body = await c.req.parseBody();
    const { file } = body;
    if (!(file instanceof File))
      return c.json({ error: "읽을 상세페이지 이미지를 선택해 주세요." }, 400);
    return c.json(await previewSourceImage(file, root, c.req.param("id")));
  });
  routes.post("/:id/sources", validator("json", CreateSourceSchema), (c) =>
    c.json(library.addSource(c.req.param("id"), c.req.valid("json")), 201),
  );
  routes.put("/:id/sources/:sourceId", validator("json", CreateSourceSchema), (c) =>
    c.json(library.updateSource(c.req.param("id"), c.req.param("sourceId"), c.req.valid("json"))),
  );
  routes.delete("/:id/sources/:sourceId", (c) =>
    c.json(library.deactivateSource(c.req.param("id"), c.req.param("sourceId"))),
  );
  routes.get("/:id/sources/:sourceId/files", (c) => {
    library.getSource(c.req.param("id"), c.req.param("sourceId"));
    return c.json({ files: sourceFiles.list(c.req.param("id"), c.req.param("sourceId")) });
  });
  routes.post("/:id/sources/:sourceId/files", async (c) => {
    const source = library.getSource(c.req.param("id"), c.req.param("sourceId"));
    const body = await c.req.parseBody({ all: true });
    const { files: rawFiles } = body;
    const entries = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
    const files = entries.filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) return c.json({ error: "첨부할 이미지 파일을 선택하세요." }, 400);
    const saved = [];
    for (const file of files) saved.push(await sourceFiles.add(c.req.param("id"), source, file));
    library.onChange();
    return c.json({ files: saved }, 201);
  });
  routes.get("/:id/sources/:sourceId/files/:fileId", (c) => {
    library.getSource(c.req.param("id"), c.req.param("sourceId"));
    const stored = sourceFiles.file(
      c.req.param("id"),
      c.req.param("sourceId"),
      c.req.param("fileId"),
    );
    return new Response(Bun.file(stored.path), {
      headers: {
        "Content-Type": stored.file.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  routes.post("/:id/import", validator("json", ImportSourcesSchema), (c) => {
    const sources = library.importSources(c.req.param("id"), c.req.valid("json").items);
    media.enqueue(c.req.param("id"), sources);
    return c.json({ sources });
  });
  routes.get("/:id/sources/:sourceId/media", (c) => {
    const source = library.getSource(c.req.param("id"), c.req.param("sourceId"));
    return c.json({ assets: media.list(c.req.param("id"), source) });
  });
  routes.get("/:id/sources/:sourceId/media/:assetId", (c) => {
    library.getSource(c.req.param("id"), c.req.param("sourceId"));
    const file = media.file(c.req.param("id"), c.req.param("sourceId"), c.req.param("assetId"));
    return new Response(Bun.file(file.path), {
      headers: {
        "Content-Type": file.asset.contentType ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  routes.get("/:id/sources/:sourceId/media/:assetId/analysis", (c) => {
    const source = library.getSource(c.req.param("id"), c.req.param("sourceId"));
    media.file(c.req.param("id"), source.id, c.req.param("assetId"));
    return c.json(analyzer.get(c.req.param("assetId")));
  });
  routes.post("/:id/sources/:sourceId/media/:assetId/analysis", (c) => {
    const source = library.getSource(c.req.param("id"), c.req.param("sourceId"));
    return c.json(analyzer.start(c.req.param("id"), source, c.req.param("assetId")), 202);
  });
  routes.post("/:id/success-ai-preview", validator("json", SuccessAiPreviewSchema), async (c) => {
    library.getProject(c.req.param("id"));
    return c.json(await previewSuccessAi(c.req.valid("json")));
  });
  return routes;
}
