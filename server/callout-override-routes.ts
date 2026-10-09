import type { Hono } from "hono";
import { validator } from "hono-openapi";
import { CalloutOverridesEditSchema } from "../shared/callout-overrides";
import type { CalloutOverrides } from "./callout-overrides";
import { StudioError } from "./errors";

export function installCalloutOverrideRoutes(
  routes: Hono,
  service: CalloutOverrides,
  active: (id: string) => boolean,
): void {
  const numberOf = (raw: string) => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > 10)
      throw new StudioError("callout_number", "영상 번호는 1~10 입니다.", 400);
    return number;
  };
  routes.get("/:id/videos/:number/callout-overrides", async (c) => {
    const id = c.req.param("id");
    if (active(id)) throw new StudioError("callout_busy", "실행 중인 작업입니다.");
    return c.json(await service.view(id, numberOf(c.req.param("number"))));
  });
  routes.put(
    "/:id/videos/:number/callout-overrides",
    validator("json", CalloutOverridesEditSchema),
    async (c) => {
      const id = c.req.param("id");
      if (active(id)) throw new StudioError("callout_busy", "실행 중인 작업입니다.");
      return c.json(await service.save(id, numberOf(c.req.param("number")), c.req.valid("json")));
    },
  );
}
