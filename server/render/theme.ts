import type { VisualPolicyId } from "../../shared/video-planning";
// 모션그래픽·자막의 색·크기·세이프존 토큰. 바꾸면 THEME_VERSION 을 올려 세그먼트 캐시를 무효화한다.
export const THEME_VERSION = 6;
export const THEME = {
  colors: {
    // ffmpeg color 표기(0xRRGGBB) 와 ASS 표기(&HBBGGRR&) 양쪽에서 쓰도록 RGB 16진만 둔다.
    background: "101828",
    accent: "FFD54A",
    text: "FFFFFF",
    muted: "9AA4B2",
    // 콜아웃 강조색 팔레트(R7): 기존 노랑 + 시안 + 코랄. 콜아웃마다 순서대로 돌려 쓴다(shared/render-timeline CALLOUT_COLORS 와 같은 수).
    accents: ["FFD54A", "4FC3F7", "FF6B6B"],
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
  // 콜아웃(R7) 치수: 1080x1920 기준 선 13px(0.0068h)·라벨 글자 64px(0.0333h)·링 두께 14px(0.0073h).
  // 앵커 존: left/right 는 너비 30%/70%·높이 55%, top 은 고정 제목 아래 24%, bottom 은 자막 위 66%.
  // floor 는 콜아웃 상자가 내려갈 수 있는 하한(하단 음성 자막 윗선, 세이프존 23% + 두 줄).
  callout: {
    line: 0.0068,
    label: 0.0333,
    ring: 0.0073,
    zoneTop: 0.24,
    zoneBottom: 0.66,
    zoneY: 0.55,
    zoneSide: 0.3,
    floor: 0.69,
  },
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

// 시각 정책 ID 는 shared/video-planning.ts 가 정한다(2026-10-07 hybrid_explainer_v1 추가).
export type VisualPolicy = VisualPolicyId | undefined;
// 렌더 스타일(자막 테두리·콜아웃 단일 강조색·글로우 없음·패널 단색 배경)은 immersive 전용이다. 혼합형은 실사 위주라 예전 스타일
// (어두운 테두리 자막·강조색 콜아웃·글로우)을 그대로 쓰므로, 진릿값 분기 앞에서 정책을 이 함수로 거른다(검토 지적 2026-10-07).
export function renderStylePolicy(policy?: VisualPolicy): VisualPolicy {
  return policy === "immersive_explanations_v1" ? policy : undefined;
}
const IMMERSIVE_COLORS = {
  background: "F6F2E8",
  accent: "B58B3D",
  text: "28382C",
  muted: "626A56",
  accents: ["B58B3D", "B58B3D", "B58B3D"],
} as const;
export function renderColors(policy?: VisualPolicy) {
  return policy === "immersive_explanations_v1" ? IMMERSIVE_COLORS : THEME.colors;
}
