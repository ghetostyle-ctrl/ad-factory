import type { CreativePlan } from "../shared/creative-plan";
import type { Job } from "../shared/schema";
import { type InstructionsSnapshot, loadInstructions, sectionOf } from "./instructions";

export function videoPlanningContext(
  job: Job,
  hypothesis: CreativePlan["hypotheses"][number],
  snapshot: InstructionsSnapshot = loadInstructions(),
) {
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
  const target = job.creativePlan?.targets?.find((item) => item.id === hypothesis.targetId) ?? null;
  const fragments = target
    ? (job.creativePlan?.fragments ?? []).filter((item) => target.fragmentIds.includes(item.id))
    : [];
  return {
    // 광고안이 정한 타겟 1명과 그 타겟의 장면 조각(원문 표현 포함). 영상은 이 타겟에서 벗어나지 않는다.
    target: target ? { ...target, fragments } : null,
    // 기획이 장면별 화면 소스를 실제로 가진 것에 맞춰 정하도록 알려 준다. 자료의 첨부 이미지는
    // 아직 제작 단계에 전달되지 않으므로, 실제 소재로 쓸 수 있는 것은 프로젝트 촬영본뿐이다.
    visualAssets: {
      projectClips: (job.productionSourceSnapshot?.assets ?? []).map((asset) => ({
        id: asset.id,
        title: asset.title,
        durationSec: asset.durationSec,
      })),
      realProductPhotos: 0,
      // 안내 문장은 planning.md PLANNING_CONTEXT_ASSET_NOTE(기획·카피 교정·대본 생성·검토 DATA 가 같이 쓴다).
      note: sectionOf(snapshot, "PLANNING_CONTEXT_ASSET_NOTE"),
    },
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
      .map((source) => ({
        id: source.id,
        title: source.title,
        content: source.content,
        reviewOf: source.reviewOf ?? "unknown",
      })),
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
