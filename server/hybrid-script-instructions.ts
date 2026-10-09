import {
  fillSection,
  type InstructionsSnapshot,
  loadInstructions,
  sectionJson,
  sectionOf,
} from "./instructions";

// 혼합형 정책(hybrid_explainer_v1, 사용자 결정 2026-10-07) 프롬프트 조각. 본문은 instructions/hybrid.md(규칙)·examples.md(예시 JSON)에
// 있고 여기서는 절을 가져다 끼우기만 한다(어느 절이 어디에 쓰이는지는 instructions/README.md 표).
// 배경: 어제 완성본(8e3aeb37, immersive)은 11컷 중 7컷이 글자만 있는 빈 패널이었고 사람·상황·제품이 없었다. 그래서 고통·상황·결과·행동
// 비트는 실사(사람 등장), 메커니즘·기능·비교 비트만 3D 설명 세계로 간다. 설명 세계의 문법(R1~R9)은 레퍼런스(유튜브 쇼츠
// "신비한 건축사전 — 페트로나스 트윈타워", 장면 48개)에서 가져왔다. 규칙 검사는 shared/hybrid-script-rules.ts 가 같은 기준으로 한다(hard/soft).

// 설명 세계 문법 R1~R9(기획·대본·검토가 같은 문구를 쓴다).
export function explainerGrammar(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return sectionOf(snapshot, "EXPLAINER_GRAMMAR");
}
// 기획 프롬프트(장면 계획): 장면마다 실사인지 설명 세계인지 source 로 적고, 설명 장면은 explainerScene 을 채운다(끝에 문법 포함).
export function hybridPlanningRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return sectionOf(snapshot, "HYBRID_PLANNING_RULES");
}
// 대본 프롬프트 예시: 설명 장면 하나(과정)와 그 장면을 쓰는 이유 문장(콜아웃 없음). 모양만 보여 주며 숫자·낱말은 FACTS 에서 가져온다.
export function hybridExplainerExample(
  snapshot: InstructionsSnapshot = loadInstructions(),
): unknown {
  return sectionJson(snapshot, "HYBRID_EXPLAINER_EXAMPLE");
}
// 대본 프롬프트(혼합형 계약 H2·H3·H4·H5·H7·H8 + 레퍼런스 문법 + 예시 JSON).
export function hybridScriptRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return fillSection(sectionOf(snapshot, "HYBRID_SCRIPT_RULES"), {
    hybridExample: JSON.stringify(hybridExplainerExample(snapshot)),
  });
}
// 검토 프롬프트 규칙 1c: 실사 비트에 사람이 있는가, 설명 장면이 이름표 없이 이해되는가, 비교가 두 모형 나란히인가, 엔딩이 실사+제품인가.
export function hybridReviewRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return sectionOf(snapshot, "HYBRID_REVIEW_RULES");
}
