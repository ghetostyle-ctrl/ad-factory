import { z } from "zod";

const AdvertisingPolicySchema = z
  .object({
    mode: z.enum(["prepare", "activate"]),
    maxTotalSpend: z.number().positive().max(1000000000),
    endAt: z.iso.datetime(),
    analysisIntervalMinutes: z.number().int().min(15).max(1440),
  })
  .strict();
export const AutomationPolicySchema = z.union([
  z
    .object({
      mode: z.literal("creative"),
      imageCount: z.number().int().min(1).max(10).optional(),
      videoCount: z.number().int().min(0).max(10).optional(),
      videoModel: z
        .enum([
          "veo-3.1-lite-generate-preview",
          "veo-3.1-fast-generate-preview",
          "veo-3.1-generate-preview",
        ])
        .optional(),
      // Veo 클립 해상도(기본 1080p). scopeDigest 에 포함되어 실행 중 변경은 차단된다.
      videoResolution: z.enum(["720p", "1080p"]).optional(),
      // BGM 선택 정책(기본 auto: 가설 단계별 무드 매핑 + 결정론 선택). 덕킹·레벨 수치는 서버 상수.
      bgm: z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("auto") }).strict(),
          z
            .object({ mode: z.literal("track"), trackId: z.string().trim().min(1).max(120) })
            .strict(),
          z.object({ mode: z.literal("none") }).strict(),
        ])
        .optional(),
      // 완성 클립 프레임 3장 비전 검토(기본 true). 끄면 형식 검증만 한다.
      clipReview: z.boolean().optional(),
      // 클립 생성 방식(기본 api). flow 는 Veo API 를 부르지 않고 Google Flow 웹에서 만든 클립을 업로드받는다.
      // scopeDigest 에 포함되어 실행 중 변경은 차단된다.
      clipMode: z.enum(["api", "flow"]).optional(),
      // 영상 대본 확인(기본 required: 사용자가 대본을 승인해야 유료 제작(내레이션 합성)을 시작한다).
      // auto 는 AI 검토만 거치고 바로 진행. scopeDigest 에 포함되어 시작 뒤 변경 불가.
      scriptApproval: z.enum(["required", "auto"]).optional(),
    })
    .strict(),
  AdvertisingPolicySchema,
]);
export type PolicyBgm = NonNullable<
  Extract<z.infer<typeof AutomationPolicySchema>, { mode: "creative" }>["bgm"]
>;
export type AutomationPolicy = z.infer<typeof AutomationPolicySchema>;
export const AutomationStateSchema = z.object({
  policy: AutomationPolicySchema,
  status: z.enum(["queued", "running", "waiting", "blocked", "attention", "stopped", "completed"]),
  phase: z.enum([
    "strategy",
    "creative",
    "script",
    "image",
    // video: 예전 단일 클립 단계(레거시 호환). 새 제작은 voice→stills→startImages→clips→graphics→assemble.
    "video",
    "voice",
    "stills",
    "startImages",
    "clips",
    "graphics",
    "assemble",
    "review",
    "stage",
    "activate",
    "insights",
    "report",
    "finished",
  ]),
  nextRunAt: z.string().nullable(),
  nextAnalysisAt: z.string().nullable(),
  lastError: z.string().nullable(),
  authorizedAt: z.string(),
  scopeDigest: z.string(),
  imageAttempts: z.number().int().min(0).max(2),
  operation: z.string().nullable(),
  videoOperation: z
    .object({
      index: z.number().int().min(1).max(10),
      name: z.string(),
      startedAt: z.iso.datetime(),
    })
    .nullable()
    .default(null),
  stoppedAt: z.string().nullable(),
  approvedImageId: z.string().nullable().default(null),
  approvedImageDigest: z.string().nullable().default(null),
  approvedCreativeDigest: z.string().nullable().default(null),
  approvedPlanDigest: z.string().nullable().default(null),
  lastAnalysisDigest: z.string().nullable().default(null),
});
export type AutomationState = z.infer<typeof AutomationStateSchema>;
export const AutomationStartSchema = z
  .object({ confirmation: z.literal(true), policy: AutomationPolicySchema })
  .strict();
export const AutomationResumeSchema = z.object({ confirmation: z.literal(true) }).strict();
export const AutomationResetSchema = z.object({ confirmation: z.literal(true) }).strict();
export const EngineStateSchema = z.object({
  running: z.boolean(),
  activeJobs: z.number().int().nonnegative(),
  lastTickAt: z.string().nullable(),
});
