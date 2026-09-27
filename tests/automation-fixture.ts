import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomaticProduction } from "../server/automation-production";
import { automationServices } from "../server/automation-services";
import { generateImageResult } from "../server/image-provider";
import { Intelligence } from "../server/intelligence";
import { MetaClient } from "../server/meta-client";
import { saveModelSettings, snapshotModels } from "../server/model-settings";
import { Pipeline } from "../server/pipeline";
import { JobStore } from "../server/store";
import { generateTextResult } from "../server/text-provider";
import { CreativeSchema, StrategySchema } from "../shared/planning";
import { CreateJobSchema } from "../shared/schema";
import { httpFixture } from "./automation-http-fixture";

export const automationBrief = CreateJobSchema.parse({
  name: "Local automation fixture",
  productUrl: "https://example.com",
  productDescription: "Documented fixture product facts, no real advertising.",
  audience: "Adult fixture audience",
  objective: "traffic",
  dailyBudget: 10,
  currency: "USD",
  country: "US",
});
export const automationPolicy = () =>
  ({
    mode: "activate",
    maxTotalSpend: 100,
    endAt: new Date(Date.now() + 86400000).toISOString(),
    analysisIntervalMinutes: 15,
  }) as const;
export async function automationFixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-automation-"));
  const store = new JobStore(root);
  saveModelSettings(root, {
    textProvider: "openai",
    textModel: "fixture-text",
    codexModel: null,
    imageModel: "gpt-image-2.5-sunburst",
    imageQuality: "high",
    ttsProvider: "typecast",
    ttsSelection: "auto",
    ttsVoiceId: null,
    ttsTempo: 1,
  });
  const http = httpFixture();
  const connection = {
    apiKey: "local-fixture-only",
    baseUrl: `http://127.0.0.1:${http.server.port}/openai/`,
  };
  const clientFactory = () =>
    new MetaClient("local-fixture-only", `http://127.0.0.1:${http.server.port}/meta/`, 1000);
  const intelligence = new Intelligence(root, connection);
  const production = new AutomaticProduction(store, {
    strategy: (job, signal) =>
      generateTextResult(
        {
          name: "strategy",
          schema: StrategySchema,
          prompt: job.productDescription,
          signal,
          directory: root,
          models: job.executionModels ?? snapshotModels(root),
        },
        connection,
      ),
    creative: (job, strategy, signal) =>
      generateTextResult(
        {
          name: "creative",
          schema: CreativeSchema,
          prompt: JSON.stringify(strategy),
          signal,
          directory: root,
          models: job.executionModels ?? snapshotModels(root),
        },
        connection,
      ),
    image: (job, prompt, signal) =>
      generateImageResult(
        { prompt, signal, models: job.executionModels ?? snapshotModels(root) },
        connection,
      ),
    review: (task) => intelligence.review(task),
  });
  const services = automationServices(store, { production, clientFactory, intelligence });
  const engine = new AutomationEngine(store, services);
  const pipeline = new Pipeline(store, undefined, clientFactory);
  const app = createApp(store, pipeline, engine);
  const fresh = () => {
    const job = store.create(automationBrief);
    return store.change(job.id, (draft) => {
      draft.accountId = "act_123";
      draft.selection = { accountId: "act_123", pageId: "456" };
    });
  };
  const settle = async () => {
    await engine.tick();
    await Promise.all([...engine.active.values()].map((value) => value.promise));
  };
  const close = async () => {
    engine.close();
    await Promise.all([...engine.active.values()].map((value) => value.promise));
    await http.server.stop(true);
    store.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, store, engine, services, app, fresh, settle, close, ...http };
}
export function automationRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:4317/api/jobs/${path}`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
