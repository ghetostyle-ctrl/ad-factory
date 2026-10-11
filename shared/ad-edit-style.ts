export const AD_EDIT_STYLE = {
  version: 2,
  label: {
    fontSize: 68,
    minFontSize: 64,
    maxFontSize: 72,
    supportingFontSize: 48,
    letterSpacingEm: -0.02,
    horizontalPaddingEm: 0.8,
    heightEm: 2,
    maxWidthRatio: 0.8,
    safeSide: 0.04,
    safeTop: 0.1,
    // 라벨판 아래 한계. 2026-10-12 안1: 0.69 → 0.75(1440px). 자막 중심 1584 위에 captionGapPx 여유를 둔다.
    bottomRatio: 0.75,
    olive: "#3E4A22",
    white: "#FFFDF5",
    gold: "#B09A60",
    linePx: 5,
    lineBorderPx: 2,
    anchorRadiusPx: 13,
    anchorBorderPx: 4,
    // 배지 윗변과 앵커 점 사이(대상 아래 여유), 배지 아랫변과 자막 띠 사이 여유. 자리가 없으면 레이아웃이 최소 간격으로 물러선다.
    anchorGapPx: 72,
    captionGapPx: 64,
    maxLeaderReachRatio: 0.15,
    growSec: 0.4,
  },
  caption: {
    normalPx: 64,
    pointPx: 86,
    // 설명 컷 자막 중심. 2026-10-12 안1: 1464 → 1584 로 내려 라벨 배지와 물체 사이를 벌린다(안전 영역 1728 안).
    centerY: 1584,
    chestY: 1228,
    widthRatio: 0.8,
    white: "FFFDF5",
    accent: "FFF8CC",
    outline: "17251C",
  },
  // Source retains 40ms before speech and 100ms after; 150ms file spacing targets ~290ms audible pauses.
  pacing: { gapMs: 150, tailMs: 150, maxGapMs: 600 },
} as const;
