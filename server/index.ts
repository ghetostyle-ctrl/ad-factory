import { createApp } from "./app";
import { AutomationEngine } from "./automation";
import { dataDir, env } from "./config";
import { logger } from "./logger";
import { Pipeline } from "./pipeline";
import { ffmpegCapabilities } from "./render/ffmpeg";
import { resolveFont } from "./render/fonts";
import { JobStore } from "./store";

let app: ReturnType<typeof createApp> | null = null;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: env.PORT,
  idleTimeout: 0,
  maxRequestBodySize: PRODUCTION_UPLOAD_MAX_BYTES,
  fetch: (request) => app?.fetch(request) ?? new Response("Starting", { status: 503 }),
});
const store = new JobStore(dataDir);
const engine = new AutomationEngine(store);
// 기동 시 ffmpeg·자막 폰트를 한 번 검사해 캐시한다(동기 configStatus 가 미확정 값을 내보내지 않도록 createApp 전에).
const ffmpeg = await ffmpegCapabilities()
  .then((capabilities) => capabilities.version)
  .catch(() => null);
const font = resolveFont();
logger.info(
  { ffmpeg: ffmpeg ?? "missing", captionFont: font?.family ?? "missing" },
  "studio.render_tools",
);
app = createApp(store, new Pipeline(store), engine);
engine.open();
logger.info({ url: `http://127.0.0.1:${server.port}` }, "studio.started");

import { PRODUCTION_UPLOAD_MAX_BYTES } from "../shared/production-assets";
