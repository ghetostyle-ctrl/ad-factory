import { z } from "zod";
import { CreativeSchema, StrategySchema } from "../shared/planning";

export const fixtureStrategy = StrategySchema.parse({
  positioning: "Fixture strategy",
  audienceInsight: "Known audience",
  valueProposition: "Documented facts",
  messageAngles: ["Facts"],
  risks: [],
  measurementPlan: "Actual metrics only",
});
export const fixtureCreative = CreativeSchema.parse({
  concept: "Fixture",
  headline: "Facts",
  primaryText: "Factual description",
  description: "Documented facts",
  callToAction: "LEARN_MORE",
  imagePrompt: "Fixture square concept",
  rationale: "Fixture only",
  checks: [],
});
export const fixturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nAAAAABJRU5ErkJggg==";
export function httpFixture() {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const remote = new Map<string, Record<string, unknown>>();
  const control = {
    empty: false,
    zero: false,
    spend: 20,
    revisions: 0,
    failPath: "",
    holdPath: "",
    hold: Promise.resolve(),
    limitOffset: 0,
    copyChanged: false,
    lostActivationResponse: false,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? z.record(z.string(), z.unknown()).parse(await request.json())
          : {};
      requests.push({ path, method: request.method, body });
      if (path === control.holdPath && request.method === "POST") await control.hold;
      if (path === control.failPath)
        return Response.json({ error: "Local fixture failure" }, { status: 503 });
      if (path === "/openai/images/generations")
        return Response.json({ model: body["model"], data: [{ b64_json: fixturePng }] });
      if (path === "/openai/responses") {
        const format = z
          .object({ text: z.object({ format: z.object({ name: z.string() }) }) })
          .parse(body).text.format.name;
        const value =
          format === "strategy"
            ? fixtureStrategy
            : format === "creative"
              ? fixtureCreative
              : format === "image_review"
                ? control.revisions-- > 0
                  ? {
                      status: "revise",
                      summary: "Revise fixture",
                      issues: ["Fixture contrast"],
                      revisionPrompt: "Revised fixture",
                    }
                  : {
                      status: "pass",
                      summary: "Actual fixture inspected",
                      issues: [],
                      revisionPrompt: null,
                    }
                : {
                    summary: "Fixture observed performance",
                    observations: ["Observed metrics only"],
                    hypotheses: [],
                    recommendations: ["Wait for more observations"],
                    limitations: ["Local HTTP fixture, not actual campaign performance"],
                  };
        return Response.json({
          model: body["model"],
          status: "completed",
          output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
        });
      }
      if (path === "/meta/me/adaccounts")
        return Response.json({
          data: [{ id: "act_123", name: "LOCAL HTTP FIXTURE ONLY", currency: "USD" }],
        });
      if (path.endsWith("/insights"))
        return Response.json({
          data: control.empty
            ? []
            : [
                {
                  spend: String(control.zero ? 0 : control.spend),
                  impressions: control.zero ? "0" : "1000",
                  clicks: control.zero ? "0" : "20",
                  date_start: "2026-09-24",
                  date_stop: "2026-09-24",
                  actions: [],
                  action_values: [],
                },
              ],
        });
      if (request.method === "POST") {
        if (path.endsWith("/adimages"))
          return Response.json({ images: { fixture: { hash: "fixture-image-hash" } } });
        if (/\/meta\/\d+$/.test(path)) {
          remote.set(path, { ...remote.get(path), status: body["status"] });
          if (
            control.lostActivationResponse &&
            path === "/meta/1001" &&
            body["status"] === "ACTIVE"
          )
            await new Promise<void>(() => {});
          return Response.json({ success: true });
        }
        const id = path.endsWith("/campaigns")
          ? "1001"
          : path.endsWith("/adsets")
            ? "1002"
            : path.endsWith("/adcreatives")
              ? "1003"
              : "1004";
        remote.set(`/meta/${id}`, body);
        return Response.json({ id });
      }
      const item = remote.get(path);
      if (path === "/meta/1001")
        return Response.json({
          ...item,
          account_id: "123",
          spend_cap: String(Number(item?.["spend_cap"] ?? 0) + control.limitOffset),
        });
      if (path === "/meta/1002")
        return Response.json({
          ...item,
          daily_budget: String(item?.["daily_budget"]),
          end_time: item?.["end_time"],
        });
      if (path === "/meta/1003" && control.copyChanged)
        return Response.json({
          object_story_spec: {
            page_id: "456",
            link_data: {
              image_hash: "fixture-image-hash",
              link: "https://example.com",
              message: "TAMPERED",
              name: "Facts",
              description: "Documented facts",
              call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
            },
          },
        });
      if (path === "/meta/1004")
        return Response.json({
          ...item,
          adset_id: "1002",
          creative: { id: "1003" },
          effective_status: item?.["status"] ?? "PAUSED",
        });
      if (item) return Response.json(item);
      return Response.json({ error: `Unmapped local fixture route ${path}` }, { status: 404 });
    },
  });
  return { server, requests, control };
}
