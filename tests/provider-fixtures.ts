import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelSettings, saveModelSettings, snapshotModels } from "../server/model-settings";
import { JobStore } from "../server/store";
import { CreativeSchema } from "../shared/planning";
import { CreateJobSchema, MetricsSchema } from "../shared/schema";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
export const creative = CreativeSchema.parse({
  concept: "Fixture",
  headline: "Facts",
  primaryText: "Product facts",
  description: "Facts",
  callToAction: "LEARN_MORE",
  imagePrompt: "Fixture image",
  rationale: "Facts",
  checks: [],
});
export const metrics = MetricsSchema.parse({
  spend: 17,
  impressions: 830,
  clicks: 19,
  purchases: 2,
  revenue: 41,
  roas: 41 / 17,
  ctr: 1900 / 830,
  dateStart: "2026-09-01",
  dateStop: "2026-09-07",
  fetchedAt: "2026-09-08T00:00:00Z",
  currency: "USD",
});
export const passReview = {
  status: "pass",
  summary: "검토 완료",
  issues: [],
  revisionPrompt: null,
};
export const report = {
  summary: "관측 기간 요약",
  observations: ["지출 17 USD"],
  hypotheses: [],
  recommendations: ["표본 수집"],
  limitations: ["단일 기간으로 인과 판단 불가"],
};

export function providerStore(): JobStore {
  const store = new JobStore(mkdtempSync(join(tmpdir(), "studio-provider-")));
  saveModelSettings(store.root, {
    ...getModelSettings(store.root),
    textProvider: "openai",
    textModel: "fixture-text-model",
    imageModel: "gpt-image-2.5-flare",
    imageQuality: "max",
  });
  const job = store.create(
    CreateJobSchema.parse({
      name: "Fixture",
      productUrl: "https://example.com",
      productDescription: "A factual product description for a fixture.",
      audience: "Adult shoppers",
      objective: "traffic",
      dailyBudget: 5,
      currency: "USD",
      country: "US",
    }),
  );
  store.change(job.id, (draft) => {
    draft.executionModels = snapshotModels(store.root);
  });
  return store;
}
export function response(value: unknown, model: string = "fixture-observed-model"): Response {
  return Response.json({
    model,
    status: "completed",
    output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  });
}
