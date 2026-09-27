import { z } from "zod";
import type { Job, Metrics } from "../shared/schema";
import { BlockedError } from "./errors";
import { MetaClient } from "./meta-client";
import type { JobStore } from "./store";

const numeric = z.string().transform(Number).pipe(z.number().finite().nonnegative());
const ValuesSchema = z.array(z.object({ action_type: z.string(), value: numeric }));
export const InsightsSchema = z.object({
  data: z.array(
    z.object({
      spend: numeric,
      impressions: numeric,
      clicks: numeric,
      date_start: z.string(),
      date_stop: z.string(),
      actions: ValuesSchema.optional(),
      action_values: ValuesSchema.optional(),
    }),
  ),
});
export function metricsFromResponse(
  data: z.infer<typeof InsightsSchema>,
  currency: string,
): Metrics | null {
  const row = data.data[0];
  if (!row) return null;
  const purchase = (values: z.infer<typeof ValuesSchema> | undefined) =>
    values?.find((item) => item.action_type === "omni_purchase")?.value ??
    values?.find((item) => item.action_type === "purchase")?.value ??
    values?.find((item) => item.action_type === "offsite_conversion.fb_pixel_purchase")?.value ??
    0;
  const revenue = purchase(row.action_values);
  return {
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    purchases: purchase(row.actions),
    revenue,
    roas: row.spend > 0 ? revenue / row.spend : null,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null,
    currency,
    dateStart: row.date_start,
    dateStop: row.date_stop,
    fetchedAt: new Date().toISOString(),
  };
}
export async function analyzeJob(store: JobStore, job: Job): Promise<Job> {
  if (job.sourceSnapshot)
    throw new BlockedError(
      "자료 기반 작업의 성과는 자동 운영에서 캠페인과 가설별 광고를 함께 조회합니다.",
    );
  if (!job.staged?.adId)
    throw new BlockedError("실제 Meta 광고 ID가 있어야 성과를 조회할 수 있습니다.");
  const result = InsightsSchema.parse(
    await new MetaClient().get(`${job.staged.adId}/insights`, {
      fields: "spend,impressions,clicks,actions,action_values,date_start,date_stop",
      date_preset: "last_7d",
    }),
  );
  const metrics = metricsFromResponse(result, job.currency);
  store.agent(job.id, "analysis", {
    status: metrics ? "completed" : "blocked",
    action: metrics
      ? "Meta 최근 7일 실제 응답으로 성과를 계산했습니다."
      : "Meta에 최근 7일 성과 데이터가 아직 없습니다.",
  });
  return store.change(job.id, (draft) => {
    draft.metrics = metrics;
  });
}
