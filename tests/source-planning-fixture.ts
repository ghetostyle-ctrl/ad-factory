import { rmSync } from "node:fs";
import { z } from "zod";
import { ProjectStore } from "../server/project-store";
import { SourcePlanner } from "../server/source-planning";
import { CreativePlanResponseSchema, PlanCritiqueSchema } from "../shared/creative-plan";
import type { Strategy } from "../shared/planning";
import { CreateSourceSchema } from "../shared/sources";
import { creative, providerStore, response } from "./provider-fixtures";

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
      decisionRole: (["need_awareness", "comparison", "final_decision"] as const)[index],
      proofShown: sourceFact.content,
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
      name: z.enum(["reference_structure", "source_creative_plan", "creative_plan_critique"]),
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
          return response(replies.plan);
        case "creative_plan_critique":
          return response(replies.critique);
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
