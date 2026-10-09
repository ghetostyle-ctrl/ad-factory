import type { ProjectSource, ProjectSourceSnapshot } from "../shared/sources";

// 1판: 타겟·조각 이전 기획. 레퍼런스는 등록 순서대로 앞 5개, 후기는 4개까지(이미 만든 기획의 검증에 그대로 쓴다).
export const evidenceLimitsV1 = {
  maxFactSources: 8,
  maxFactCharacters: 24000,
  maxReferenceSources: 5,
  maxReferenceCharacters: 8000,
  maxVoiceSources: 4,
  maxVoiceCharacters: 8000,
} as const;
// 2판(CREATIVE-PLANNING-DESIGN.md 7절): 레퍼런스는 같은 소재의 변형끼리 묶어 변형이 많은 묶음부터 대표 1개씩,
// 후기는 장면 조각을 최대한 많이 뽑도록 12개까지 쓴다.
export const evidenceLimits = {
  ...evidenceLimitsV1,
  maxVoiceSources: 12,
  maxVoiceCharacters: 12000,
} as const;
export type EvidenceVersion = 1 | 2;

function copySignature(source: ProjectSource): string {
  const data = source.referenceData;
  const text = data
    ? [...data.headlines, ...data.bodies].join(" ") || source.content
    : source.content;
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 200);
}
/** 문구가 같은 레퍼런스(같은 소재의 변형)를 묶는다. 변형이 많은 묶음부터, 같으면 먼저 등록된 순서. */
export function referenceGroups(sources: readonly ProjectSource[]) {
  const groups = new Map<string, ProjectSource[]>();
  for (const source of sources) {
    if (source.kind !== "reference") continue;
    const key = copySignature(source) || source.id;
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  return [...groups.values()]
    .map((members, order) => ({ members, order }))
    .sort((left, right) => right.members.length - left.members.length || left.order - right.order)
    .map(({ members }) => ({
      memberIds: members.map((source) => source.id),
      variantCount: members.length,
      members,
    }));
}
export function evidencePack(snapshot: ProjectSourceSnapshot, version: EvidenceVersion = 2) {
  const limits = version === 1 ? evidenceLimitsV1 : evidenceLimits;
  const facts: ProjectSource[] = [];
  const references: ProjectSource[] = [];
  const voices: ProjectSource[] = [];
  const excluded: { sourceId: string; reason: string }[] = [];
  let factCharacters = 0;
  let voiceCharacters = 0;
  for (const source of snapshot.sources) {
    // 2판 레퍼런스는 아래에서 묶음 단위로 고른다.
    if (version === 2 && source.kind === "reference") continue;
    let reason: string | null = null;
    if (source.status !== "eligible" || source.contentStatus !== "content")
      reason = "사용 가능한 본문이 없습니다. URL만으로 내용을 추정하지 않습니다.";
    else if (source.kind === "reference") {
      if (
        references.length >= limits.maxReferenceSources ||
        source.content.length > limits.maxReferenceCharacters
      )
        reason = "레퍼런스 분석 한도(5개, 각 8,000자)를 넘어 이번 기획에서 제외했습니다.";
      else references.push(source);
    } else if (source.kind === "review" && source.evidence === "observed") {
      if (
        voices.length >= limits.maxVoiceSources ||
        voiceCharacters + source.content.length > limits.maxVoiceCharacters
      )
        reason = `고객 표현 자료 한도(${limits.maxVoiceSources}개, 총 ${limits.maxVoiceCharacters.toLocaleString()}자)를 넘어 이번 기획에서 제외했습니다.`;
      else {
        voices.push(source);
        voiceCharacters += source.content.length;
      }
    } else if (!["product_fact", "offer"].includes(source.kind) || source.evidence !== "observed")
      reason = "가설 자료는 제품 주장의 증거로 사용하지 않습니다.";
    else if (
      facts.length >= limits.maxFactSources ||
      factCharacters + source.content.length > limits.maxFactCharacters
    )
      reason = "제품 근거 한도(8개, 총 24,000자)를 넘어 이번 기획에서 제외했습니다.";
    else {
      facts.push(source);
      factCharacters += source.content.length;
    }
    if (reason) excluded.push({ sourceId: source.id, reason });
  }
  const groups: { representativeId: string; memberIds: string[]; variantCount: number }[] = [];
  if (version === 2)
    for (const group of referenceGroups(snapshot.sources)) {
      const usable = group.members.filter(
        (source) =>
          source.status === "eligible" &&
          source.contentStatus === "content" &&
          source.content.length <= limits.maxReferenceCharacters,
      );
      const representative = references.length < limits.maxReferenceSources ? usable[0] : undefined;
      if (representative) {
        references.push(representative);
        groups.push({
          representativeId: representative.id,
          memberIds: group.memberIds,
          variantCount: group.variantCount,
        });
      }
      for (const source of group.members)
        if (source !== representative)
          excluded.push({
            sourceId: source.id,
            reason:
              source.status !== "eligible" || source.contentStatus !== "content"
                ? "사용 가능한 본문이 없습니다. URL만으로 내용을 추정하지 않습니다."
                : representative
                  ? `같은 소재의 변형 ${group.variantCount}개 중 대표만 분석했습니다.`
                  : "레퍼런스 묶음 한도(대표 5개)를 넘어 이번 기획에서 제외했습니다.",
          });
    }
  return {
    facts,
    references,
    voices,
    referenceGroups: groups,
    coverage: {
      factsUsed: facts.map((source) => source.id),
      referencesUsed: references.map((source) => source.id),
      voicesUsed: voices.map((source) => source.id),
      excluded,
      limits,
    },
  };
}
