// 모션그래픽·자막의 색·크기·세이프존 토큰. 바꾸면 THEME_VERSION 을 올려 세그먼트 캐시를 무효화한다.
export const THEME_VERSION = 2;
export const THEME = {
  colors: {
    // ffmpeg color 표기(0xRRGGBB) 와 ASS 표기(&HBBGGRR&) 양쪽에서 쓰도록 RGB 16진만 둔다.
    background: "101828",
    accent: "FFD54A",
    text: "FFFFFF",
    muted: "9AA4B2",
  },
  // 세로 높이에 대한 비율
  scale: {
    number: 0.083,
    title: 0.0375,
    body: 0.029,
    caption: 0.0375,
    graphicNumber: 0.1,
    graphicTitle: 0.045,
    graphicBody: 0.036,
  },
  artwork: { top: 0.3, bottom: 0.68 },
  graphic: { top: 0.32, bottom: 0.65 },
  // 릴스 UI 가 가리는 영역(상 11.5%·하 23%·좌우 6.7%)
  safe: {
    top: 0.115,
    bottom: 0.23,
    side: 0.067,
  },
} as const;
export type RenderProfile = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};
export function artworkTopRatio(header: {
  readonly fixedTitle?: readonly string[] | undefined;
  readonly disclaimer?: string | undefined;
}): number {
  if (header.disclaimer?.trim()) return THEME.artwork.top;
  return header.fixedTitle?.some((line) => line.trim()) ? 0.22 : THEME.safe.side;
}
// 마스터 1080x1920/30fps. 테스트는 108x192/10fps 를 주입해 수 초 안에 끝낸다.
export const DEFAULT_PROFILE: RenderProfile = { width: 1080, height: 1920, fps: 30 };
// 비율 토큰을 프로파일 픽셀로(최소 1px)
export function themePx(
  profile: RenderProfile,
  ratio: number,
  axis: "width" | "height" = "height",
) {
  return Math.max(1, Math.round(profile[axis] * ratio));
}
