import { type InstructionsSnapshot, loadInstructions, sectionOf } from "./instructions";

// 한국어 카피 규칙(instructions/copy.md). 2026-10-07 전에는 shared/copy-polish.ts 의 상수였다. 브라우저 번들(shared)은 지시 파일을
// 읽을 수 없으므로 서버에서만 조립하고, 화면이 같은 글을 보여 줄 일이 생기면 GET /api/instructions 의 sections 로 받는다.
// 기본 인자 loadInstructions() 는 호출마다 평가되므로 파일을 고치면 다음 생성부터 반영된다(재시작 불필요).
// 교정·검토 단계에만 넣는다(초안 생성 프롬프트에는 넣지 않는다 — 빈도 규칙이 생성 단계에서는 금지 규칙으로 바뀌어 문장이 더 어색해진다).
export function koreanCopyPolishRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return sectionOf(snapshot, "KOREAN_COPY_POLISH_RULES");
}
// 짧은 호흡 리듬(legacy_rhythm, 사용자 결정 2026-10-06 "호흡이 길다·더 쫀득하게"): 생성·교정·검토가 같이 쓴다.
export function koreanCopyRhythmRules(snapshot: InstructionsSnapshot = loadInstructions()): string {
  return sectionOf(snapshot, "KOREAN_COPY_RHYTHM_RULES");
}
// natural_v1(immersive). 원문 상수는 끝에 줄바꿈 하나가 있었다(래퍼 안에서 빈 줄이 된다). 파일 절은 앞뒤 빈 줄을 지우므로 여기서 붙인다.
export function naturalCopyRhythmRules(
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  return `${sectionOf(snapshot, "NATURAL_COPY_RHYTHM_RULES")}\n`;
}
// <copy-rhythm-policy id="…"> 래퍼는 코드다(테스트·검토가 id 로 정책을 확인한다).
export function copyRhythmInstruction(
  immersive: boolean,
  snapshot: InstructionsSnapshot = loadInstructions(),
): string {
  const policy = immersive ? "natural_v1" : "legacy_rhythm";
  const rules = immersive ? naturalCopyRhythmRules(snapshot) : koreanCopyRhythmRules(snapshot);
  return `<copy-rhythm-policy id="${policy}">
${rules}
</copy-rhythm-policy>`;
}
