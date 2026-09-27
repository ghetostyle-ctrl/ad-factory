import { Hono } from "hono";
import { validator } from "hono-openapi";
import { UpdateProductionAssetSchema } from "../shared/production-assets";
import { buildProductionManifest } from "../shared/production-manifest";
import { StudioError } from "./errors";
import { ProductionAssets } from "./production-assets";
import { captureProductionSources } from "./production-snapshot";
import type { ProjectStore } from "./project-store";

export function productionAssetRoutes(library: ProjectStore, root: string): Hono {
  const routes = new Hono();
  const assets = new ProductionAssets(library, root);
  routes.get("/:id/production-assets", (c) => c.json({ assets: assets.list(c.req.param("id")) }));
  routes.post("/:id/production-assets", async (c) => {
    library.getProject(c.req.param("id"));
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (cause) {
      if (cause instanceof Error)
        throw new StudioError(
          "production_asset_upload",
          "올바른 파일 업로드 요청을 보내세요.",
          400,
        );
      throw cause;
    }
    const files = form.getAll("file");
    const file = files[0];
    if (
      files.length !== 1 ||
      !(file instanceof File) ||
      [...form.keys()].some((key) => key !== "file")
    )
      throw new StudioError("production_asset_upload", "file 필드에 영상 한 개를 선택하세요.", 400);
    return c.json(await assets.add(c.req.param("id"), file), 201);
  });
  routes.put(
    "/:id/production-assets/:assetId",
    validator("json", UpdateProductionAssetSchema),
    (c) => c.json(assets.update(c.req.param("id"), c.req.param("assetId"), c.req.valid("json"))),
  );
  routes.delete("/:id/production-assets/:assetId", (c) => {
    assets.remove(c.req.param("id"), c.req.param("assetId"));
    return c.json({ ok: true });
  });
  routes.get("/:id/production-assets/:assetId/file", async (c) => {
    const stored = assets.file(c.req.param("id"), c.req.param("assetId"));
    const file = Bun.file(stored.path);
    if (!(await file.exists()))
      throw new StudioError(
        "production_asset_file_missing",
        "영상 원본 파일을 찾을 수 없습니다.",
        404,
      );
    const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
    const headers = new Headers({
      "Content-Type": stored.asset.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${disposition}; filename="video"; filename*=UTF-8''${encodeURIComponent(stored.asset.filename)}`,
    });
    const range = c.req.header("Range");
    if (!range) {
      headers.set("Content-Length", String(file.size));
      return new Response(file, { headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const first = match?.[1] ?? "";
    const last = match?.[2] ?? "";
    const suffix = first === "";
    const start = suffix ? Math.max(0, file.size - Number(last)) : Number(first);
    const end = suffix || last === "" ? file.size - 1 : Math.min(Number(last), file.size - 1);
    const valid =
      match &&
      (first !== "" || last !== "") &&
      Number.isSafeInteger(Number(first)) &&
      Number.isSafeInteger(Number(last)) &&
      start < file.size &&
      start <= end &&
      (!suffix || Number(last) > 0);
    if (!valid) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  });
  routes.get("/:id/production-plan", (c) => {
    const manifest = buildProductionManifest(
      captureProductionSources(library, root, c.req.param("id")),
    );
    c.header("Content-Disposition", 'attachment; filename="production-plan.json"');
    return c.json(manifest);
  });
  return routes;
}
