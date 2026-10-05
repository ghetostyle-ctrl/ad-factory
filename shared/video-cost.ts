import { STILL_SHOTS_MAX, VEO_CLIP_SEC, VEO_SHOTS_MAX } from "./video-script";

// 완성 영상 1편 비용 추정(USD, 전부 추정이며 실제 호출 단가는 미검증).
// Veo 는 실사 컷에만 쓰고 분위기·상황 컷은 AI 정지 이미지로 만들기 때문에 영상마다 구성이 다르다.
// 이미지 1장 = 생성(1024x1536, high) + 비전 검토 ≈ 0.19 USD, 클립 프레임 검토는 클립당 ≈ 0.0125 USD.
export const IMAGE_USD = 0.19;
export const CLIP_REVIEW_USD_PER_CLIP = 0.0125;
// 대본이 아직 없을 때 쓰는 "대표 구성": 클립 3개(24초)와 정지 이미지 8장.
export const TYPICAL_VEO_CLIPS = 3;
export const TYPICAL_STILLS = 8;
// Typecast Lite 0.075USD/1k자, 재합성 여유 1.4배.
export const TYPECAST_USD_PER_CHAR = 0.075 / 1000;
export const DEFAULT_CHARS_PER_VIDEO = 250;

export type VideoCostInput = {
  readonly clips: number;
  readonly stills: number;
  // Veo 초당 단가(USD)
  readonly veoRatePerSec: number;
  readonly clipReview: boolean;
  readonly chars: number;
};
export type VideoCost = {
  readonly veoUsd: number;
  readonly imageUsd: number;
  readonly reviewUsd: number;
  readonly typecastUsd: number;
  readonly totalUsd: number;
  // 클립 생성·이미지·검토가 모두 최대 2회(재생성·재시도 1회)까지 일어나는 경우
  readonly maxUsd: number;
};
export function estimateVideoCost(input: VideoCostInput): VideoCost {
  const veoUsd = input.clips * VEO_CLIP_SEC * input.veoRatePerSec;
  const imageUsd = (input.clips + input.stills) * IMAGE_USD;
  const reviewUsd = input.clipReview ? input.clips * CLIP_REVIEW_USD_PER_CLIP : 0;
  const typecastUsd = input.chars * 1.4 * TYPECAST_USD_PER_CHAR;
  return {
    veoUsd,
    imageUsd,
    reviewUsd,
    typecastUsd,
    totalUsd: veoUsd + imageUsd + reviewUsd + typecastUsd,
    maxUsd: 2 * (veoUsd + imageUsd + reviewUsd) + typecastUsd,
  };
}
// 구성이 허용 최대(클립 4개·정지 이미지 14장)일 때의 상한 추정
export function estimateMaxCompositionCost(
  input: Pick<VideoCostInput, "veoRatePerSec" | "clipReview" | "chars">,
): VideoCost {
  return estimateVideoCost({ ...input, clips: VEO_SHOTS_MAX, stills: STILL_SHOTS_MAX });
}
