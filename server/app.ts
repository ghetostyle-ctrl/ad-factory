import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { swaggerUI } from "@hono/swagger-ui";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { openAPIRouteHandler, validator } from "hono-openapi";
import { ZodError } from "zod";
import { ModelSettingsSchema } from "../shared/models";
import { PRODUCTION_UPLOAD_MAX_BYTES } from "../shared/production-assets";
import { ConnectionsSchema } from "../shared/schema";
import { AutomationEngine } from "./automation";
import { checkCliConnections } from "./cli-connections";
import { configStatus, credentials, env, persistCredentials } from "./config";
import { publicError, StudioError } from "./errors";
import type { InstructionsOptions } from "./instructions";
import { instructionsStatus } from "./instructions-status";
import { jobRoutes } from "./job-routes";
import { logger } from "./logger";
import { saveModelSettings } from "./model-settings";
import { Pipeline } from "./pipeline";
import { projectRoutes } from "./project-routes";
import { ProjectStore } from "./project-store";
import { installStatic } from "./static";
import type { JobStore } from "./store";

export type AppOptions = {
  // 지시 파일 로더 옵션(테스트가 임시 폴더·작은 절 목록을 주입한다). 기본은 저장소의 instructions/.
  readonly instructions?: InstructionsOptions;
};
export function createApp(
  store: JobStore,
  pipeline = new Pipeline(store),
  engine = new AutomationEngine(store),
  options: AppOptions = {},
): Hono {
  const app = new Hono();
  const library = new ProjectStore(store.db, () => {
    for (const listener of store.listeners) listener();
  });
  const installationId = createHash("sha256")
    .update(
      resolve(import.meta.dir, "..")
        .replaceAll("\\", "/")
        .toLowerCase(),
    )
    .digest("hex")
    .slice(0, 32);
  const ports = env.NODE_ENV === "development" ? [env.PORT, 5173] : [env.PORT];
  const allowed = new Set(
    ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
  );
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!allowed.has(url.origin)) return c.json({ error: "허용되지 않은 호스트입니다." }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.path.startsWith("/api")) c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (!origin || !allowed.has(origin))
        return c.json({ error: "동일 출처 요청만 허용합니다." }, 403);
    }
    await next();
  });
  app.use("/api/*", (c, next) => {
    const upload =
      c.req.method === "POST" && /^\/api\/projects\/[^/]+\/production-assets\/?$/.test(c.req.path);
    const sourceUpload =
      c.req.method === "POST" &&
      /^\/api\/projects\/[^/]+\/sources\/[^/]+\/files\/?$/.test(c.req.path);
    const flowClip =
      c.req.method === "POST" &&
      /^\/api\/jobs\/[^/]+\/videos\/\d+\/clips\/[A-H]\/?$/.test(c.req.path);
    return bodyLimit({
      maxSize:
        upload || flowClip
          ? PRODUCTION_UPLOAD_MAX_BYTES
          : sourceUpload
            ? 26 * 1024 * 1024
            : 16 * 1024 * 1024,
      onError: (context) =>
        context.json(
          {
            error: flowClip
              ? "Flow 클립 업로드 요청은 200MB 이하여야 합니다."
              : upload
                ? "영상 업로드 요청은 201MiB 이하여야 합니다."
                : sourceUpload
                  ? "이미지 파일은 한 장당 25MB 이하여야 합니다."
                  : "요청은 16MB 이하여야 합니다.",
          },
          413,
        ),
    })(c, next);
  });
  app.get("/api/health", (c) =>
    c.json({ app: "meta-ad-studio", installationId, pid: process.pid }),
  );
  const state = () => ({
    jobs: store.list(),
    projects: library.listProjects(),
    config: configStatus(store.root),
    engine: engine.state(),
  });
  app.get("/api/state", (c) => c.json(state()));
  // 지시 파일 상태(읽기 전용, 동일 출처 GET): 파일 목록·해시·마지막 로드·경고·임계값·절 KEY 와 글자 수. 절 본문은 보내지 않는다.
  // 호출마다 로더가 파일 변경을 확인하므로 파일을 고친 뒤 이 요청으로 파싱 결과를 확인할 수 있다.
  app.get("/api/instructions", (c) => c.json(instructionsStatus(options.instructions)));
  app.post("/api/model-settings", validator("json", ModelSettingsSchema), (c) => {
    saveModelSettings(store.root, c.req.valid("json"));
    return c.json(configStatus(store.root));
  });
  app.post("/api/cli-connections/check", async (c) =>
    c.json(await checkCliConnections(store.root)),
  );
  app.get("/api/accounts", async (c) =>
    c.json({ accounts: await pipeline.metaClientFactory().accounts() }),
  );
  app.post("/api/connections", validator("json", ConnectionsSchema), async (c) => {
    if (store.list().some((job) => job.status === "running"))
      throw new StudioError("busy", "실행 중인 작업이 끝난 후 연결을 변경하세요.");
    const input = c.req.valid("json");
    if (input.openaiApiKey !== undefined) credentials.openai = input.openaiApiKey;
    if (input.anthropicApiKey !== undefined) credentials.anthropic = input.anthropicApiKey;
    if (input.geminiApiKey !== undefined) credentials.gemini = input.geminiApiKey;
    if (input.metaAccessToken !== undefined) credentials.meta = input.metaAccessToken;
    if (input.typecastApiKey !== undefined) credentials.typecast = input.typecastApiKey;
    await persistCredentials(input);
    engine.wakeBlocked();
    return c.json(configStatus(store.root));
  });
  app.route("/api/jobs", jobRoutes(store, pipeline, engine));
  app.route("/api/projects", projectRoutes(library, store.root));
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = async () => {
        await stream.writeSSE({
          event: "state",
          data: JSON.stringify(state()),
        });
      };
      await send();
      await new Promise<void>((resolve) => {
        const onChange = () => {
          void send().catch(() => {
            store.listeners.delete(onChange);
            resolve();
          });
        };
        store.listeners.add(onChange);
        stream.onAbort(() => {
          store.listeners.delete(onChange);
          resolve();
        });
      });
    }),
  );
  // 완성 영상(30~60초 MP4)·내레이션 wav 미리보기 탐색용 Range(206) 지원
  app.get("/api/artifacts/:jobId/:name", async (c) => {
    const file = await pipeline.assets.read(c.req.param("jobId"), c.req.param("name"));
    const headers = new Headers({
      "Content-Type": file.type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    });
    const range = c.req.header("Range");
    if (!range) {
      headers.set("Content-Length", String(file.size));
      return new Response(file, { headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const first = match?.[1] ?? "";
    const last = match?.[2] ?? "";
    const suffix = first === "";
    const start = suffix ? Math.max(0, file.size - Number(last)) : Number(first);
    const end = suffix || last === "" ? file.size - 1 : Math.min(Number(last), file.size - 1);
    const valid =
      match &&
      (first !== "" || last !== "") &&
      Number.isSafeInteger(Number(first)) &&
      Number.isSafeInteger(Number(last)) &&
      start < file.size &&
      start <= end &&
      (!suffix || Number(last) > 0);
    if (!valid) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  });
  app.get(
    "/api/openapi.json",
    openAPIRouteHandler(app, {
      documentation: { info: { title: "Meta Ad Studio local API", version: "1.0.0" } },
    }),
  );
  app.get("/api/docs", Scalar({ url: "/api/openapi.json", hideTestRequestButton: true }));
  app.get("/api/swagger", swaggerUI({ url: "/api/openapi.json" }));
  installStatic(app);
  app.onError((error, c) => {
    if (error instanceof StudioError)
      return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError)
      return c.json(
        {
          error: "입력값 형식을 확인하세요.",
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
        400,
      );
    logger.error({ path: c.req.path, errorType: error.name }, "request.failed");
    return c.json({ error: publicError(error) }, 503);
  });
  return app;
}
