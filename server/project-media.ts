import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type MediaAsset, MediaAssetSchema } from "../shared/media-assets";
import { type ProjectSource, SuccessAiExportSchema } from "../shared/sources";
import { StudioError } from "./errors";

const rowSchema = z.object({ body: z.string(), file_path: z.string().nullable() });
const maxBytes = 200 * 1024 * 1024;
const mimeExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export class ProjectMedia {
  private queue = Promise.resolve();

  constructor(
    readonly db: Database,
    readonly root: string,
    readonly onChange: () => void,
    readonly transport: typeof fetch = fetch,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS project_media (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
      body TEXT NOT NULL, file_path TEXT)`);
    const pending = db.query("SELECT id, body FROM project_media").all();
    for (const row of pending) {
      const parsed = z.object({ id: z.string(), body: z.string() }).parse(row);
      const asset = MediaAssetSchema.parse(JSON.parse(parsed.body));
      if (asset.status === "pending")
        db.query("UPDATE project_media SET body = ? WHERE id = ?").run(
          JSON.stringify({
            ...asset,
            status: "error",
            error: "서버 재시작으로 다운로드가 중단됐습니다.",
          }),
          parsed.id,
        );
    }
  }

  list(projectId: string, source: ProjectSource): MediaAsset[] {
    const current = new Set(
      source.referenceData?.media
        .filter((media) => media.kind === "image" || media.kind === "video")
        .map((media) => media.url) ?? [],
    );
    return this.db
      .query("SELECT body FROM project_media WHERE project_id = ? AND source_id = ?")
      .all(projectId, source.id)
      .map((row) =>
        MediaAssetSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)),
      )
      .filter((asset) => current.has(asset.sourceUrl));
  }

  file(projectId: string, sourceId: string, assetId: string) {
    const row = this.db
      .query(
        "SELECT body, file_path FROM project_media WHERE id = ? AND project_id = ? AND source_id = ?",
      )
      .get(assetId, projectId, sourceId);
    if (!row) throw new StudioError("media_missing", "미디어 파일을 찾지 못했습니다.", 404);
    const parsed = rowSchema.parse(row);
    const asset = MediaAssetSchema.parse(JSON.parse(parsed.body));
    if (asset.status !== "ready" || !parsed.file_path)
      throw new StudioError("media_unavailable", "미디어 다운로드가 완료되지 않았습니다.", 409);
    return { asset, path: parsed.file_path };
  }

  enqueue(projectId: string, sources: readonly ProjectSource[]) {
    for (const source of sources) {
      if (source.provenance.origin !== "success_ai" || !source.referenceData) continue;
      for (const media of source.referenceData.media) {
        if (media.kind !== "image" && media.kind !== "video") continue;
        const id = createHash("sha256")
          .update(`${projectId}\0${source.id}\0${media.kind}\0${media.url}`)
          .digest("hex");
        if (this.db.query("SELECT id FROM project_media WHERE id = ?").get(id)) continue;
        const asset: MediaAsset = {
          id,
          sourceId: source.id,
          kind: media.kind,
          sourceUrl: media.url,
          status: "pending",
          contentType: null,
          bytes: null,
          sha256: null,
          error: null,
        };
        this.db
          .query(
            "INSERT INTO project_media (id, project_id, source_id, body, file_path) VALUES (?, ?, ?, ?, NULL)",
          )
          .run(id, projectId, source.id, JSON.stringify(asset));
        this.queue = this.queue.then(() => this.download(projectId, source, asset)).catch(() => {});
      }
    }
    this.onChange();
  }

  private async download(projectId: string, source: ProjectSource, asset: MediaAsset) {
    let temporary: string | null = null;
    try {
      const platform = source.referenceData?.platform;
      const identity = source.provenance.externalId?.split(":")[1];
      if (!platform || !identity || !/^[A-Za-z0-9_-]{1,128}$/.test(identity))
        throw new Error("원본 광고 식별자가 없습니다.");
      const verification = new URL("http://localhost:3000/api/references/export");
      verification.searchParams.set("platform", platform);
      verification.searchParams.set("ids", identity);
      const stored = await this.transport(verification, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!stored.ok) throw new Error("Success AI의 원본 광고를 확인하지 못했습니다.");
      const exported = SuccessAiExportSchema.parse(await stored.json());
      if (
        !exported.items[0]?.referenceData?.media.some(
          (media) => media.kind === asset.kind && media.url === asset.sourceUrl,
        )
      )
        throw new Error("선택한 미디어 주소가 Success AI의 저장 자료와 다릅니다.");
      let endpoint: URL;
      if (platform === "google" && asset.kind === "video") {
        const video = new URL(asset.sourceUrl);
        const youtubeId = video.hostname === "www.youtube.com" ? video.searchParams.get("v") : null;
        if (!youtubeId || !/^[A-Za-z0-9_-]{11}$/.test(youtubeId))
          throw new Error("유튜브 영상 식별자가 올바르지 않습니다.");
        endpoint = new URL(`http://localhost:3000/api/download?youtubeId=${youtubeId}`);
      } else {
        endpoint = new URL("http://localhost:3000/api/references/media");
        endpoint.searchParams.set("platform", platform);
        endpoint.searchParams.set("id", identity);
        endpoint.searchParams.set("kind", asset.kind);
      }
      const response = await this.transport(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok || !response.body)
        throw new Error("Success AI가 원본 파일을 제공하지 못했습니다.");
      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const extension = mimeExtensions[contentType];
      if (!extension || !contentType.startsWith(`${asset.kind}/`))
        throw new Error("미디어 파일 형식이 일치하지 않습니다.");
      const directory = join(this.root, "reference-media", projectId, source.id);
      await mkdir(directory, { recursive: true });
      const destination = join(directory, `${asset.id}.${extension}`);
      temporary = `${destination}.${crypto.randomUUID()}.partial`;
      const writer = Bun.file(temporary).writer();
      const hash = createHash("sha256");
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxBytes) throw new Error("미디어 파일이 200MB 제한을 넘었습니다.");
          hash.update(next.value);
          await writer.write(next.value);
        }
      } finally {
        await writer.end();
        reader.releaseLock();
      }
      if (bytes === 0) throw new Error("빈 미디어 파일입니다.");
      await rename(temporary, destination);
      temporary = null;
      const ready: MediaAsset = {
        ...asset,
        status: "ready",
        contentType,
        bytes,
        sha256: hash.digest("hex"),
        error: null,
      };
      this.db
        .query("UPDATE project_media SET body = ?, file_path = ? WHERE id = ?")
        .run(JSON.stringify(ready), destination, asset.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "파일을 가져오지 못했습니다.";
      this.db
        .query("UPDATE project_media SET body = ? WHERE id = ?")
        .run(JSON.stringify({ ...asset, status: "error", error: message }), asset.id);
    } finally {
      if (temporary) await rm(temporary, { force: true });
      this.onChange();
    }
  }
}
