import type { FontSet } from "./fonts";

// 글줄 폭 추정과 맞춤: ASS 는 WrapStyle 2(자동 줄바꿈 없음)라 줄이 프레임 밖으로 나가도 잘라 주지 않는다.
// 그래서 줄 길이에서 글꼴 크기(필요하면 줄 나눔)를 직접 계산한다. 글자 폭은 Pretendard Bold 의 진행폭이고
// (Bold 가 Medium 보다 넓다), libass 는 ASS 글꼴 크기를 em 이 아니라 줄 높이(ascent+descent)로 해석하므로
// em 폭에 em/줄높이 비를 곱해 픽셀 폭을 얻는다. 한글 12자를 fs100 으로 렌더해 재 보니 글자당 약 72px 였다.

// ASCII 32..126 의 Pretendard Bold advance(1/1000 em)
const ASCII_ADVANCE = [
  230, 307, 376, 624, 630, 960, 648, 197, 390, 390, 539, 653, 287, 449, 282, 371, 660, 469, 610,
  639, 657, 627, 643, 575, 644, 643, 282, 282, 653, 653, 653, 538, 874, 718, 637, 724, 701, 589,
  562, 732, 720, 266, 547, 663, 546, 883, 709, 753, 623, 754, 632, 630, 643, 704, 718, 999, 686,
  695, 641, 390, 371, 390, 467, 456, 478, 558, 611, 563, 611, 574, 367, 608, 600, 257, 257, 558,
  257, 879, 598, 590, 608, 608, 390, 539, 370, 597, 562, 819, 551, 562, 549, 390, 355, 390, 653,
] as const;
const HANGUL_ADVANCE = 864;
// 목록에 없는 문자(한자·기호·이모지)는 전각으로 본다
const WIDE_ADVANCE = 1000;
// libass 의 fs → em 환산: Pretendard 는 unitsPerEm 2048, ascent 1950 + descent 494 → 2048/2444
const PRETENDARD_CELL = 2048 / (1950 + 494);
// 대체 글꼴(맑은 고딕)은 실측하지 않아 여유 있게 잡는다(미검증)
const FALLBACK_CELL = 0.95;
// libass 줄 간격은 글꼴 크기(fs)와 같다(fs100 3줄 실측: 줄 피치 100px)
export const LINE_HEIGHT = 1;

function advance(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ASCII_ADVANCE[code - 32] ?? WIDE_ADVANCE;
  if (
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f)
  )
    return HANGUL_ADVANCE;
  return WIDE_ADVANCE;
}
// 한 줄의 폭을 ASS 글꼴 크기(fs) 배수로: 폭(px) = 반환값 × fs
export function lineEm(line: string, font: FontSet): number {
  if (font.metrics) {
    const { advances, unitsPerEm, ascent, descent } = font.metrics;
    const width = [...line].reduce(
      (sum, char) => sum + (advances[String(char.codePointAt(0))] ?? unitsPerEm),
      0,
    );
    return width / (ascent + descent);
  }
  let total = 0;
  for (const char of line) total += advance(char);
  return (total / 1000) * (font.family === "Pretendard" ? PRETENDARD_CELL : FALLBACK_CELL);
}
export const longestEm = (lines: readonly string[], font: FontSet) =>
  Math.max(0, ...lines.map((line) => lineEm(line, font)));

export type TextFit = {
  // \N 으로 이어 붙일 줄들
  readonly lines: readonly string[];
  readonly size: number;
  // 렌더된 줄 중 가장 넓은 폭(px, 외곽선 제외)
  readonly widthPx: number;
  // 줄 높이 합(px)
  readonly heightPx: number;
};
export type FitOptions = {
  readonly font: FontSet;
  // 글자가 놓일 수 있는 최대 폭(px). 팝 확대 배율 등은 호출자가 overshoot 로 알린다.
  readonly maxWidth: number;
  readonly base: number;
  readonly outline?: number;
  // 팝 애니메이션 최대 배율(기본 1)
  readonly overshoot?: number;
  // 읽을 수 있는 최소 크기 = base × minRatio. 이보다 작아지면 줄을 나눈다(maxLines 까지).
  readonly minRatio?: number;
  readonly maxLines?: number;
};
function sizeFor(lines: readonly string[], options: FitOptions): number {
  const budget = options.maxWidth / (options.overshoot ?? 1) - 2 * (options.outline ?? 0);
  const em = longestEm(lines, options.font);
  if (em <= 0) return options.base;
  return Math.max(1, Math.min(options.base, Math.floor(budget / em)));
}
function describe(lines: readonly string[], size: number, options: FitOptions): TextFit {
  return {
    lines,
    size,
    widthPx: Math.ceil(longestEm(lines, options.font) * size),
    heightPx: Math.ceil(lines.length * size * LINE_HEIGHT),
  };
}
// 이미 나뉜 줄들(자막처럼 줄 수가 정해진 것)은 가장 긴 줄 기준으로 크기만 줄인다.
export function fitLines(lines: readonly string[], options: FitOptions): TextFit {
  return describe(lines, sizeFor(lines, options), options);
}
// 공백에서 끊는 쪽을 선호하는 균형 분할(최대 3줄). 끊는 글자 사이에는 공백이 없으면 1.5em 의 벌점을 준다.
function balancedSplit(text: string, parts: number, font: FontSet): string[] {
  const chars = [...text];
  if (parts <= 1 || chars.length < parts) return [text];
  const piece = (from: number, to: number) => chars.slice(from, to).join("").trim();
  const penalty = (cut: number) => (chars[cut] === " " || chars[cut - 1] === " " ? 0 : 1.5);
  let best: string[] = [text];
  let bestCost = Number.POSITIVE_INFINITY;
  const consider = (cuts: readonly number[]) => {
    const edges = [0, ...cuts, chars.length];
    const lines = edges.slice(1).map((end, index) => piece(edges[index] ?? 0, end));
    if (lines.some((line) => line.length === 0)) return;
    const cost = longestEm(lines, font) + cuts.reduce((sum, cut) => sum + penalty(cut), 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = lines;
    }
  };
  for (let first = 1; first < chars.length; first++) {
    if (parts === 2) consider([first]);
    else for (let second = first + 1; second < chars.length; second++) consider([first, second]);
  }
  return best;
}
// 한 줄로 읽을 수 있는 크기가 나오면 그대로, 아니면 2~maxLines 줄로 나눠 가장 먼저 읽을 만해지는 쪽을 쓴다.
export function fitText(value: string, options: FitOptions): TextFit {
  const maxLines = Math.min(3, Math.max(1, options.maxLines ?? 1));
  const floor = options.base * (options.minRatio ?? 0.75);
  let last: TextFit | null = null;
  for (let parts = 1; parts <= maxLines; parts++) {
    const lines = balancedSplit(value, parts, options.font);
    const size = sizeFor(lines, options);
    last = describe(lines, size, options);
    if (size >= floor || lines.length < parts) break;
  }
  return last ?? describe([value], sizeFor([value], options), options);
}
