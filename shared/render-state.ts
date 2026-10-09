import { z } from "zod";
import {
  INFO_CLIP_IDS,
  StillIdSchema,
  VEO_CLIP_IDS,
  VideoScriptReviewIssueSchema,
} from "./video-script";

// 영상 1편의 제작 상태. 산출물 이름에서 도출할 수 있는 것은 저장하지 않고,
// 도출할 수 없는 것(Veo 핸들·pendingSince·시작 이미지 digest·확정 보이스·타임라인 digest)만 둔다.
// 모든 필드에 기본값을 두어 renders 가 없던 기존 SQLite 행도 그대로 읽힌다.
// 문장 1개의 합성 결과. 매니페스트(voice-<n>.json)의 한 줄이자, 합성 도중 저장되는 문장별 기록의 기본형이다.
export const VoiceLineRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  textDigest: z.string(),
  name: z.string(),
  digest: z.string(),
  durationMs: z.number().int().nonnegative(),
  tempo: z.number().positive(),
  attempt: z.number().int().min(1).max(2),
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
});
export type VoiceLineRecord = z.infer<typeof VoiceLineRecordSchema>;
// 합성 도중 문장별로 저장해 두는 기록. 매니페스트는 전 문장이 끝나야 저장되므로 중단 뒤 재사용하려면 필요하다.
// voiceId 가 다르면 재사용하지 않는다.
export const VoiceLineStateSchema = VoiceLineRecordSchema.extend({ voiceId: z.string() });
export type VoiceLineState = z.infer<typeof VoiceLineStateSchema>;

export const ClipIdSchema = z.enum(VEO_CLIP_IDS);
export type ClipId = z.infer<typeof ClipIdSchema>;

const attempts = z.number().int().min(0).max(9).default(0);

export const StartImageStateSchema = z.object({
  name: z.string(),
  digest: z.string(),
  attempts,
  // forced: 검토 2회 후 강제 통과. 그래도 digest 는 반드시 저장한다(clips 단계 재검증용).
  status: z.enum(["pass", "forced"]).default("pass"),
});
export type StartImageState = z.infer<typeof StartImageStateSchema>;
// 정지 이미지(AI 사진풍 컷 소스)도 시작 이미지와 같은 기록 형식: 이름·digest·시도 횟수·통과/강제 통과.
export const StillStateSchema = StartImageStateSchema;
export type StillState = StartImageState;

export const ClipOperationSchema = z.object({
  name: z.string(),
  startedAt: z.iso.datetime(),
  model: z.string(),
});
export const ClipStateSchema = z.object({
  name: z.string().nullable().default(null),
  digest: z.string().nullable().default(null),
  attempts,
  // 생성 요청 직전에 기록, 핸들 저장 후 해제. 남아 있으면 응답 수신~저장 사이 크래시(불확실 상태).
  pendingSince: z.iso.datetime().nullable().default(null),
  operation: ClipOperationSchema.nullable().default(null),
});
export type ClipState = z.infer<typeof ClipStateSchema>;

// 사용자 대본 승인(2026-10-04): 유료 제작(내레이션 합성) 전에 사용자가 대본을 확인했다는 기록.
// scriptDigest 가 현재 대본의 다이제스트와 같을 때만 유효하다(대본을 고치면 승인이 풀린다).
export const ScriptApprovalSchema = z.object({
  approvedAt: z.iso.datetime(),
  scriptDigest: z.string(),
});
export type ScriptApproval = z.infer<typeof ScriptApprovalSchema>;
// 마지막 AI 대본 검토 결과(산출물 video-script-review-<n>-<attempt>.json 과 같은 내용) + 자동 수리·경고·미통과 기록. 화면 표시용.
// 예전 기록({attempt, status, summary, issues, accepted})은 새 필드가 기본값으로 읽힌다.
export const StoredVideoScriptReviewSchema = z.object({
  // 검토 산출물 회차. 검토 없이 저장된 초안(needsFix)은 0.
  attempt: z.number().int().min(0),
  status: z.enum(["pass", "revise"]),
  summary: z.string(),
  issues: z.array(VideoScriptReviewIssueSchema).max(20),
  // forced: 생성 한도(3회) 뒤에도 AI 검토가 revise. needsFix: 3회 생성 뒤에도 hard 규칙을 통과하지 못한 초안(고치거나 다시 쓰기).
  accepted: z.enum(["pass", "forced", "needsFix"]).default("pass"),
  // 응답 → 저장 변환 중 자동 수리 기록(한국어 한 줄씩)
  repairs: z.array(z.string().max(400)).max(80).default([]),
  // soft 규칙 경고(받아들였지만 사용자가 볼 것)
  warnings: z.array(z.string().max(400)).max(80).default([]),
  // needsFix 일 때 남은 hard 위반(편집으로 해소되면 [])
  hardProblems: z.array(z.string().max(400)).max(80).default([]),
  // 이 대본에 쓴 생성 횟수(예전 기록은 0)
  generations: z.number().int().min(0).max(9).default(0),
  // 이 대본을 만들 때 서버가 읽은 지시 파일(instructions/)의 sha256 과 읽은 시각(D5, 2026-10-07). 예전 기록·주입 공급자는 "".
  // scriptDigestJson(대본 다이제스트)에는 들어가지 않으므로 예전 승인·음성 기록이 바뀌지 않는다.
  instructionsDigest: z.string().default(""),
  instructionsLoadedAt: z.string().default(""),
});
export type StoredVideoScriptReview = z.infer<typeof StoredVideoScriptReviewSchema>;

export const RenderStateSchema = z.object({
  number: z.number().int().min(1).max(10),
  scriptDigest: z.string().nullable().default(null),
  // 대본 승인·AI 검토 기록. 기존 SQLite 행에는 없어 기본값은 null(= 미승인).
  scriptApproval: ScriptApprovalSchema.nullable().default(null),
  scriptReview: StoredVideoScriptReviewSchema.nullable().default(null),
  voice: z
    .object({
      manifestName: z.string(),
      voiceId: z.string(),
      timelineDigest: z.string(),
    })
    .nullable()
    .default(null),
  // 합성이 끝나기 전까지만 쓰는 문장별 기록(voice 가 확정되면 비운다). 기존 SQLite 행에는 없어 기본값은 [].
  voiceLines: z.array(VoiceLineStateSchema).default([]),
  startImages: z.partialRecord(ClipIdSchema, StartImageStateSchema).default({}),
  // AI 정지 이미지(S1..S14) 기록. 정지 이미지가 없던 기존 SQLite 행에는 없어 기본값은 {}.
  stills: z.partialRecord(StillIdSchema, StillStateSchema).default({}),
  clips: z.partialRecord(ClipIdSchema, ClipStateSchema).default({}),
  // 설명 컷(I1~I3)의 Flow CLEAN·INFO 이미지. INFO 는 지정 문구와 글자를 대조해 통과해야 클립을 받는다.
  infoImages: z
    .partialRecord(
      z.enum(INFO_CLIP_IDS),
      z.object({
        clean: z.string().nullable().default(null),
        info: z.string().nullable().default(null),
        verified: z.boolean().default(false),
        problems: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  final: z
    .object({
      name: z.string(),
      digest: z.string(),
      durationMs: z.number().int().nonnegative(),
      bgmTrackId: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type RenderState = z.infer<typeof RenderStateSchema>;

// 영상 번호만으로 빈 상태를 만든다(렌더 파이프라인이 renders[n] 이 없을 때 초기화).
export function emptyRenderState(number: number, scriptDigest: string | null = null): RenderState {
  return RenderStateSchema.parse({ number, scriptDigest });
}
