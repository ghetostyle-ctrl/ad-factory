import { rmSync } from "node:fs";
import { z } from "zod";
import { ProjectStore } from "../server/project-store";
import { SourcePlanner } from "../server/source-planning";
import { CreativePlanResponseSchema, PlanCritiqueSchema } from "../shared/creative-plan";
import type { Strategy } from "../shared/planning";
import { CreateSourceSchema } from "../shared/sources";
import { creative, passReview, providerStore, response } from "./provider-fixtures";

export const sourceFact = CreateSourceSchema.parse({
  kind: "product_fact",
  title: "Verified capacity",
  content: "Capacity: 500 ml.",
});
export const sourceReference = CreateSourceSchema.parse({
  kind: "reference",
  title: "Reference sequence",
  content: "Question, demonstration, then invitation.",
});
export const sourceStrategy: Strategy = {
  positioning: "Carry capacity",
  audienceInsight: "Adult shoppers comparing capacity",
  valueProposition: sourceFact.content,
  messageAngles: ["problem_solution", "usage_context", "objection_answer"],
  risks: ["Customer situations are hypotheses"],
  measurementPlan: "Collect ad-level observations",
};
export function sourcePlanResponse(sourceId: string, referenceSourceIds: readonly string[] = []) {
  const situations = ["Desk hydration", "Outdoor packing", "Comparing capacities"];
  const audiences = ["Desk workers", "Day hikers", "Capacity comparison shoppers"];
  const problems = ["Interruptions", "Limited packing space", "Uncertain volume"];
  const messages = [
    "Plan a desk refill",
    "Allocate a bag compartment",
    "Compare measured capacity",
  ];
  const mechanisms = ["Desk schedule diagram", "Concept-art bag layout", "Volume scale graphic"];
  const questions = [
    ["buying_reason", "Will it last my whole workday?"],
    ["decision_criterion", "Does it fit my day bag?"],
    ["hesitation", "Is the capacity really as stated?"],
  ] as const;
  return CreativePlanResponseSchema.parse({
    // 시장 조각은 근거 없는 추정(inferred)으로 둔다: 이 픽스처 프로젝트에는 후기가 없고, 레퍼런스 ID는 호출마다 다르다.
    fragments: situations.map((situation, index) => ({
      id: `f${index + 1}`,
      situation,
      desire: `Keep ${messages[index]?.toLowerCase()} effortless`,
      pain: problems[index],
      // t1 조각은 문제를 모르는 고객(TOFU 가능), t2·t3 조각은 현재 대안이 있어 문제를 안다(MOFU 이상).
      alternative: index === 0 ? "" : "A bigger cup",
      failedAttempt: "",
      believedCause: "",
      hesitation: "Is the capacity really as stated?",
      quote: "",
      origin: "inferred",
      sourceIds: [],
    })),
    targets: audiences.map((label, index) => ({
      id: `t${index + 1}`,
      label,
      experience: index === 0 ? "tried_failed" : "first_time",
      fragmentIds: [`f${index + 1}`],
      fit: {
        painStrength: 4,
        productAnswer: 5 - index,
        distinctness: 4,
        reason: `${problems[index]} is answered directly by the measured capacity`,
      },
    })),
    customerQuestions: questions.map(([kind, question], index) => ({
      id: `question-${index}`,
      kind,
      question,
      basis: "product_fact",
      sourceIds: [sourceId],
      proofNeeded: sourceFact.content,
      answeredByReferences: [],
    })),
    hypotheses: ["problem_solution", "usage_context", "objection_answer"].map((angle, index) => ({
      id: `concept-${index}`,
      angle,
      customerQuestionId: `question-${index}`,
      // 오퍼·후기 자료가 없는 프로젝트라 BOFU 소재는 만들 수 없다: TOFU 1 + MOFU 2.
      decisionRole: (["need_awareness", "comparison", "comparison"] as const)[index],
      proofShown: sourceFact.content,
      signals: {
        format: (["problem_empathy", "mechanism_explainer", "mechanism_explainer"] as const)[index],
        avatarCallout: `${audiences[index]} who keep running out mid-task`,
        painPoint: `${problems[index]} even after trying a bigger cup`,
        mechanism: {
          mode: (["unique_mechanism", "cause_reframe", "unique_mechanism"] as const)[index],
          statement: sourceFact.content,
        },
        offer: { type: "none" as const, statement: "" },
      },
      cardSlides:
        index === 0
          ? []
          : [1, 2].map((step) => ({
              headline: `${messages[index]} ${step}`,
              body: sourceFact.content,
              imagePrompt: `Card ${step}: ${mechanisms[index]} with the text "${sourceFact.content}"`,
            })),
      targetAudience: audiences[index],
      targetReason: `Verified capacity and observed reference structure for ${audiences[index]}`,
      customerSituation: situations[index],
      problem: problems[index],
      message: messages[index],
      hook: messages[index],
      difference: mechanisms[index],
      visualMechanism: mechanisms[index],
      claimCitations: [{ sourceId, quote: sourceFact.content }],
      referenceSourceIds,
      targetId: `t${index + 1}`,
      entryPoint: (["pain", "alternative", "doubt"] as const)[index],
      chain: {
        pain: { content: problems[index], basis: "inferred" as const, sourceIds: [] },
        believedCause: { content: "", basis: "inferred" as const, sourceIds: [] },
        realCause: {
          content: "Refill timing, not cup size",
          basis: "general_knowledge" as const,
          sourceIds: [],
        },
        requirement: {
          content: "It must hold a full session without a refill",
          basis: "inferred" as const,
          sourceIds: [],
        },
        productFact: {
          content: sourceFact.content,
          basis: "product_fact" as const,
          sourceIds: [sourceId],
        },
        reasonWhy: {
          // ⑥은 ⑤에 없는 제품 세부(여기서는 용량 숫자)를 더해야 한다.
          content: `Because the bottle holds a measured 500ml, 50 ml more than a cup`,
          basis: "product_fact" as const,
          sourceIds: [sourceId],
        },
        outcome: {
          content: `${messages[index]} with no ${(problems[index] ?? "").toLowerCase()}`,
          basis: "inferred" as const,
          sourceIds: [],
        },
        exclusivity: "product_specific" as const,
      },
      solutionPath:
        index === 0
          ? {
              flow: "cause_reframe" as const,
              steps: [
                {
                  stage: "past_attempt" as const,
                  content: "Tried a bigger cup",
                  basis: "inferred" as const,
                  sourceIds: [],
                },
                {
                  stage: "real_cause" as const,
                  content: "Refill timing, not cup size",
                  basis: "general_knowledge" as const,
                  sourceIds: [],
                },
                {
                  stage: "mechanism" as const,
                  content: sourceFact.content,
                  basis: "product_fact" as const,
                  sourceIds: [sourceId],
                },
                {
                  stage: "outcome" as const,
                  content: "No mid-task refills",
                  basis: "inferred" as const,
                  sourceIds: [],
                },
              ],
            }
          : {
              flow: "criteria_first" as const,
              steps: [
                {
                  stage: "criteria" as const,
                  content: "Check measured capacity",
                  basis: "general_knowledge" as const,
                  sourceIds: [],
                },
                {
                  stage: "mechanism" as const,
                  content: sourceFact.content,
                  basis: "product_fact" as const,
                  sourceIds: [sourceId],
                },
                {
                  stage: "verification" as const,
                  content: "Read the stated capacity",
                  basis: "product_fact" as const,
                  sourceIds: [sourceId],
                },
                {
                  stage: "outcome" as const,
                  content: "Confident choice",
                  basis: "inferred" as const,
                  sourceIds: [],
                },
              ],
            },
      creative: {
        ...creative,
        concept: situations[index],
        headline: messages[index],
        primaryText: sourceFact.content,
        imagePrompt: `Concept art: ${mechanisms[index]}`,
      },
    })),
    diversityRationale: "Distinct situations, problems and mechanisms",
    limitations: ["Untested customer hypotheses"],
  });
}
const RequestSchema = z.object({
  model: z.string(),
  input: z.string(),
  text: z.object({
    format: z.object({
      name: z.enum([
        "reference_structure",
        "source_creative_plan",
        "creative_plan_critique",
        // 렌더 파이프라인의 시작 이미지·클립 프레임 비전 검토(통과 응답 고정)
        "start_image_review",
        "clip_review",
        // 영상 대본 AI 품질 검토(통과 응답 고정)
        "video_script_review",
      ]),
    }),
  }),
});
export function planningFixture() {
  const store = providerStore();
  const library = new ProjectStore(store.db);
  const project = library.createProject({ name: "Planning fixture", description: "" });
  const fact = library.addSource(project.id, sourceFact);
  const initialJob = store.list()[0];
  if (!initialJob?.executionModels) throw new TypeError("Fixture requires execution models");
  const jobId = initialJob.id;
  const requests: z.infer<typeof RequestSchema>[] = [];
  const planReplies: z.infer<typeof CreativePlanResponseSchema>[] = [];
  const replies = {
    plan: sourcePlanResponse(fact.id),
    critique: PlanCritiqueSchema.parse({ status: "pass", issues: [] }),
    reference: {
      observedStructure: ["Question precedes demonstration"],
      inferences: ["A possible explanation sequence"],
      unknowns: ["Pixels, sound, performance and causal effects are unobserved"],
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = RequestSchema.parse(await request.json());
      requests.push(parsed);
      const name = parsed.text.format.name;
      switch (name) {
        case "reference_structure":
          return response(replies.reference);
        case "source_creative_plan":
          return response(planReplies.shift() ?? replies.plan);
        case "creative_plan_critique":
          return response(replies.critique);
        case "start_image_review":
        case "clip_review":
          return response(passReview);
        case "video_script_review":
          return response({ status: "pass", summary: "픽스처 대본 검토 통과", issues: [] });
        default:
          return name satisfies never;
      }
    },
  });
  const connection = {
    apiKey: "local-fixture-key",
    baseUrl: `http://127.0.0.1:${server.port}/v1/`,
  };
  return {
    store,
    library,
    project,
    fact,
    requests,
    planReplies,
    replies,
    connection,
    planner: new SourcePlanner(store, connection),
    job() {
      const references = library
        .snapshot(project.id)
        .sources.filter(
          (source) => source.kind === "reference" && source.contentStatus === "content",
        )
        .map((source) => source.id);
      const firstReference = references[0];
      if (firstReference)
        replies.plan.hypotheses = replies.plan.hypotheses.map((hypothesis) => ({
          ...hypothesis,
          referenceSourceIds: hypothesis.referenceSourceIds.length
            ? hypothesis.referenceSourceIds
            : [firstReference],
        }));
      return store.change(jobId, (draft) => {
        draft.projectId = project.id;
        draft.sourceSnapshot = library.snapshot(project.id);
      });
    },
    close() {
      server.stop(true);
      store.close();
      rmSync(store.root, { recursive: true, force: true });
    },
  };
}
