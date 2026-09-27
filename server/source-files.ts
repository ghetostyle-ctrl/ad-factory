import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { type SourceFile, SourceFileSchema } from "../shared/source-files";
import type { ProjectSource } from "../shared/sources";
import { StudioError } from "./errors";

const rowSchema = z.object({ body: z.string(), file_path: z.string().nullable() });
const maxBytes = 25 * 1024 * 1024;
const allowedTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export class SourceFiles {
  constructor(
    readonly db: Database,
    readonly root: string,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS project_source_files (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
      body TEXT NOT NULL, file_path TEXT NOT NULL)`);
  }

  list(projectId: string, sourceId: string): SourceFile[] {
    return this.db
      .query("SELECT body FROM project_source_files WHERE project_id = ? AND source_id = ?")
      .all(projectId, sourceId)
      .map((row) =>
        SourceFileSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)),
      );
  }

  file(projectId: string, sourceId: string, fileId: string) {
    const row = this.db
      .query(
        "SELECT body, file_path FROM project_source_files WHERE id = ? AND project_id = ? AND source_id = ?",
      )
      .get(fileId, projectId, sourceId);
    if (!row) throw new StudioError("source_file_missing", "첨부 파일을 찾지 못했습니다.", 404);
    const parsed = rowSchema.parse(row);
    const file = SourceFileSchema.parse(JSON.parse(parsed.body));
    if (!parsed.file_path)
      throw new StudioError("source_file_missing", "첨부 파일 경로를 찾지 못했습니다.", 404);
    return { file, path: parsed.file_path };
  }

  async add(projectId: string, source: ProjectSource, upload: File): Promise<SourceFile> {
    if (source.kind !== "product_fact" && source.kind !== "offer")
      throw new StudioError(
        "source_file_kind",
        "상품 정보와 가격·혜택 자료에만 파일을 첨부할 수 있습니다.",
        400,
      );
    const contentType = upload.type.split(";")[0]?.trim().toLowerCase() ?? "";
    const extension = allowedTypes[contentType];
    if (!extension)
      throw new StudioError("source_file_type", "이미지 파일은 jpg, png, webp만 지원합니다.", 400);
    if (upload.size <= 0 || upload.size > maxBytes)
      throw new StudioError(
        "source_file_size",
        "이미지 파일은 25MB 이하만 첨부할 수 있습니다.",
        413,
      );
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = createHash("sha256")
      .update(`${projectId}\0${source.id}\0${upload.name}\0${sha256}`)
      .digest("hex");
    const existing = this.db.query("SELECT body FROM project_source_files WHERE id = ?").get(id);
    if (existing)
      return SourceFileSchema.parse(
        JSON.parse(z.object({ body: z.string() }).parse(existing).body),
      );
    const directory = join(this.root, "source-files", projectId, source.id);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${id}.${extension}`);
    const temporary = `${destination}.${crypto.randomUUID()}.partial`;
    try {
      await Bun.write(temporary, bytes);
      await rename(temporary, destination);
    } catch (cause) {
      await rm(temporary, { force: true });
      throw cause;
    }
    const filename = safeName(upload.name || `product-image.${extension}`);
    const file: SourceFile = {
      id,
      sourceId: source.id,
      kind: "image",
      filename,
      contentType,
      bytes: upload.size,
      sha256,
      createdAt: new Date().toISOString(),
    };
    this.db
      .query(
        "INSERT INTO project_source_files (id, project_id, source_id, body, file_path) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, projectId, source.id, JSON.stringify(file), destination);
    return file;
  }
}

function safeName(name: string): string {
  const fallback = `product-image${extname(name) || ".jpg"}`;
  const cleaned = Array.from(name)
    .map((character) => (isUnsafeFilenameCharacter(character) ? "_" : character))
    .join("")
    .trim();
  return cleaned || fallback;
}

function isUnsafeFilenameCharacter(character: string): boolean {
  return character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character);
}
