import type { Hono } from "hono";
import { validator } from "hono-openapi";
import { PlanChoiceRequestSchema } from "../shared/plan-recovery";
import type { AutomationEngine } from "./automation";
import { StudioError } from "./errors";
import { PlanRecoveryService } from "./plan-recovery";
import type { JobStore } from "./store";

export function installPlanRecoveryRoutes(
  routes: Hono,
  store: JobStore,
  engine: AutomationEngine,
  isActive: (id: string) => boolean,
): void {
  const recovery = new PlanRecoveryService(store);
  routes.get("/:id/plan-recovery", async (c) => c.json(await recovery.inspect(c.req.param("id"))));
  routes.post("/:id/plan-recovery", validator("json", PlanChoiceRequestSchema), async (c) => {
    const id = c.req.param("id");
    if (isActive(id)) throw new StudioError("busy", "현재 요청이 끝난 뒤 기획을 선택하세요.");
    await recovery.choose(id, c.req.valid("json"));
    return c.json(engine.resume(id));
  });
}
