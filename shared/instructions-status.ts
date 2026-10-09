import { z } from "zod";

// 지시 파일 상태(GET /api/instructions, 연결 설정 창의 '지시 파일' 카드). 읽기 전용이다.
// 절 본문은 보내지 않고 절마다 글자 수만 보낸다(본문은 저장소의 instructions/*.md 에서 직접 읽는다).
const DIGEST = /^[0-9a-f]{64}$/u;
export const DIGEST_SHORT_LENGTH = 8;
export const InstructionsFileStatusSchema = z.object({
  name: z.string().min(1),
  // 파일 내용의 sha256
  digest: z.string().regex(DIGEST),
  size: z.number().int().nonnegative(),
  // 파일 수정 시각(ISO)
  modifiedAt: z.string().min(1),
});
export type InstructionsFileStatus = z.infer<typeof InstructionsFileStatusSchema>;
export const InstructionsSectionStatusSchema = z.object({
  file: z.string().min(1),
  key: z.string().min(1),
  // 치환이 끝난 절 본문의 글자 수(본문 자체는 보내지 않는다)
  chars: z.number().int().nonnegative(),
  // 호출 시점에 코드가 채우는 소문자 토큰
  runtime: z.array(z.string()).default([]),
  json: z.boolean().default(false),
});
export type InstructionsSectionStatus = z.infer<typeof InstructionsSectionStatusSchema>;
// thresholds.json 항목 그대로(값·허용 범위·설명). 카드가 "값 (min–max) — 설명" 으로 그린다.
export const InstructionsThresholdDetailSchema = z.object({
  value: z.number(),
  min: z.number(),
  max: z.number(),
  description: z.string(),
});
export type InstructionsThresholdDetail = z.infer<typeof InstructionsThresholdDetailSchema>;
export const InstructionsStatusSchema = z.object({
  // 폴더 이름(절대 경로는 보내지 않는다)
  folder: z.string().min(1),
  // 쓸 수 있는 성공본이 있는가(마지막 읽기가 실패해도 이전 성공본이 있으면 true, warnings 에 이유)
  loaded: z.boolean(),
  // 모든 파일의 sha256(성공본 기준). 산출물·이벤트에는 앞 8자리를 적는다.
  digest: z.string().regex(DIGEST).nullable(),
  loadedAt: z.string().nullable(),
  // 이 상태를 계산한 시각
  checkedAt: z.string().min(1),
  files: z.array(InstructionsFileStatusSchema),
  sections: z.array(InstructionsSectionStatusSchema),
  thresholds: z.record(z.string(), z.number()),
  // 같은 임계값의 허용 범위·설명(예전 서버 응답에는 없을 수 있어 기본 {}).
  thresholdDetails: z.record(z.string(), InstructionsThresholdDetailSchema).default({}),
  // 한국어 원인. loaded=true 이면 "마지막 성공본을 그대로 씁니다" 경고, loaded=false 이면 첫 로드 실패 원인.
  warnings: z.array(z.string()),
});
export type InstructionsStatus = z.infer<typeof InstructionsStatusSchema>;
export function shortDigest(digest: string): string {
  return digest.slice(0, DIGEST_SHORT_LENGTH);
}
