import { z } from "zod";
import { ReferenceDataSchema } from "./reference-schema";

export const ProjectIdSchema = z.string().uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const SourceIdSchema = z.string().uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceIdSchema>;
export const SourceUrlSchema = z
  .url()
  .max(4000)
  .refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  });
export const CreateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(4000).default(""),
  })
  .strict();
export type CreateProject = z.infer<typeof CreateProjectSchema>;
export const ProjectSchema = CreateProjectSchema.extend({
  id: ProjectIdSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;
export const SourceProvenanceSchema = z
  .object({
    origin: z.enum(["user", "success_ai", "link_copy"]).default("user"),
    externalId: z.string().trim().min(1).max(240).nullable().default(null),
    capturedAt: z.iso.datetime().nullable().default(null),
    author: z.string().trim().max(240).nullable().default(null),
  })
  .strict();
export const CreateSourceSchema = z
  .object({
    kind: z.enum(["product_fact", "review", "offer", "reference"]),
    title: z.string().trim().min(2).max(240),
    content: z.string().trim().max(20000).default(""),
    url: SourceUrlSchema.nullable().default(null),
    evidence: z.enum(["observed", "hypothesis"]).default("observed"),
    status: z.enum(["eligible", "inactive"]).default("eligible"),
    expiresAt: z.iso.datetime().nullable().default(null),
    provenance: SourceProvenanceSchema.default({
      origin: "user",
      externalId: null,
      capturedAt: null,
      author: null,
    }),
    referenceData: ReferenceDataSchema.optional(),
    // 고객 후기가 우리 제품 후기인지 경쟁 제품 후기인지. 경쟁 제품 후기는 고객의 불편·실패 경험·욕망의
    // 근거로만 쓰고 우리 상품의 후기·평가로 쓰지 않는다(CREATIVE-PLANNING-DESIGN.md 8절). 예전 자료는 비어 있다.
    reviewOf: z.enum(["own", "competitor"]).optional(),
  })
  .strict()
  .refine((source) => source.kind === "review" || source.reviewOf === undefined, {
    message: "우리/경쟁 제품 구분은 고객 후기에만 사용할 수 있습니다.",
    path: ["reviewOf"],
  })
  .refine((source) => source.content.length > 0 || source.url !== null, {
    message: "내용 또는 출처 URL을 입력하세요.",
    path: ["content"],
  })
  .refine((source) => source.kind === "reference" || source.referenceData === undefined, {
    message: "광고 레퍼런스 데이터는 레퍼런스 유형에만 사용할 수 있습니다.",
    path: ["referenceData"],
  })
  .refine((source) => source.provenance.origin !== "success_ai" || source.kind === "reference", {
    message: "Success AI 광고는 제품 사실이 아닌 레퍼런스로 저장해야 합니다.",
    path: ["kind"],
  });
export type CreateSource = z.infer<typeof CreateSourceSchema>;
export const ProjectSourceSchema = CreateSourceSchema.safeExtend({
  id: SourceIdSchema,
  projectId: ProjectIdSchema,
  contentStatus: z.enum(["content", "metadata_only"]),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectSource = z.infer<typeof ProjectSourceSchema>;
export const ProjectSourceSnapshotSchema = z
  .object({
    projectId: ProjectIdSchema,
    projectName: z.string(),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.iso.datetime(),
    sources: z.array(ProjectSourceSchema).max(100),
  })
  .strict();
export type ProjectSourceSnapshot = z.infer<typeof ProjectSourceSnapshotSchema>;
export const ProjectsSchema = z.object({ projects: z.array(ProjectSchema) });
export const ProjectDetailSchema = z.object({
  project: ProjectSchema,
  sources: z.array(ProjectSourceSchema),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export const ImportSourcesSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    exportedAt: z.iso.datetime().optional(),
    items: z.array(CreateSourceSchema).min(1).max(100),
  })
  .strict()
  .refine((batch) => JSON.stringify(batch).length <= 500000, {
    message: "가져오기 자료는 500,000자 이하여야 합니다.",
  });
export const SourceImportResultSchema = z.object({ sources: z.array(ProjectSourceSchema) });
export const SuccessAiPreviewSchema = z
  .object({
    platform: z.enum(["meta", "google"]),
    keyword: z.string().trim().min(1).max(120),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type SuccessAiPreview = z.infer<typeof SuccessAiPreviewSchema>;
export const SuccessAiExportSchema = ImportSourcesSchema.safeExtend({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
}).refine(
  (batch) =>
    batch.items.every(
      (source) =>
        source.kind === "reference" &&
        source.provenance.origin === "success_ai" &&
        source.provenance.externalId !== null,
    ),
  {
    message: "Success AI에서 출처 식별자가 있는 레퍼런스만 가져올 수 있습니다.",
  },
);
export type SuccessAiExport = z.infer<typeof SuccessAiExportSchema>;
