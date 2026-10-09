import { type InstructionsSnapshot, loadInstructions, sectionOf } from "./instructions";

// 입체 설명 정책(immersive_explanations_v1, 2026-10-06) 프롬프트 조각. 본문은 instructions/immersive.md 에 있다(저장된 기획·대본의
// 재현을 위해 2026-10-06 문구를 보존한다). 설명 설계(entities·beats·annotations) 규칙도 같은 파일이다.

// 기획 프롬프트: scenePlan 마다 구조화된 explanation(설명 설계)을 적는 규칙.
export function explanationPlanningRules(
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  return sectionOf(snapshot, "EXPLANATION_PLANNING_RULES");
}
// 대본·검토 프롬프트: 설명 설계를 infoClip.explanation·actionSync·narrationCue 로 옮기는 규칙.
export function explanationScriptRules(
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  return sectionOf(snapshot, "EXPLANATION_SCRIPT_RULES");
}
// 입체 설명 제작 계약(끝에 설명 설계 규칙 포함). 원문 상수는 끝에 줄바꿈 하나가 있었다(대본·검토 프롬프트에서 빈 줄이 된다).
// 파일 절은 앞뒤 빈 줄을 지우므로 여기서 붙인다.
export function immersiveScriptRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return `${sectionOf(snapshot, "IMMERSIVE_SCRIPT_RULES")}\n`;
}
