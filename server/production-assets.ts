import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  PRODUCTION_ASSET_MAX_BYTES,
  type ProductionAsset,
  ProductionAssetIdSchema,
  ProductionAssetSchema,
  ProductionAssetSettingsSchema,
  type UpdateProductionAsset,
} from "../shared/production-assets";
import { StudioError } from "./errors";
import { probeProductionVideo } from "./production-video-probe";
import type { ProjectStore } from "./project-store";

const RowSchema = z.object({ body: z.string(), file_path: z.string() });
const types: Readonly<Record<string, ProductionAsset["contentType"]>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export class ProductionAssets {
  constructor(
    readonly library: ProjectStore,
    readonly root: string,
  ) {
    library.db.run(`CREATE TABLE IF NOT EXISTS project_production_assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL, file_path TEXT NOT NULL)`);
  }

  list(projectId: string): ProductionAsset[] {
    const project = this.library.getProject(projectId);
    return this.library.db
      .query(
        "SELECT body, file_path FROM project_production_assets WHERE project_id = ? AND active = 1 ORDER BY rowid",
      )
      .all(project.id)
      .map((row) => ProductionAssetSchema.parse(JSON.parse(RowSchema.parse(row).body)));
  }

  get(projectId: string, assetId: string): ProductionAsset {
    return this.read(projectId, assetId, true).asset;
  }

  file(projectId: string, assetId: string) {
    return this.read(projectId, assetId, false);
  }

  private read(projectId: string, assetId: string, active: boolean) {
    const project = this.library.getProject(projectId);
    const id = ProductionAssetIdSchema.parse(assetId);
    const row = this.library.db
      .query(`SELECT body, file_path FROM project_production_assets
      WHERE project_id = ? AND id = ? ${active ? "AND active = 1" : ""}`)
      .get(project.id, id);
    if (!row)
      throw new StudioError(
        "production_asset_missing",
        "이 프로젝트의 제작 영상을 찾을 수 없습니다.",
        404,
      );
    const parsed = RowSchema.parse(row);
    return { asset: ProductionAssetSchema.parse(JSON.parse(parsed.body)), path: parsed.file_path };
  }

  async add(projectId: string, upload: File): Promise<ProductionAsset> {
    const project = this.library.getProject(projectId);
    this.ensureCapacity(project.id);
    if (upload.size <= 0)
      throw new StudioError("production_asset_empty", "내용이 있는 영상 파일을 선택하세요.", 400);
    if (upload.size > PRODUCTION_ASSET_MAX_BYTES)
      throw new StudioError("production_asset_size", "영상 파일은 200MiB 이하여야 합니다.", 413);
    const extension = extname(upload.name).slice(1).toLowerCase();
    const contentType = Object.hasOwn(types, extension) ? types[extension] : undefined;
    const declaredType = upload.type.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      !contentType ||
      (declaredType && declaredType !== "application/octet-stream" && declaredType !== contentType)
    )
      throw new StudioError(
        "production_asset_type",
        "MP4, MOV, WebM 영상 파일만 업로드할 수 있습니다.",
        400,
      );
    const id = ProductionAssetIdSchema.parse(crypto.randomUUID());
    const directory = join(this.root, "production-assets", project.id);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${id}.${extension}`);
    const temporary = `${destination}.partial`;
    let committed = false;
    try {
      await Bun.write(temporary, upload);
      const measured = await probeProductionVideo(temporary, extension);
      const hash = createHash("sha256");
      const reader = Bun.file(temporary).stream().getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          hash.update(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const filename =
        Array.from(upload.name)
          .map((character) =>
            character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character,
          )
          .join("")
          .trim()
          .replace(/\.+$/, "")
          .slice(0, 240)
          .toWellFormed() || `video.${extension}`;
      const now = new Date().toISOString();
      const asset: ProductionAsset = {
        id,
        projectId: project.id,
        title: filename,
        filename,
        contentType,
        bytes: upload.size,
        sha256: hash.digest("hex"),
        ...measured,
        createdAt: now,
        updatedAt: now,
        settings: ProductionAssetSettingsSchema.parse({}),
      };
      await rename(temporary, destination);
      this.library.db.transaction(() => {
        this.ensureCapacity(project.id);
        this.library.db
          .query(
            "INSERT INTO project_production_assets (id, project_id, body, file_path) VALUES (?, ?, ?, ?)",
          )
          .run(id, project.id, JSON.stringify(asset), destination);
        this.touchProject(project.id);
      })();
      committed = true;
      return asset;
    } finally {
      await rm(temporary, { force: true });
      if (!committed) await rm(destination, { force: true });
    }
  }

  update(projectId: string, assetId: string, input: UpdateProductionAsset): ProductionAsset {
    const asset = this.get(projectId, assetId);
    const { startSec, endSec } = input.settings;
    if (startSec >= asset.durationSec || (endSec !== null && endSec > asset.durationSec))
      throw new StudioError(
        "production_asset_range",
        "사용 구간은 영상 길이 안에서 설정하세요.",
        400,
      );
    const updated = { ...asset, ...input, updatedAt: new Date().toISOString() };
    this.library.db.transaction(() => {
      this.library.db
        .query("UPDATE project_production_assets SET body = ? WHERE id = ? AND project_id = ?")
        .run(JSON.stringify(updated), asset.id, asset.projectId);
      this.touchProject(asset.projectId);
    })();
    return updated;
  }

  remove(projectId: string, assetId: string): void {
    const asset = this.get(projectId, assetId);
    this.library.db.transaction(() => {
      this.library.db
        .query("UPDATE project_production_assets SET active = 0 WHERE id = ? AND project_id = ?")
        .run(asset.id, asset.projectId);
      this.touchProject(asset.projectId);
    })();
  }

  private ensureCapacity(projectId: string): void {
    const row = this.library.db
      .query(
        "SELECT COUNT(*) AS count FROM project_production_assets WHERE project_id = ? AND active = 1",
      )
      .get(projectId);
    if (z.object({ count: z.number() }).parse(row).count >= 100)
      throw new StudioError(
        "production_asset_limit",
        "제작 영상은 프로젝트당 100개까지 보관할 수 있습니다.",
        400,
      );
  }

  private touchProject(projectId: string): void {
    const project = this.library.getProject(projectId);
    this.library.updateProject(project.id, {
      name: project.name,
      description: project.description,
    });
  }
}
