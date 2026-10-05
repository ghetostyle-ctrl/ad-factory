import type { CreativePlan } from "../shared/creative-plan";
import type { Job } from "../shared/schema";

export function videoPlanningContext(job: Job, hypothesis: CreativePlan["hypotheses"][number]) {
  const sources = (job.sourceSnapshot?.sources ?? []).filter(
    (source) => source.status === "eligible" && source.contentStatus === "content",
  );
  const customerQuestion =
    job.creativePlan?.customerQuestions.find((item) => item.id === hypothesis.customerQuestionId) ??
    null;
  const referenceIds = new Set([
    ...hypothesis.referenceSourceIds,
    ...(customerQuestion?.answeredByReferences ?? []),
  ]);
  return {
    brief: {
      name: job.name,
      productDescription: job.productDescription,
      audience: job.audience,
      objective: job.objective,
    },
    hypothesis,
    customerQuestion,
    facts: sources
      .filter(
        (source) =>
          source.evidence === "observed" && ["product_fact", "offer"].includes(source.kind),
      )
      .map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        content: source.content,
      })),
    voices: sources
      .filter((source) => source.evidence === "observed" && source.kind === "review")
      .map((source) => ({ id: source.id, title: source.title, content: source.content })),
    references: sources
      .filter((source) => source.kind === "reference" && referenceIds.has(source.id))
      .map((source) => ({
        sourceId: source.id,
        title: source.title,
        content: source.content,
        analysis:
          job.creativePlan?.referenceAnalyses.find((item) => item.sourceId === source.id) ?? null,
        referenceData: source.referenceData ?? null,
      })),
  };
}
