import type { Hono } from "hono";
import { flowImagesOf } from "../shared/flow-images";
import type { AutomationEngine } from "./automation";
import { StudioError } from "./errors";
import { FlowImageProduction } from "./flow-image-production";
import type { JobStore } from "./store";
export function installFlowImageRoutes(
  routes: Hono,
  store: JobStore,
  engine: AutomationEngine,
): void {
  const images = new FlowImageProduction(store);
  routes.get("/:id/flow-images", (c) => c.json(flowImagesOf(store.get(c.req.param("id")))));
  routes.get("/:id/flow-images/:requestId/image", (c) =>
    images.read(c.req.param("id"), c.req.param("requestId")),
  );
  routes.get("/:id/flow-images/:requestId/references/:index", (c) =>
    images.read(c.req.param("id"), c.req.param("requestId"), Number(c.req.param("index"))),
  );
  routes.post("/:id/flow-images/:requestId", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      throw new StudioError("flow_image_file", "PNG 또는 JPEG 파일을 선택하세요.", 400);
    if (file.size > 15 * 1024 * 1024)
      throw new StudioError("flow_image_size", "이미지는 15MB 이하여야 합니다.", 413);
    await images.upload({
      jobId: c.req.param("id"),
      requestId: c.req.param("requestId"),
      bytes: new Uint8Array(await file.arrayBuffer()),
      confirmed: form.get("confirmed") === "true",
      signal: c.req.raw.signal,
    });
    engine.wakeImages(c.req.param("id"));
    return c.json(store.get(c.req.param("id")));
  });
}
