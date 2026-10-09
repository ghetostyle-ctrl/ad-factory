import { buildFlowExport, type FlowExport } from "../shared/flow-mode";
import { FLOW_TEXT_KEYS, type FlowTextKey, type FlowTexts } from "../shared/flow-texts";
import type { Job } from "../shared/schema";
import { clipPrompt } from "../shared/veo-prompt";
import type { VeoClip } from "../shared/video-script";
import {
  INSTRUCTION_SECTIONS,
  type InstructionsSnapshot,
  loadInstructions,
  type SectionSpec,
  sectionOf,
} from "./instructions";

// Flow·Veo·이미지 프롬프트의 고정 문장(instructions/flow.md). 2026-10-07 전에는 shared/flow-info-prompts.ts·veo-prompt.ts·flow-mode.ts
// 와 서버 이미지 모듈의 상수였다. 브라우저 번들(shared)은 지시 파일을 읽을 수 없으므로 서버에서만 글을 채우고, 화면(src/FlowPanel.tsx)은
// 서버가 조립한 결과(GET /api/jobs/:id/videos/:n/flow-export, 산출물 flow-export-<n>.json)를 받는다.
// 기본 인자 loadInstructions() 는 호출마다 평가되므로 파일을 고치면 다음 생성·다음 내보내기부터 반영된다(재시작 불필요).
// 등록부(INSTRUCTION_SECTIONS)의 flow.md 절 집합과 shared/flow-texts.ts FLOW_TEXT_KEYS 는 같아야 한다(tests/instructions-flow.test.ts).
export const FLOW_SECTION_SPECS: readonly SectionSpec[] = INSTRUCTION_SECTIONS.filter(
  (item) => item.file === "flow.md",
);
export function flowTexts(snapshot: InstructionsSnapshot = loadInstructions()): FlowTexts {
  const texts: Partial<Record<FlowTextKey, string>> = {};
  for (const key of FLOW_TEXT_KEYS) texts[key] = sectionOf(snapshot, key);
  return texts as FlowTexts;
}
// Flow 내보내기(클립 단계 산출물·화면·CLI 가 같은 데이터를 본다).
export function flowExportFor(
  job: Job,
  number: number,
  texts: FlowTexts = flowTexts(),
): FlowExport {
  return buildFlowExport(job, number, texts);
}
// API 모드 Veo 요청 프롬프트(Flow 번들과 같은 문장).
export function clipPromptFor(
  clip: Pick<VeoClip, "prompt"> & Partial<Pick<VeoClip, "plan">>,
  options: { readonly liveAction?: boolean } = {},
  texts: FlowTexts = flowTexts(),
): string {
  return clipPrompt(clip, texts, options);
}
