import { expect, test } from "bun:test";
import {
  estimateMaxCompositionCost,
  estimateVideoCost,
  IMAGE_USD,
  TYPICAL_STILLS,
  TYPICAL_VEO_CLIPS,
} from "../shared/video-cost";
import { STILL_SHOTS_MAX, VEO_CLIP_SEC, VEO_SHOTS_MAX } from "../shared/video-script";

// 비용 추정(전부 추정): Veo 클립 수·정지 이미지 수·검토 여부가 값에 그대로 반영된다.
const base = { veoRatePerSec: 0.4, clipReview: true, chars: 250 };

test("a typical mix costs far less than the old eight-clip layout", () => {
  const typical = estimateVideoCost({ ...base, clips: TYPICAL_VEO_CLIPS, stills: TYPICAL_STILLS });
  expect(typical.veoUsd).toBeCloseTo(TYPICAL_VEO_CLIPS * VEO_CLIP_SEC * 0.4, 6);
  expect(typical.imageUsd).toBeCloseTo((TYPICAL_VEO_CLIPS + TYPICAL_STILLS) * IMAGE_USD, 6);
  // 예전 구성(클립 8개, 시작 이미지 8장 ≈ US$1.5)과 비교: Veo 가 비용의 대부분이라 클립 수가 총액을 좌우한다
  const old = estimateVideoCost({ ...base, clips: 8, stills: 0 });
  expect(typical.totalUsd).toBeLessThan(old.totalUsd * 0.5);
  expect(typical.totalUsd).toBeCloseTo(
    typical.veoUsd + typical.imageUsd + typical.reviewUsd + typical.typecastUsd,
    6,
  );
});

test("stills add image cost only, reviews can be turned off and the retry ceiling doubles paid steps", () => {
  const without = estimateVideoCost({ ...base, clips: 2, stills: 0 });
  const withStills = estimateVideoCost({ ...base, clips: 2, stills: 6 });
  expect(withStills.veoUsd).toBe(without.veoUsd);
  expect(withStills.totalUsd - without.totalUsd).toBeCloseTo(6 * IMAGE_USD, 6);
  const noReview = estimateVideoCost({ ...base, clips: 2, stills: 6, clipReview: false });
  expect(noReview.reviewUsd).toBe(0);
  // 최대 = 2 × (Veo + 이미지 + 검토) + Typecast (Typecast 는 재합성 여유가 이미 들어 있다)
  expect(withStills.maxUsd).toBeCloseTo(
    2 * (withStills.veoUsd + withStills.imageUsd + withStills.reviewUsd) + withStills.typecastUsd,
    6,
  );
  expect(withStills.maxUsd).toBeGreaterThan(withStills.totalUsd);
});

test("the maximum composition uses the declared limits", () => {
  const worst = estimateMaxCompositionCost(base);
  const direct = estimateVideoCost({ ...base, clips: VEO_SHOTS_MAX, stills: STILL_SHOTS_MAX });
  expect(worst).toEqual(direct);
  expect(worst.totalUsd).toBeGreaterThan(
    estimateVideoCost({ ...base, clips: TYPICAL_VEO_CLIPS, stills: TYPICAL_STILLS }).totalUsd,
  );
});
