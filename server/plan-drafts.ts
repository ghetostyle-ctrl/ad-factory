import { z } from "zod";
import {
  type CreativePlan,
  CreativePlanResponseSchema,
  CreativePlanSchema,
} from "../shared/creative-plan";
import type { ModelResult } from "../shared/models";
import { latestPlanDraft } from "../shared/plan-recovery";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { StudioError } from "./errors";
import type { JobStore } from "./store";

export const PlanCandidateSchema = z.object({
  draftDigest: z.string(),
  plan: CreativePlanSchema,
});
export function nextPlanAttempt(job: Job): number {
  const name = latestPlanDraft(job);
  return name ? Number(name.split("-")[2]?.split(".")[0]) + 1 : 1;
}
export async function savePlanDraft(
  store: JobStore,
  job: Job,
  number: number,
  generated: ModelResult<z.infer<typeof CreativePlanResponseSchema>>,
  plan: CreativePlan,
): Promise<void> {
  const assets = new Artifacts(store);
  const content = JSON.stringify(generated.value);
  await assets.save(job.id, {
    name: "plan-draft-" + number + ".json",
    kind: "json",
    agentId: "creative",
    content,
    model: generated.model,
  });
  await assets.save(job.id, {
    name: "plan-candidate-" + number + ".json",
    kind: "json",
    agentId: "creative",
    content: JSON.stringify({ draftDigest: contentDigest(content), plan }),
    model: generated.model,
  });
}
export async function planRevisionFeedback(store: JobStore, job: Job): Promise<string[]> {
  const choice = job.automation?.planChoice;
  if (!choice || choice.action !== "replan") return [];
  const file = await new Artifacts(store).read(job.id, choice.draftName);
  const text = await file.text();
  if (contentDigest(text) !== choice.draftDigest)
    throw new StudioError(
      "plan_changed",
      "다시 기획할 초안이 변경되었습니다. 초안을 다시 확인하세요.",
    );
  const plan = CreativePlanResponseSchema.parse(JSON.parse(text));
  return [
    "사용자가 아래 초안을 바탕으로 다시 기획하기를 선택했습니다. 부족한 구성을 보완하고 정확한 제작 수량과 근거를 유지하세요.",
    ...choice.issues,
    JSON.stringify({ previousPlan: plan }),
  ];
}
export function acceptsComposition(job: Job, plan: CreativePlan): boolean {
  const choice = job.automation?.planChoice;
  return (
    choice?.action === "use" &&
    choice.planDigest === contentDigest(JSON.stringify(plan)) &&
    job.automation?.approvedPlanDigest === choice.planDigest
  );
}
