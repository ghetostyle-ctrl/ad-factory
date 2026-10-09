// 규칙 검사·타임라인·자막이 읽는 숫자 임계값(사용자 결정 2026-10-07: "창작 판단은 편집 가능한 지시 파일로, 계산은 코드로").
// - 기본값(DEFAULT_THRESHOLDS)은 분리 전 코드 상수와 같다. 브라우저 번들(shared)은 서버 로더를 import 할 수 없으므로
//   기본값으로 시작하고, 서버는 instructions/thresholds.json 을 읽은 뒤 setThresholds() 로 주입한다(server/instructions.ts).
//   화면은 GET /api/instructions 가 준 같은 값을 주입한다(src/api.ts).
// - 규칙 함수는 모듈 상수가 아니라 thresholds() 를 호출 시점에 읽어, 파일을 고치면 다음 검사부터 반영된다(재시작 불필요).
// - zod `.max()`·enum·literal 에 묶인 값(VEO_SHOTS_MAX, INFO_CLIPS_MAX, CALLOUTS_MAX …)은 여기 없다(코드 고정).
export const THRESHOLD_NAMES = [
  "COPY_BEAT_TARGET_CHARS",
  "COPY_BEAT_MAX_CHARS",
  "COPY_CHANGE_WARNING_RATE",
  "NARRATION_MIN_CHARS_PER_SEC",
  "NARRATION_TARGET_CHARS_PER_SEC",
  "NARRATION_MAX_CHARS_PER_SEC",
  "NARRATION_MIN_SENTENCE_CHARS",
  "VOICE_GAP_SEC",
  "CUT_MAX_SEC",
  "EXPLAINER_CUT_MAX_SEC",
  "EXPLAINER_MAX_RATIO",
  "EXPLAINER_HOLD_MS",
  "HYBRID_ENDING_IMAGE_MAX_SEC",
  "STILL_BEAT_MAX_SEC",
  "SILENCE_GAP_MAX_MS",
  "SILENCE_TRIM_MIN_CUT_MS",
  "TIMELINE_SLACK_MS",
  "TIMELINE_MAX_SPREAD_MS",
  "TIMELINE_MAX_EXTEND_MS",
  "MOTION_GRAPHIC_MAX_RATIO",
  "VEO_MAX_RATIO",
  "VEO_HINT_RATIO",
  "STILL_MAX_SEC",
  "SILENT_CUTS_MAX",
  "SCENE_HOLD_SEC",
  "CAPTION_LINE_MAX_CHARS",
  "CAPTION_MIN_CHARS",
  "CAPTION_MIN_MS",
  "CAPTION_MAX_MS",
  "CAPTION_LEAD_MS",
  "NATURAL_CHARS_PER_SEC",
  "COPY_LINES_MIN",
  "COPY_LINES_MAX",
  "VERIFY_FEEDBACK_MAX",
  "NEAR_DUPLICATE_RATIO",
  "NEAR_DUPLICATE_MIN_BIGRAMS",
  "SUBJECT_KEY_WORD_MIN_CHARS",
  "VIDEO_SHORT_MAX_SEC",
  "VIDEO_LONG_MIN_SEC",
  "INFO_GRAPHIC_BAND_TOP",
  "INFO_GRAPHIC_BAND_BOTTOM",
] as const;
export type ThresholdName = (typeof THRESHOLD_NAMES)[number];
export type Thresholds = Readonly<Record<ThresholdName, number>>;

// 분리 전(b3ef40a) 코드 상수와 같은 값. instructions/thresholds.json 의 value 와 같아야 한다(tests/instructions-loader.test.ts 가 대조).
export const DEFAULT_THRESHOLDS: Thresholds = {
  COPY_BEAT_TARGET_CHARS: 34,
  COPY_BEAT_MAX_CHARS: 40,
  COPY_CHANGE_WARNING_RATE: 0.5,
  NARRATION_MIN_CHARS_PER_SEC: 8.5,
  NARRATION_TARGET_CHARS_PER_SEC: 10,
  NARRATION_MAX_CHARS_PER_SEC: 12.6,
  NARRATION_MIN_SENTENCE_CHARS: 4,
  VOICE_GAP_SEC: 0.15,
  CUT_MAX_SEC: 5,
  EXPLAINER_CUT_MAX_SEC: 4,
  EXPLAINER_MAX_RATIO: 0.5,
  EXPLAINER_HOLD_MS: 1000,
  HYBRID_ENDING_IMAGE_MAX_SEC: 3,
  // 혼합형 ③④(진짜 원인·해결 조건) 문장 아래 정지 이미지 한 컷의 최대 초(2026-10-08, 어제 완성본의 정지 13초 반성).
  STILL_BEAT_MAX_SEC: 3,
  SILENCE_GAP_MAX_MS: 500,
  SILENCE_TRIM_MIN_CUT_MS: 1000,
  TIMELINE_SLACK_MS: 300,
  TIMELINE_MAX_SPREAD_MS: 500,
  TIMELINE_MAX_EXTEND_MS: 3000,
  MOTION_GRAPHIC_MAX_RATIO: 0.4,
  VEO_MAX_RATIO: 0.5,
  VEO_HINT_RATIO: 0.45,
  STILL_MAX_SEC: 4,
  SILENT_CUTS_MAX: 2,
  SCENE_HOLD_SEC: 2,
  CAPTION_LINE_MAX_CHARS: 12,
  CAPTION_MIN_CHARS: 7,
  CAPTION_MIN_MS: 500,
  CAPTION_MAX_MS: 2000,
  CAPTION_LEAD_MS: 200,
  // 카피 먼저 흐름(2026-10-08): Typecast 자연 속도 실측 약 5.5자/초. 카피 길이 추정·장면 컷 배분·60초 사전 검사가 쓴다.
  NATURAL_CHARS_PER_SEC: 5.5,
  // 카피 문장 수(영상 1편). 50초 기준 8~10문장을 중심으로 한 범위.
  COPY_LINES_MIN: 6,
  COPY_LINES_MAX: 10,
  VERIFY_FEEDBACK_MAX: 16,
  NEAR_DUPLICATE_RATIO: 0.75,
  NEAR_DUPLICATE_MIN_BIGRAMS: 6,
  SUBJECT_KEY_WORD_MIN_CHARS: 4,
  VIDEO_SHORT_MAX_SEC: 40,
  VIDEO_LONG_MIN_SEC: 45,
  INFO_GRAPHIC_BAND_TOP: 20,
  INFO_GRAPHIC_BAND_BOTTOM: 65,
};

let current: Thresholds = DEFAULT_THRESHOLDS;
// 지금 적용된 임계값. 규칙 함수는 모듈 로드 때가 아니라 호출 때 읽는다.
export function thresholds(): Thresholds {
  return current;
}
// 주입: 이름이 맞고 유한한 숫자인 항목만 받고 나머지는 기본값을 유지한다(알 수 없는 이름은 무시).
export function setThresholds(next: Readonly<Partial<Record<string, number>>>): Thresholds {
  const merged: Record<ThresholdName, number> = { ...DEFAULT_THRESHOLDS };
  for (const name of THRESHOLD_NAMES) {
    const value = next[name];
    if (typeof value === "number" && Number.isFinite(value)) merged[name] = value;
  }
  current = merged;
  return current;
}
export function resetThresholds(): void {
  current = DEFAULT_THRESHOLDS;
}
// 테스트용: 잠시 다른 값으로 돌리고 끝나면 이전 값으로 되돌린다.
export function withThresholds<T>(
  next: Readonly<Partial<Record<string, number>>>,
  run: () => T,
): T {
  const previous = current;
  setThresholds(next);
  try {
    return run();
  } finally {
    current = previous;
  }
}
