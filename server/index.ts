import { createApp } from "./app";
import { AutomationEngine } from "./automation";
import { dataDir, env } from "./config";
import { logger } from "./logger";
import { Pipeline } from "./pipeline";
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
app = createApp(store, new Pipeline(store), engine);
engine.open();
logger.info({ url: `http://127.0.0.1:${server.port}` }, "studio.started");

import { PRODUCTION_UPLOAD_MAX_BYTES } from "../shared/production-assets";
