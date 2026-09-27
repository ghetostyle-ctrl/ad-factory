import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type CreateProject,
  type CreateSource,
  type Project,
  ProjectIdSchema,
  ProjectSchema,
  type ProjectSource,
  ProjectSourceSchema,
  type ProjectSourceSnapshot,
  SourceIdSchema,
} from "../shared/sources";
import { StudioError } from "./errors";

const RowSchema = z.object({ body: z.string() });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ProjectStore {
  constructor(
    readonly db: Database,
    readonly onChange: () => void = () => {},
  ) {
    db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS project_sources (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, origin TEXT NOT NULL,
      external_id TEXT, body TEXT NOT NULL,
      UNIQUE(project_id, origin, external_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS project_source_revisions (
      source_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(source_id, revision))`);
  }
  listProjects(): Project[] {
    return this.db
      .query("SELECT body FROM projects ORDER BY rowid DESC")
      .all()
      .map((row) => ProjectSchema.parse(JSON.parse(RowSchema.parse(row).body)));
  }
  getProject(id: string): Project {
    const row = this.db
      .query("SELECT body FROM projects WHERE id = ?")
      .get(ProjectIdSchema.parse(id));
    if (!row) throw new StudioError("project_not_found", "프로젝트를 찾을 수 없습니다.", 404);
    return ProjectSchema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  createProject(input: CreateProject): Project {
    const now = new Date().toISOString();
    const project: Project = {
      ...input,
      id: ProjectIdSchema.parse(crypto.randomUUID()),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.saveProject(project);
    this.onChange();
    return project;
  }
  updateProject(id: string, input: CreateProject): Project {
    const project = this.getProject(id);
    const updated = {
      ...project,
      ...input,
      revision: project.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.saveProject(updated);
    this.onChange();
    return updated;
  }
  listSources(projectId: string): ProjectSource[] {
    const project = this.getProject(projectId);
    return this.db
      .query("SELECT body FROM project_sources WHERE project_id = ? ORDER BY rowid")
      .all(project.id)
      .map((row) => ProjectSourceSchema.parse(JSON.parse(RowSchema.parse(row).body)));
  }
  getSource(projectId: string, sourceId: string): ProjectSource {
    const project = this.getProject(projectId);
    const row = this.db
      .query("SELECT body FROM project_sources WHERE project_id = ? AND id = ?")
      .get(project.id, SourceIdSchema.parse(sourceId));
    if (!row)
      throw new StudioError("source_not_found", "이 프로젝트의 자료를 찾을 수 없습니다.", 404);
    return ProjectSourceSchema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  addSource(projectId: string, input: CreateSource): ProjectSource {
    const [source] = this.importSources(projectId, [input]);
    if (!source) throw new StudioError("source_import", "자료를 저장하지 못했습니다.", 503);
    return source;
  }
  importSources(projectId: string, inputs: readonly CreateSource[]): ProjectSource[] {
    const sources = this.db.transaction(() => {
      this.getProject(projectId);
      return inputs.map((input) => {
        const existing =
          input.provenance.externalId === null
            ? null
            : this.db
                .query(
                  "SELECT body FROM project_sources WHERE project_id = ? AND origin = ? AND external_id = ?",
                )
                .get(projectId, input.provenance.origin, input.provenance.externalId);
        return this.persistSource(
          projectId,
          input,
          existing ? ProjectSourceSchema.parse(JSON.parse(RowSchema.parse(existing).body)) : null,
        );
      });
    })();
    this.onChange();
    return sources;
  }
  updateSource(projectId: string, sourceId: string, input: CreateSource): ProjectSource {
    const source = this.db.transaction(() => {
      const previous = this.getSource(projectId, sourceId);
      if (
        previous.provenance.origin !== input.provenance.origin ||
        previous.provenance.externalId !== input.provenance.externalId
      )
        throw new StudioError(
          "source_identity",
          "출처의 원본 식별자는 변경할 수 없습니다. 새 자료를 추가하세요.",
          400,
        );
      return this.persistSource(projectId, input, previous);
    })();
    this.onChange();
    return source;
  }
  deactivateSource(projectId: string, sourceId: string): ProjectSource {
    const previous = this.getSource(projectId, sourceId);
    const {
      id: _id,
      projectId: _projectId,
      contentStatus: _contentStatus,
      revision: _revision,
      digest: _digest,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...input
    } = previous;
    return this.updateSource(projectId, sourceId, { ...input, status: "inactive" });
  }
  snapshot(projectId: string): ProjectSourceSnapshot {
    const project = this.getProject(projectId);
    const capturedAt = new Date().toISOString();
    const sources = this.listSources(projectId).filter(
      (source) =>
        source.status === "eligible" &&
        (source.expiresAt === null || Date.parse(source.expiresAt) > Date.parse(capturedAt)),
    );
    if (sources.length > 100 || JSON.stringify(sources).length > 500000)
      throw new StudioError(
        "source_limit",
        "작업 자료는 사용 가능한 항목 100개, 500,000자 이내로 선택하세요.",
        400,
      );
    const scope = {
      projectId: project.id,
      projectName: project.name,
      revision: project.revision,
      sources,
    };
    return { ...scope, digest: digest(scope), capturedAt };
  }
  private persistSource(
    projectId: string,
    input: CreateSource,
    previous: ProjectSource | null,
  ): ProjectSource {
    const project = this.getProject(projectId);
    const contentStatus = input.content.length > 0 ? "content" : "metadata_only";
    const contentDigest = digest({ ...input, contentStatus });
    if (previous?.digest === contentDigest) return previous;
    const now = new Date().toISOString();
    const source: ProjectSource = {
      ...input,
      id: previous?.id ?? SourceIdSchema.parse(crypto.randomUUID()),
      projectId: project.id,
      contentStatus,
      revision: (previous?.revision ?? 0) + 1,
      digest: contentDigest,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const body = JSON.stringify(source);
    this.db
      .query(`INSERT INTO project_sources (id, project_id, origin, external_id, body)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`)
      .run(source.id, project.id, source.provenance.origin, source.provenance.externalId, body);
    this.db
      .query("INSERT INTO project_source_revisions (source_id, revision, body) VALUES (?, ?, ?)")
      .run(source.id, source.revision, body);
    this.saveProject({ ...project, revision: project.revision + 1, updatedAt: now });
    return source;
  }
  private saveProject(project: Project): void {
    this.db
      .query("INSERT OR REPLACE INTO projects (id, body) VALUES (?, ?)")
      .run(project.id, JSON.stringify(project));
  }
}
