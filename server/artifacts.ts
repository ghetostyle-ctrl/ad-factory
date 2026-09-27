import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ArtifactModel } from "../shared/models";
import { type AgentId, type Artifact, JobIdSchema } from "../shared/schema";
import { StudioError } from "./errors";
import type { JobStore } from "./store";

export class Artifacts {
  constructor(readonly store: JobStore) {}
  path(jobId: string, name: string): string {
    JobIdSchema.parse(jobId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(name))
      throw new StudioError("path", "잘못된 파일 경로입니다.", 400);
    const root = resolve(this.store.root, "artifacts", jobId);
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) throw new StudioError("path", "잘못된 파일 경로입니다.", 400);
    return path;
  }
  async save(
    jobId: string,
    asset: {
      readonly name: string;
      readonly kind: Artifact["kind"];
      readonly agentId: AgentId;
      readonly content: string | Uint8Array;
      readonly model?: ArtifactModel;
    },
  ): Promise<Artifact> {
    const path = this.path(jobId, asset.name);
    await mkdir(join(this.store.root, "artifacts", jobId), { recursive: true });
    await Bun.write(path, asset.content);
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      name: asset.name,
      kind: asset.kind,
      agentId: asset.agentId,
      url: `/api/artifacts/${jobId}/${asset.name}`,
      model: asset.model ?? null,
    };
    this.store.change(jobId, (job) => {
      job.artifacts.push(artifact);
    });
    return artifact;
  }
  async read(jobId: string, name: string): Promise<ReturnType<typeof Bun.file>> {
    const job = this.store.get(jobId);
    if (!job.artifacts.some((asset) => asset.name === name))
      throw new StudioError("artifact", "산출물을 찾을 수 없습니다.", 404);
    const path = this.path(jobId, name);
    const actual = await realpath(path);
    const root = await realpath(join(this.store.root, "artifacts", jobId));
    if (!actual.startsWith(root + sep))
      throw new StudioError("path", "산출물 경로가 허용 범위를 벗어났습니다.", 403);
    return Bun.file(actual);
  }
  async upload(jobId: string, file: File): Promise<void> {
    if (file.size > 15 * 1024 * 1024)
      throw new StudioError("size", "이미지는 15MB 이하여야 합니다.", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const png = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg)
      throw new StudioError("format", "PNG 또는 JPEG 이미지 파일만 지원합니다.", 400);
    await this.save(jobId, {
      name: `uploaded-${Date.now()}.${png ? "png" : "jpg"}`,
      kind: "image",
      agentId: "production",
      content: bytes,
    });
    this.store.agent(jobId, "production", {
      status: "completed",
      action: "사용자가 업로드한 실제 이미지가 저장되었습니다.",
    });
  }
}
