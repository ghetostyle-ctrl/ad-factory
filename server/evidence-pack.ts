import type { ProjectSource, ProjectSourceSnapshot } from "../shared/sources";

export const evidenceLimits = {
  maxFactSources: 8,
  maxFactCharacters: 24000,
  maxReferenceSources: 5,
  maxReferenceCharacters: 8000,
  maxVoiceSources: 4,
  maxVoiceCharacters: 8000,
} as const;
export function evidencePack(snapshot: ProjectSourceSnapshot) {
  const facts: ProjectSource[] = [];
  const references: ProjectSource[] = [];
  const voices: ProjectSource[] = [];
  const excluded: { sourceId: string; reason: string }[] = [];
  let factCharacters = 0;
  let voiceCharacters = 0;
  for (const source of snapshot.sources) {
    let reason: string | null = null;
    if (source.status !== "eligible" || source.contentStatus !== "content")
      reason = "사용 가능한 본문이 없습니다. URL만으로 내용을 추정하지 않습니다.";
    else if (source.kind === "reference") {
      if (
        references.length >= evidenceLimits.maxReferenceSources ||
        source.content.length > evidenceLimits.maxReferenceCharacters
      )
        reason = "레퍼런스 분석 한도(5개, 각 8,000자)를 넘어 이번 기획에서 제외했습니다.";
      else references.push(source);
    } else if (source.kind === "review" && source.evidence === "observed") {
      if (
        voices.length >= evidenceLimits.maxVoiceSources ||
        voiceCharacters + source.content.length > evidenceLimits.maxVoiceCharacters
      )
        reason = "고객 표현 자료 한도(4개, 총 8,000자)를 넘어 이번 기획에서 제외했습니다.";
      else {
        voices.push(source);
        voiceCharacters += source.content.length;
      }
    } else if (!["product_fact", "offer"].includes(source.kind) || source.evidence !== "observed")
      reason = "가설 자료는 제품 주장의 증거로 사용하지 않습니다.";
    else if (
      facts.length >= evidenceLimits.maxFactSources ||
      factCharacters + source.content.length > evidenceLimits.maxFactCharacters
    )
      reason = "제품 근거 한도(8개, 총 24,000자)를 넘어 이번 기획에서 제외했습니다.";
    else {
      facts.push(source);
      factCharacters += source.content.length;
    }
    if (reason) excluded.push({ sourceId: source.id, reason });
  }
  return {
    facts,
    references,
    voices,
    coverage: {
      factsUsed: facts.map((source) => source.id),
      referencesUsed: references.map((source) => source.id),
      voicesUsed: voices.map((source) => source.id),
      excluded,
      limits: evidenceLimits,
    },
  };
}
