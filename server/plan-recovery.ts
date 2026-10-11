import {
  type CreativePlan,
  CreativePlanResponseSchema,
  CreativePlanSchema,
} from "../shared/creative-plan";
import {
  canReviewPlan,
  latestPlanDraft,
  type PlanChoiceRequest,
  type PlanRecovery,
} from "../shared/plan-recovery";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { contentDigest, scopeDigest } from "./automation-guard";
import { StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { planCompositionWarnings } from "./plan-composition";
import { PlanCandidateSchema } from "./plan-drafts";
import { validatePlanEvidence } from "./source-evidence";
import { SourcePlanner } from "./source-planning";
import type { JobStore } from "./store";

export class PlanRecoveryService {
  constructor(readonly store: JobStore) {}
  private eligible(id: string): Job {
    const job = this.store.get(id);
    if (!canReviewPlan(job))
      throw new StudioError("plan_state", "현재 작업은 기획 선택 대기 상태가 아닙니다.");
    if (!job.automation || job.automation.scopeDigest !== scopeDigest(job, job.automation.policy))
      throw new StudioError("scope_changed", "승인한 자료·모델·제작 범위가 변경됐습니다.");
    return job;
  }
  private async candidate(id: string) {
    const job = this.eligible(id);
    const name = latestPlanDraft(job);
    const snapshot = job.sourceSnapshot;
    if (!name || !snapshot)
      throw new StudioError("plan_missing", "저장된 기획 초안이나 고정 자료가 없습니다.");
    const assets = new Artifacts(this.store);
    const text = await (await assets.read(id, name)).text();
    const value = CreativePlanResponseSchema.parse(JSON.parse(text));
    const digest = contentDigest(text);
    const artifact = job.artifacts.find((item) => item.name === name);
    const candidateName = name.replace("plan-draft-", "plan-candidate-");
    let plan: CreativePlan | null = null;
    const blockingIssues: string[] = [];
    try {
      if (job.artifacts.some((item) => item.name === candidateName)) {
        const saved = PlanCandidateSchema.parse(
          await (await assets.read(id, candidateName)).json(),
        );
        if (saved.draftDigest !== digest)
          throw new StudioError("plan_changed", "저장된 초안과 복원 정보가 일치하지 않습니다.");
        plan = saved.plan;
      } else {
        plan = CreativePlanSchema.parse(new SourcePlanner(this.store).restoreDraft(job, value));
      }
      const expected =
        job.automation?.policy.mode === "creative" ? (job.automation.policy.imageCount ?? 3) : 3;
      validatePlanEvidence(plan, snapshot, expected, true);
    } catch (error) {
      if (!(error instanceof StudioError)) throw error;
      blockingIssues.push(error.message);
    }
    const expected =
      job.automation?.policy.mode === "creative" ? (job.automation.policy.imageCount ?? 3) : 3;
    const warnings = plan
      ? planCompositionWarnings(plan, evidencePack(snapshot, plan.targets ? 2 : 1), expected)
      : [];
    const stageCounts = { need_awareness: 0, comparison: 0, final_decision: 0 };
    for (const hypothesis of value.hypotheses) stageCounts[hypothesis.decisionRole]++;
    const view: PlanRecovery = {
      draftName: name,
      draftDigest: digest,
      canUse: plan !== null && blockingIssues.length === 0,
      warnings,
      blockingIssues,
      stageCounts,
      hypotheses: value.hypotheses.map(({ id: hypothesisId, creative }) => ({
        id: hypothesisId,
        creative,
      })),
    };
    return { job, plan, model: artifact?.model ?? null, view };
  }
  async inspect(id: string): Promise<PlanRecovery | null> {
    if (!canReviewPlan(this.store.get(id))) return null;
    return (await this.candidate(id)).view;
  }
  async choose(id: string, input: PlanChoiceRequest): Promise<void> {
    const current = await this.candidate(id);
    if (
      current.view.draftName !== input.draftName ||
      current.view.draftDigest !== input.draftDigest
    )
      throw new StudioError(
        "plan_changed",
        "새 초안이 저장됐거나 내용이 변경됐습니다. 다시 확인한 뒤 선택하세요.",
      );
    const issues = [...current.view.warnings, ...current.view.blockingIssues];
    switch (input.action) {
      case "use": {
        const plan = current.plan;
        if (!plan || !current.view.canUse)
          throw new StudioError(
            "plan_invalid",
            "자료·구조 오류를 먼저 수정해야 합니다. 다시 기획하기를 선택하세요.",
          );
        const assets = new Artifacts(this.store);
        await assets.save(id, {
          name: "source-plan-auto.json",
          kind: "json",
          agentId: "creative",
          content: JSON.stringify(plan),
          ...(current.model ? { model: current.model } : {}),
        });
        this.eligible(id);
        const planDigest = contentDigest(JSON.stringify(plan));
        this.store.change(id, (job) => {
          if (!job.automation) throw new StudioError("plan_state", "자동 제작 상태가 없습니다.");
          job.creativePlan = plan;
          job.automation.approvedPlanDigest = planDigest;
          job.automation.planChoice = { ...input, planDigest, issues };
          job.creativeVariants = plan.hypotheses.map((hypothesis) => ({
            id: hypothesis.id,
            creative: hypothesis.creative,
            imageAttempts: 0,
            approvedImageId: null,
            approvedImageDigest: null,
            approvedCreativeDigest: null,
            reviewStatus: "pending",
            cardImageIds: [],
          }));
          this.store.event(
            job,
            "creative",
            "warning",
            "사용자가 현재 기획으로 제작을 선택했습니다. 남은 구성 경고: " +
              (issues.join(" ") || "없음"),
          );
        });
        return;
      }
      case "replan":
        this.eligible(id);
        this.store.change(id, (job) => {
          if (!job.automation) throw new StudioError("plan_state", "자동 제작 상태가 없습니다.");
          job.automation.planChoice = { ...input, planDigest: null, issues };
          this.store.event(
            job,
            "creative",
            "info",
            "사용자가 다시 기획하기를 선택했습니다. 기존 초안과 부족한 구성을 다음 기획에 전달합니다.",
          );
        });
        return;
      default:
        return input.action satisfies never;
    }
  }
}
