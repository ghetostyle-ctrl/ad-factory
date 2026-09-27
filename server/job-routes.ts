import { Hono } from "hono";
import { validator } from "hono-openapi";
import {
  AutomationResetSchema,
  AutomationResumeSchema,
  AutomationStartSchema,
} from "../shared/automation";
import { buildProductionManifest } from "../shared/production-manifest";
import { AccountSelectionSchema, CreateJobSchema, PublishSchema } from "../shared/schema";
import type { AutomationEngine } from "./automation";
import { AutomationEnrollment } from "./automation-enrollment";
import { publicError, StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { logger } from "./logger";
import { analyzeJob } from "./meta-insights";
import { publishJob } from "./meta-publish";
import type { Pipeline } from "./pipeline";
import { captureProductionSources } from "./production-snapshot";
import { ProjectStore } from "./project-store";
import type { JobStore } from "./store";

export function jobRoutes(store: JobStore, pipeline: Pipeline, engine: AutomationEngine): Hono {
  const routes = new Hono();
  const mutations = new Set<string>();
  routes.use("/:id/*", async (c, next) => {
    const id = c.req.param("id");
    if (!id) throw new StudioError("id", "작업 ID가 필요합니다.", 400);
    if (mutations.has(id)) throw new StudioError("busy", "다른 변경 요청이 처리 중입니다.");
    mutations.add(id);
    try {
      await next();
    } finally {
      mutations.delete(id);
    }
  });
  const editable = (id: string) => {
    const job = store.get(id);
    if (pipeline.active.has(id) || job.status === "running" || job.staged || job.automation)
      throw new StudioError(
        "immutable",
        "실행 중이거나 Meta에 준비된 작업은 수정할 수 없습니다. 새 작업을 만들어 주세요.",
      );
    return job;
  };
  routes.post("/", validator("json", CreateJobSchema), (c) => {
    const input = c.req.valid("json");
    if (input.projectId) {
      const snapshot = new ProjectStore(store.db).snapshot(input.projectId);
      if (!evidencePack(snapshot).facts.length)
        throw new StudioError(
          "source_facts",
          "이 프로젝트에 사용 가능한 제품 사실을 등록한 뒤 작업을 만드세요.",
          400,
        );
    }
    return c.json(store.create(input), 201);
  });
  routes.get("/:id/production-plan", (c) => {
    const snapshot = store.get(c.req.param("id")).productionSourceSnapshot;
    if (!snapshot)
      throw new StudioError(
        "production_snapshot_missing",
        "이 작업에 고정된 제작 소스가 없습니다.",
        404,
      );
    c.header("Content-Disposition", 'attachment; filename="production-plan.json"');
    return c.json(buildProductionManifest(snapshot));
  });
  routes.post("/:id/automation/start", validator("json", AutomationStartSchema), (c) => {
    const policy = c.req.valid("json").policy;
    if (policy.mode !== "creative")
      throw new StudioError(
        "creative_only",
        "새 자동 작업은 소재 제작까지만 지원합니다. 광고 집행은 별도 설정에서 진행하세요.",
        400,
      );
    return c.json(engine.start(c.req.param("id"), policy));
  });
  routes.post("/:id/automation/stop", async (c) => c.json(await engine.stop(c.req.param("id"))));
  routes.post("/:id/automation/resume", validator("json", AutomationResumeSchema), (c) =>
    c.json(engine.resume(c.req.param("id"))),
  );
  routes.post("/:id/automation/reset", validator("json", AutomationResetSchema), (c) =>
    c.json(new AutomationEnrollment(store).reset(c.req.param("id"))),
  );
  routes.post("/:id/run", (c) => c.json(pipeline.run(c.req.param("id"))));
  routes.post("/:id/cancel", (c) => c.json(pipeline.cancel(c.req.param("id"))));
  routes.post("/:id/brief", validator("json", CreateJobSchema), (c) => {
    const job = editable(c.req.param("id"));
    const input = c.req.valid("json");
    const snapshot = input.projectId ? new ProjectStore(store.db).snapshot(input.projectId) : null;
    if (snapshot && !evidencePack(snapshot).facts.length)
      throw new StudioError("source_facts", "사용 가능한 제품 사실을 먼저 등록해 주세요.", 400);
    const productionSnapshot = input.projectId
      ? captureProductionSources(new ProjectStore(store.db), store.root, input.projectId)
      : null;
    return c.json(
      store.change(job.id, (draft) => {
        Object.assign(draft, input);
        draft.sourceSnapshot = snapshot;
        draft.productionSourceSnapshot = productionSnapshot;
        draft.creativePlan = null;
        draft.creativeVariants = [];
        draft.variantMetrics = [];
        draft.status = "queued";
        draft.result = null;
        draft.metrics = null;
        draft.artifacts = draft.artifacts.filter((asset) => asset.name.startsWith("uploaded-"));
        for (const agent of draft.agents) {
          agent.status = "idle";
          agent.action = "브리프 변경 · 재실행 대기";
          agent.startedAt = null;
          agent.finishedAt = null;
        }
        store.event(
          draft,
          null,
          "info",
          "브리프가 변경되어 이전 자동 생성 산출물을 무효화했습니다.",
        );
      }),
    );
  });
  routes.post("/:id/account", validator("json", AccountSelectionSchema), async (c) => {
    const job = editable(c.req.param("id"));
    const selection = c.req.valid("json");
    const account = (await pipeline.metaClientFactory().accounts()).find(
      (item) => item.id === selection.accountId,
    );
    if (!account)
      throw new StudioError("account", "실제로 조회된 접근 가능한 광고 계정을 선택하세요.", 400);
    if (account.currency !== job.currency)
      throw new StudioError(
        "currency",
        `계정 통화 ${account.currency}와 브리프 통화가 일치해야 합니다.`,
        400,
      );
    editable(job.id);
    return c.json(
      store.change(job.id, (draft) => {
        draft.accountId = account.id;
        draft.selection = selection;
        store.event(
          draft,
          "deployment",
          "info",
          `광고 계정을 명시적으로 선택했습니다: ${account.name} (${account.id})`,
        );
      }),
    );
  });
  routes.post("/:id/upload", async (c) => {
    const job = editable(c.req.param("id"));
    if (job.sourceSnapshot)
      throw new StudioError(
        "source_automation",
        "자료 기반 작업은 자동 운영에서 가설별 이미지를 제작·검토합니다.",
      );
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      throw new StudioError("upload", "file 필드에 PNG/JPEG 파일을 첨부하세요.", 400);
    editable(job.id);
    await pipeline.assets.upload(job.id, file);
    return c.json(store.get(job.id));
  });
  routes.post("/:id/publish", validator("json", PublishSchema), async (c) => {
    const id = c.req.param("id");
    if (store.get(id).automation)
      throw new StudioError(
        "automation",
        "자동 운영 작업은 최초 승인한 정책에 따라서만 게시합니다.",
      );
    if (pipeline.active.has(id) || store.get(id).status === "running")
      throw new StudioError("busy", "작업이 이미 실행 중입니다.");
    try {
      return c.json(await publishJob(store, { id, digest: c.req.valid("json").digest }));
    } catch (error) {
      if (error instanceof StudioError) throw error;
      store.change(id, (job) => {
        job.status = "failed";
        job.result = `${publicError(error)} 외부 게시 상태를 Meta 광고 관리자에서 확인하세요.`;
      });
      logger.error({ jobId: id, code: "publish_provider" }, "publish.failed");
      throw new StudioError(
        "publish_failed",
        "게시 요청을 완료하지 못했습니다. Meta 광고 관리자에서 실제 상태를 확인하세요.",
        503,
      );
    }
  });
  routes.post("/:id/analyze", async (c) => {
    const job = store.get(c.req.param("id"));
    if (job.automation || job.sourceSnapshot)
      throw new StudioError(
        "automation",
        "자동 운영 작업의 성과는 예약된 자동 분석으로 조회합니다.",
      );
    if (job.status === "running") throw new StudioError("busy", "실행 완료 후 성과를 조회하세요.");
    return c.json(await analyzeJob(store, job));
  });
  return routes;
}
