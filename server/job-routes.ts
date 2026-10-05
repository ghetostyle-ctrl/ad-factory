import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import {
  AutomationResetSchema,
  AutomationResumeSchema,
  AutomationStartSchema,
} from "../shared/automation";
import { FLOW_CLIP_MAX_BYTES } from "../shared/flow-mode";
import { buildProductionManifest } from "../shared/production-manifest";
import { ClipIdSchema } from "../shared/render-state";
import { AccountSelectionSchema, CreateJobSchema, PublishSchema } from "../shared/schema";
import type { AutomationEngine } from "./automation";
import { AutomationEnrollment } from "./automation-enrollment";
import { publicError, StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { FlowImport } from "./flow-import";
import { logger } from "./logger";
import { analyzeJob } from "./meta-insights";
import { publishJob } from "./meta-publish";
import type { Pipeline } from "./pipeline";
import { captureProductionSources } from "./production-snapshot";
import { ProjectStore } from "./project-store";
import { ScriptEditSchema, ScriptRewriteSchema } from "./script-service";
import type { JobStore } from "./store";

export function jobRoutes(store: JobStore, pipeline: Pipeline, engine: AutomationEngine): Hono {
  const routes = new Hono();
  const mutations = new Set<string>();
  const flowImport = new FlowImport(store);
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
  // "/:id/*" 미들웨어가 "/:id" 에도 걸려 동시 변경을 막는다.
  routes.delete("/:id", async (c) => {
    const job = store.get(c.req.param("id"));
    if (pipeline.active.has(job.id) || job.status === "running")
      throw new StudioError("delete_running", "실행 중인 작업은 먼저 중지한 뒤 삭제하세요.");
    if (
      job.automation &&
      ["queued", "running", "waiting", "attention"].includes(job.automation.status)
    )
      throw new StudioError(
        "delete_automation",
        "자동 운영 중이거나 확인이 필요한 작업입니다. 자동 운영을 중지한 뒤 삭제하세요.",
      );
    if (job.staged)
      throw new StudioError(
        "delete_staged",
        "Meta에 광고가 준비된 작업은 기록 보존을 위해 삭제할 수 없습니다.",
      );
    store.remove(job.id);
    await rm(join(store.root, "artifacts", job.id), { recursive: true, force: true });
    // 렌더 스크래치(세그먼트 캐시)도 같이 지운다
    await rm(join(store.root, "render", job.id), { recursive: true, force: true });
    // Flow 모드 CLI 번들(시작 이미지·prompts.md)도 같이 지운다
    await rm(join(store.root, "flow", job.id), { recursive: true, force: true });
    logger.info({ jobId: job.id }, "job.deleted");
    return c.json({ deleted: job.id });
  });
  // Google Flow 에서 만든 Veo 클립 업로드: 원본 바이트(video/mp4) 또는 multipart 'file'. 선택 ?model= 은 Flow 에서 쓴 모델 이름.
  routes.post("/:id/videos/:number/clips/:clipId", async (c) => {
    const id = c.req.param("id");
    const number = Number(c.req.param("number"));
    const clipId = ClipIdSchema.safeParse(c.req.param("clipId"));
    if (!Number.isInteger(number) || number < 1 || number > 10 || !clipId.success)
      throw new StudioError("flow_clip", "영상 번호(1~10)와 클립 ID(A~H)를 확인하세요.", 400);
    const declared = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declared) && declared > FLOW_CLIP_MAX_BYTES + 1024 * 1024)
      throw new StudioError("flow_size", "클립 파일은 200MB 이하여야 합니다.", 413);
    let bytes: Uint8Array;
    let model = c.req.query("model") ?? null;
    if ((c.req.header("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        throw new StudioError("flow_format", "file 필드에 MP4 파일을 첨부하세요.", 400);
      if (file.size > FLOW_CLIP_MAX_BYTES)
        throw new StudioError("flow_size", "클립 파일은 200MB 이하여야 합니다.", 413);
      bytes = new Uint8Array(await file.arrayBuffer());
      const field = form.get("model");
      if (model === null && typeof field === "string") model = field;
    } else bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await flowImport.import({
      jobId: id,
      number,
      clipId: clipId.data,
      bytes,
      model,
    });
    // 기다리던 영상의 클립이 모두 들어왔으면 대기를 풀고 이어서 실행한다(그래픽 → 조립).
    engine.wakeFlow(id);
    return c.json(result.job);
  });
  // 영상 대본 확인·수정·승인·다시 쓰기(사용자 결정 2026-10-04). 승인 전에는 유료 제작(내레이션)을 시작하지 않는다.
  const videoNumber = (raw: string | undefined) => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > 10)
      throw new StudioError("script_number", "영상 번호는 1~10 입니다.", 400);
    return number;
  };
  routes.get("/:id/videos/:number/script", (c) =>
    c.json(engine.services.scripts.view(c.req.param("id"), videoNumber(c.req.param("number")))),
  );
  routes.put("/:id/videos/:number/script", validator("json", ScriptEditSchema), async (c) => {
    const id = c.req.param("id");
    const number = videoNumber(c.req.param("number"));
    await engine.services.scripts.edit(id, number, c.req.valid("json"));
    await engine.services.scripts.saveEdited(id, number);
    return c.json(engine.services.scripts.view(id, number));
  });
  routes.post("/:id/videos/:number/script/approve", (c) => {
    const id = c.req.param("id");
    const number = videoNumber(c.req.param("number"));
    engine.services.scripts.approve(id, number);
    // 모든 영상이 승인됐으면 대기를 풀고 이어서 실행한다(내레이션 합성부터).
    engine.wakeScripts(id);
    return c.json(engine.services.scripts.view(id, number));
  });
  routes.post(
    "/:id/videos/:number/script/rewrite",
    validator("json", ScriptRewriteSchema),
    async (c) => {
      const id = c.req.param("id");
      const number = videoNumber(c.req.param("number"));
      await engine.services.scripts.rewrite(
        id,
        number,
        c.req.valid("json").feedback,
        new AbortController().signal,
      );
      // 자동 진행 정책에서 다시 쓴 대본이 AI 검토를 통과하면 승인이 필요 없으므로 곧바로 이어간다(기본 정책은 승인 전이라 깨어나지 않는다).
      engine.wakeScripts(id);
      return c.json(engine.services.scripts.view(id, number));
    },
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
