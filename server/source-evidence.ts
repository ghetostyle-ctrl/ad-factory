import type { CreativePlan } from "../shared/creative-plan";
import type { ProjectSource, ProjectSourceSnapshot } from "../shared/sources";
import { StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";

export function factualSources(snapshot: ProjectSourceSnapshot): ProjectSource[] {
  return snapshot.sources.filter(
    (source) =>
      ["product_fact", "offer"].includes(source.kind) &&
      source.evidence === "observed" &&
      source.contentStatus === "content" &&
      source.status === "eligible",
  );
}
export function validatePlanEvidence(
  plan: CreativePlan,
  snapshot: ProjectSourceSnapshot,
  expectedCount = 3,
): void {
  if (plan.sourceDigest !== snapshot.digest)
    throw new StudioError("source_digest", "기획의 자료 스냅샷이 일치하지 않습니다.");
  const pack = evidencePack(snapshot);
  const facts = pack.facts;
  if (JSON.stringify(plan.sourceCoverage) !== JSON.stringify(pack.coverage))
    throw new StudioError(
      "source_coverage",
      "기획에 사용한 자료 범위가 고정 자료와 일치하지 않습니다.",
    );
  if (
    plan.referenceAnalyses.length !== pack.references.length ||
    new Set(plan.referenceAnalyses.map((item) => item.sourceId)).size !== pack.references.length ||
    plan.referenceAnalyses.some(
      (item) => !pack.references.some((source) => source.id === item.sourceId),
    )
  )
    throw new StudioError(
      "reference",
      "레퍼런스 관찰이 이번 작업의 본문 자료 범위와 일치하지 않습니다.",
    );
  if (!facts.length)
    throw new StudioError("source_facts", "확인된 제품 사실 또는 오퍼 본문 자료가 필요합니다.");
  const ids = new Set(plan.hypotheses.map((item) => item.id));
  if (
    plan.hypotheses.length !== expectedCount ||
    ids.size !== expectedCount ||
    new Set(plan.hypotheses.map((item) => item.angle)).size < Math.min(expectedCount, 3)
  )
    throw new StudioError("diversity", `서로 다른 고객 가설 ${expectedCount}개가 필요합니다.`);
  for (const field of [
    "targetAudience",
    "customerSituation",
    "problem",
    "message",
    "visualMechanism",
    "hook",
  ] as const)
    if (
      new Set(
        plan.hypotheses.map((item) =>
          item[field].normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
        ),
      ).size !== expectedCount
    )
      throw new StudioError(
        "diversity",
        "타깃 오디언스·고객 상황·문제·메시지·시각 구성·훅이 중복됩니다.",
      );
  for (const hypothesis of plan.hypotheses) {
    if (pack.references.length > 0 && hypothesis.referenceSourceIds.length === 0)
      throw new StudioError(
        "reference",
        "레퍼런스가 있는 프로젝트에서는 광고안마다 참고한 광고 구조를 표시해야 합니다.",
      );
    for (const id of hypothesis.referenceSourceIds)
      if (
        !plan.referenceAnalyses.some(
          (item) => item.sourceId === id && item.observedStructure.length > 0,
        )
      )
        throw new StudioError("reference", "본문을 관찰한 레퍼런스만 제작에 참고할 수 있습니다.");
  }
}
