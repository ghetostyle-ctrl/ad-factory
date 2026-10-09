import { z } from "zod";
import { AutomationStateSchema, EngineStateSchema } from "./automation";
import { CreativePlanSchema, CreativeVariantSchema, StagedVariantSchema } from "./creative-plan";
import { ArtifactModelSchema, ExecutionModelsSchema, ModelSettingsSchema } from "./models";
import { CreativeSchema } from "./planning";
import { ProductionSourceSnapshotSchema } from "./production-manifest";
import { RenderStateSchema } from "./render-state";
import { ProjectIdSchema, ProjectSchema, ProjectSourceSnapshotSchema } from "./sources";
import { VideoScriptSchema } from "./video-script";

export const agentIds = ["strategy", "creative", "production", "deployment", "analysis"] as const;
export const AgentIdSchema = z.enum(agentIds);
export type AgentId = z.infer<typeof AgentIdSchema>;
export const JobIdSchema = z.string().uuid().brand<"JobId">();
export type JobId = z.infer<typeof JobIdSchema>;
export const MetaIdSchema = z.string().regex(/^\d+$/);
export const AccountIdSchema = z.string().regex(/^act_\d+$/);
export const StatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "blocked",
  "review",
  "completed",
  "cancelled",
  "failed",
]);
export const CreateJobSchema = z
  .object({
    projectId: ProjectIdSchema.nullable().default(null),
    name: z.string().trim().min(2).max(120),
    productUrl: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    productDescription: z.string().trim().max(12000),
    audience: z.string().trim().max(4000),
    objective: z.enum(["traffic", "sales"]).default("sales"),
    dailyBudget: z.number().positive().max(100000000).nullable().default(null),
    currency: z.enum(["KRW", "USD", "EUR", "JPY", "GBP"]).default("KRW"),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("KR"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projectId) return;
    if (value.productDescription.length < 20)
      context.addIssue({
        code: "custom",
        path: ["productDescription"],
        message: "프로젝트 없이 만들 때 제품 설명은 20자 이상 필요합니다.",
      });
    if (value.audience.length < 5)
      context.addIssue({
        code: "custom",
        path: ["audience"],
        message: "프로젝트 없이 만들 때 타깃 고객은 5자 이상 필요합니다.",
      });
  });
export type CreateJob = z.infer<typeof CreateJobSchema>;
export const AgentStateSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  status: StatusSchema,
  action: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;
export const ActivityEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  agentId: AgentIdSchema.nullable(),
  kind: z.enum(["info", "success", "warning", "error"]),
  message: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export const ArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  // audio: Typecast 내레이션 wav(voice-<n>-<i>-<a>.wav)
  kind: z.enum(["text", "image", "video", "json", "audio"]),
  url: z.string(),
  agentId: AgentIdSchema,
  model: ArtifactModelSchema.nullable().default(null),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export const AccountSchema = z.object({
  id: AccountIdSchema,
  name: z.string(),
  currency: z.string(),
  businessName: z.string(),
  businessId: z.string(),
});
export type Account = z.infer<typeof AccountSchema>;
export const AccountSelectionSchema = z
  .object({
    accountId: AccountIdSchema,
    pageId: MetaIdSchema.optional(),
    instagramAccountId: MetaIdSchema.optional(),
    pixelId: MetaIdSchema.optional(),
  })
  .strict();
export type AccountSelection = z.infer<typeof AccountSelectionSchema>;
export const StageSchema = z.object({
  pendingOperation: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  digest: z.string(),
  accountId: AccountIdSchema,
  dailyBudget: z.number(),
  budgetMinorUnits: z.number().int(),
  currency: z.string(),
  country: z.string(),
  objective: z.enum(["traffic", "sales"]),
  pageId: MetaIdSchema,
  campaignId: MetaIdSchema.nullable(),
  adsetId: MetaIdSchema.nullable(),
  creativeId: MetaIdSchema.nullable(),
  adId: MetaIdSchema.nullable(),
  imageHash: z.string().nullable(),
  artifactId: z.string(),
  managerUrl: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  maxTotalSpend: z.number().nullable().default(null),
  spendCapMinorUnits: z.number().int().nullable().default(null),
  endAt: z.string().nullable().default(null),
  creativeSnapshot: CreativeSchema.nullable().default(null),
  variants: z.array(StagedVariantSchema).max(3).default([]),
});
export type Stage = z.infer<typeof StageSchema>;
export const MetricsSchema = z.object({
  spend: z.number(),
  impressions: z.number(),
  clicks: z.number(),
  purchases: z.number(),
  revenue: z.number(),
  roas: z.number().nullable(),
  ctr: z.number().nullable(),
  dateStart: z.string(),
  dateStop: z.string(),
  fetchedAt: z.string(),
  currency: z.string(),
});
export type Metrics = z.infer<typeof MetricsSchema>;
export const JobSchema = CreateJobSchema.safeExtend({
  id: JobIdSchema,
  status: StatusSchema.exclude(["idle"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  agents: z.array(AgentStateSchema),
  events: z.array(ActivityEventSchema),
  artifacts: z.array(ArtifactSchema),
  accountId: AccountIdSchema.nullable(),
  selection: AccountSelectionSchema.nullable(),
  staged: StageSchema.nullable(),
  metrics: MetricsSchema.nullable(),
  result: z.string().nullable(),
  executionModels: ExecutionModelsSchema.nullable().default(null),
  automation: AutomationStateSchema.nullable().default(null),
  sourceSnapshot: ProjectSourceSnapshotSchema.nullable().default(null),
  productionSourceSnapshot: ProductionSourceSnapshotSchema.nullable().default(null),
  creativePlan: CreativePlanSchema.nullable().default(null),
  videoScripts: z.array(VideoScriptSchema).max(10).default([]),
  creativeVariants: z.array(CreativeVariantSchema).max(10).default([]),
  // 영상별 제작 상태(내레이션·시작 이미지·Veo 클립 핸들·완성본). 기존 행은 빈 배열로 읽힌다.
  renders: z.array(RenderStateSchema).max(10).default([]),
  variantMetrics: z
    .array(
      z.object({
        variantId: z.string(),
        adId: z.string(),
        metrics: MetricsSchema.nullable(),
      }),
    )
    .max(3)
    .default([]),
});
export type Job = z.infer<typeof JobSchema>;
export const ConfigStatusSchema = z.object({
  openai: z.boolean(),
  gemini: z.boolean(),
  codex: z.boolean(),
  anthropic: z.boolean().default(false),
  meta: z.boolean(),
  typecast: z.boolean(),
  // 로컬 렌더 도구 상태: ffmpeg 실행 가능 여부, 자막용 한글 폰트 존재 여부
  ffmpeg: z.boolean().default(false),
  captionFont: z.boolean().default(false),
  textProvider: z.enum(["openai", "codex", "none"]),
  imageModel: z.string(),
  textModel: z.string(),
  metaVersion: z.string(),
  modelSettings: ModelSettingsSchema,
});
export type ConfigStatus = z.infer<typeof ConfigStatusSchema>;
export const StateSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  jobs: z.array(JobSchema),
  config: ConfigStatusSchema,
  engine: EngineStateSchema,
});
export type StudioState = z.infer<typeof StateSchema>;
export const PublishSchema = z
  .object({ confirmation: z.literal(true), digest: z.string().min(1) })
  .strict();
export const AccountsSchema = z.object({ accounts: z.array(AccountSchema) });
export const ConnectionsSchema = z
  .object({
    openaiApiKey: z.string().trim().max(1024).optional(),
    anthropicApiKey: z.string().trim().max(1024).optional(),
    geminiApiKey: z.string().trim().max(1024).optional(),
    metaAccessToken: z.string().trim().max(4096).optional(),
    typecastApiKey: z.string().trim().max(1024).optional(),
  })
  .strict();
