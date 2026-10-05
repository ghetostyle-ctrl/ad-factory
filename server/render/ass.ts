import type { z } from "zod";
import type { RenderTimeline, TimelineCut } from "../../shared/render-timeline";
import type { GraphicKindSchema } from "../../shared/video-script";
import type { FontSet } from "./fonts";
import { fitLines, fitText, lineEm, type TextFit } from "./text-fit";
import { type RenderProfile, THEME, themePx } from "./theme";

// ASS(libass) 자막·모션그래픽 빌더. drawtext 는 쓰지 않는다(8.1 win64 결함 실측). 좌표·크기는 프로파일 비례.
type GraphicKind = z.infer<typeof GraphicKindSchema>;
export const ASS_LINE_STAGGER_MS = 350;
// 캡션 애니메이션: 80ms 페이드인. 팝: 40%→115%→100%.
const FADE = "\\fad(80,0)";
const POP =
  "\\fad(60,0)\\fscx40\\fscy40\\t(0,180,\\fscx115\\fscy115)\\t(180,300,\\fscx100\\fscy100)";

// RGB 16진("FFD54A") → ASS 색(&HAABBGGRR&)
export function assColor(rgb: string, alpha = 0): string {
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`;
}
// ms → h:mm:ss.cc
export function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000) % 60;
  const hours = Math.floor(total / 360000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
// 중괄호·역슬래시는 태그로 읽히므로 바꾸고, 줄바꿈은 줄 배열로, maxChars 를 넘는 줄은 강제 분할한다.
export function assLines(text: string, maxChars = 16): string[] {
  return text
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const characters = [...line];
      if (characters.length <= maxChars) return [line];
      const parts: string[] = [];
      for (let index = 0; index < characters.length; index += maxChars)
        parts.push(characters.slice(index, index + maxChars).join(""));
      return parts;
    });
}
export function assEscape(text: string, maxChars = 16): string {
  return assLines(text, maxChars).join("\\N");
}
export type AssStyle = {
  readonly name: string;
  readonly fontSize: number;
  readonly primary: string;
  readonly outline: number;
  readonly shadow: number;
  readonly alignment: number;
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
  readonly bold?: boolean;
};
export function assHeader(
  profile: RenderProfile,
  font: FontSet,
  styles: readonly AssStyle[],
): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${profile.width}`,
    `PlayResY: ${profile.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles.map(
      (style) =>
        `Style: ${style.name},${font.family},${style.fontSize},${style.primary},${assColor("0000FF")},${assColor("000000")},${assColor("000000", 0x80)},${style.bold === false ? 0 : -1},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},${style.marginL},${style.marginR},${style.marginV},1`,
    ),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return lines.join("\n");
}
export function assDialogue(input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly style: string;
  readonly text: string;
  readonly layer?: number;
}): string {
  return `Dialogue: ${input.layer ?? 0},${assTime(input.startMs)},${assTime(input.endMs)},${input.style},,0,0,0,,${input.text}`;
}
// 1080x1920 기준 px 를 프로파일 비례로(최소 1)
const px = (profile: RenderProfile, base: number) =>
  Math.max(1, Math.round((base * profile.height) / 1920));
function captionStyles(profile: RenderProfile): AssStyle[] {
  const common = {
    primary: assColor(THEME.colors.text),
    outline: px(profile, 6),
    shadow: px(profile, 2),
    marginL: themePx(profile, THEME.safe.side, "width"),
    marginR: themePx(profile, THEME.safe.side, "width"),
  };
  return [
    {
      name: "Caption",
      fontSize: themePx(profile, THEME.scale.caption),
      alignment: 2,
      marginV: themePx(profile, THEME.safe.bottom),
      ...common,
    },
    {
      name: "Pop",
      fontSize: themePx(profile, THEME.scale.number * 0.75),
      alignment: 5,
      marginV: 0,
      ...common,
    },
    {
      ...common,
      name: "FixedTitle",
      fontSize: themePx(profile, THEME.scale.title),
      alignment: 8,
      marginV: themePx(profile, THEME.safe.top),
    },
    {
      ...common,
      name: "Disclaimer",
      fontSize: px(profile, 28),
      alignment: 8,
      marginV: themePx(profile, 0.235),
      bold: false,
      outline: px(profile, 2),
      shadow: 0,
    },
  ];
}
// ASS 는 자동 줄바꿈이 없어(WrapStyle 2) 긴 줄은 프레임 밖으로 잘린다. 줄 폭(text-fit.ts 의 진행폭)으로
// 글꼴 크기를 줄여 맞춘다: 하단 캡션은 좌우 세이프존(릴스 UI) 안, 팝은 115% 확대 최대치가 프레임 폭의 96% 안.
const POP_SCALE = 1.15;
const POP_FRAME_RATIO = 0.96;
const fontSizeTag = (fit: TextFit, base: number): string =>
  fit.size < base ? `\\fs${fit.size}` : "";
// captions-<n>.ass: 컷 자막. text_pop 컷은 하단 캡션 대신 중앙 팝.
export function captionsAss(
  timeline: RenderTimeline,
  profile: RenderProfile,
  font: FontSet,
): string {
  const styles = captionStyles(profile);
  const header = assHeader(profile, font, styles);
  const baseOf = (name: string) => styles.find((style) => style.name === name)?.fontSize ?? 1;
  const outline = px(profile, 6);
  const center = `\\pos(${Math.round(profile.width / 2)},${Math.round(profile.height / 2)})`;
  const captions =
    timeline.captions ?? timeline.cuts.flatMap((cut) => (cut.caption ? [cut.caption] : []));
  const events = captions.flatMap((caption) => {
    if (!caption.text.trim()) return [];
    const lines = assLines(caption.text, timeline.captions ? Number.POSITIVE_INFINITY : 16);
    let text = lines.join("\\N");
    const keyword = caption.keyword ? assEscape(caption.keyword, Number.POSITIVE_INFINITY) : "";
    if (keyword && text.includes(keyword)) {
      const at = text.indexOf(keyword);
      text = `${text.slice(0, at)}{\\c${assColor(THEME.colors.accent)}&}${keyword}{\\c${assColor(THEME.colors.text)}&}${text.slice(at + keyword.length)}`;
    }
    if (caption.style === "pop") {
      const base = baseOf("Pop");
      const fit = fitLines(lines, {
        font,
        base,
        outline,
        maxWidth: profile.width * POP_FRAME_RATIO,
        overshoot: POP_SCALE,
      });
      return [
        assDialogue({
          startMs: caption.startMs,
          endMs: caption.endMs,
          style: "Pop",
          text: `{${center}${fontSizeTag(fit, base)}${POP}}${text}`,
        }),
      ];
    }
    const base = baseOf("Caption");
    const fit = fitLines(lines, {
      font,
      base,
      outline,
      maxWidth: profile.width - 2 * themePx(profile, THEME.safe.side, "width"),
    });
    return [
      assDialogue({
        startMs: caption.startMs,
        endMs: caption.endMs,
        style: "Caption",
        text: `{${FADE}${fontSizeTag(fit, base)}}${text}`,
      }),
    ];
  });
  const disclaimerText = (timeline.disclaimer ?? "").replace(/\s+/g, " ").trim();
  for (const slot of [
    { name: "FixedTitle", lines: timeline.fixedTitle ?? [] },
    {
      name: "Disclaimer",
      lines: disclaimerText
        ? assLines(disclaimerText, Math.max(28, Math.ceil([...disclaimerText].length / 4)))
        : [],
    },
  ]) {
    if (!slot.lines.length) continue;
    const lines = slot.lines.map((line) => assEscape(line, Number.POSITIVE_INFINITY));
    const base = baseOf(slot.name);
    const fit = fitLines(lines, {
      font,
      base,
      outline,
      maxWidth: profile.width - 2 * themePx(profile, THEME.safe.side, "width"),
    });
    events.push(
      assDialogue({
        startMs: 0,
        endMs: timeline.durationMs,
        style: slot.name,
        text: `{${fontSizeTag(fit, base)}}${lines.join("\\N")}`,
        layer: 1,
      }),
    );
  }
  return `${[header, ...events].join("\n")}\n`;
}
// 체크 표시 벡터(폰트 글리프 대신 \p1 도형). 좌표는 1080 기준 px 를 프로파일 비례로 줄인다.
export function checkVector(profile: RenderProfile): string {
  const s = profile.height / 1920;
  const point = (x: number, y: number) => `${Math.round(x * s)} ${Math.round(y * s)}`;
  return `{\\p1}m ${point(0, 20)} l ${point(20, 40)} l ${point(60, 0)} l ${point(52, -8)} l ${point(20, 24)} l ${point(8, 12)}{\\p0}`;
}
function rectVector(width: number, height: number): string {
  return `{\\p1}m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}{\\p0}`;
}
// 고정 제목·면책문구 아래, 두 줄 음성 자막 위에 그래픽의 움직임까지 담는 영역이다.
export function graphicPanel(profile: RenderProfile): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
} {
  return {
    x: Math.round(profile.width * THEME.safe.side),
    y: Math.round(profile.height * THEME.graphic.top),
    w: Math.round(profile.width * (1 - THEME.safe.side * 2)),
    h: Math.round(profile.height * (THEME.graphic.bottom - THEME.graphic.top)),
  };
}
// 줄 하나가 대본 규격 상한(24자)이어도 패널 안에 들어오도록, 글줄은 길이에서 크기·줄 나눔을 계산해 세로로 쌓는다.
const GRAPHIC_LINE_MAX_CHARS = 24;
type TextStyle = "Big" | "Title" | "Body" | "Muted";
type StackItem = {
  readonly style: TextStyle;
  readonly value: string;
  readonly overshoot?: number;
  readonly maxLines: number;
};
// 모션그래픽 컷 ASS: graphicKind 별 템플릿. 줄 간 350ms 지연, 여러 줄은 \N 만 쓴다.
export function graphicAss(
  kind: GraphicKind,
  lines: readonly string[],
  durationMs: number,
  profile: RenderProfile,
  font: FontSet,
): string {
  const W = profile.width;
  const H = profile.height;
  const xr = (ratio: number) => Math.round(W * ratio);
  const yr = (ratio: number) => Math.round(H * ratio);
  const accent = assColor(THEME.colors.accent);
  const muted = assColor(THEME.colors.muted);
  const metrics = {
    Big: { base: themePx(profile, THEME.scale.graphicNumber), outline: px(profile, 6) },
    Title: { base: themePx(profile, THEME.scale.graphicTitle), outline: px(profile, 6) },
    Body: { base: themePx(profile, THEME.scale.graphicBody), outline: px(profile, 5) },
    Muted: { base: themePx(profile, THEME.scale.graphicBody), outline: px(profile, 6) },
  } as const;
  const base = {
    primary: assColor(THEME.colors.text),
    outline: px(profile, 6),
    shadow: px(profile, 4),
    marginL: 0,
    marginR: 0,
    marginV: 0,
    alignment: 5,
  };
  const styles: AssStyle[] = [
    { ...base, name: "Big", fontSize: metrics.Big.base, primary: accent },
    { ...base, name: "Title", fontSize: metrics.Title.base },
    { ...base, name: "Body", fontSize: metrics.Body.base, outline: metrics.Body.outline },
    { ...base, name: "Muted", fontSize: metrics.Muted.base, primary: muted },
    { ...base, name: "Shape", fontSize: 20, outline: 0, shadow: 0, primary: accent },
  ];
  const header = assHeader(profile, font, styles);
  const at = (index: number) =>
    Math.min(index * ASS_LINE_STAGGER_MS, Math.max(0, durationMs - 200));
  const events: string[] = [];
  const line = (
    index: number,
    style: string,
    tags: string,
    value: string,
    options: { readonly layer?: number; readonly startMs?: number } = {},
  ): void => {
    events.push(
      assDialogue({
        startMs: options.startMs ?? at(index),
        endMs: durationMs,
        style,
        text: `{${tags}}${value}`,
        ...(options.layer !== undefined ? { layer: options.layer } : {}),
      }),
    );
  };

  // 글이 놓일 안쪽 영역: 패널에서 좌우·상하 여백을 뺀 곳. 글줄은 이 안에만 둔다.
  const panel = graphicPanel(profile);
  const pad = Math.round(W * 0.022);
  const verticalPad = Math.max(pad, yr(0.02) + px(profile, 6));
  const inner = {
    x: panel.x + pad,
    y: panel.y + verticalPad,
    w: panel.w - 2 * pad,
    h: panel.h - 2 * verticalPad,
  };
  const cx = Math.round(W / 2);
  const cy = Math.round(panel.y + panel.h / 2);
  const gap = Math.round(H * 0.02);
  const fit = (
    style: TextStyle,
    value: string,
    maxWidth: number,
    scale: number,
    options: { readonly overshoot?: number; readonly maxLines?: number } = {},
  ): TextFit => {
    const metric = metrics[style];
    const split = assLines(value, GRAPHIC_LINE_MAX_CHARS);
    const common = {
      font,
      base: Math.max(1, Math.round(metric.base * scale)),
      outline: metric.outline,
      maxWidth,
      overshoot: options.overshoot ?? 1,
    };
    // 대본이 줄을 직접 나눴으면(\n) 그대로 두고 크기만 맞춘다.
    if (split.length > 1) return fitLines(split, common);
    return fitText(split[0] ?? "", { ...common, maxLines: options.maxLines ?? 1 });
  };
  const sizeTag = (style: TextStyle, textFit: TextFit) =>
    textFit.size === metrics[style].base ? "" : `\\fs${textFit.size}`;
  const joined = (textFit: TextFit) => textFit.lines.join("\\N");
  const stackTotal = (heights: readonly number[]) =>
    heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, heights.length - 1);
  // 쌓은 높이가 안쪽 영역을 넘으면 글꼴 배율을 줄여 다시 맞춘다(크기가 줄면 폭도 줄어 가로는 그대로 안전).
  const fitScale = (heightsAt: (scale: number) => readonly number[]): number => {
    let scale = 1;
    for (let attempt = 0; attempt < 6; attempt++) {
      const total = stackTotal(heightsAt(scale));
      if (total <= inner.h) break;
      scale *= (inner.h / total) * 0.97;
    }
    return scale;
  };
  // 높이 목록을 middle 을 중심으로 쌓았을 때 각 블록의 중심 y
  const centers = (heights: readonly number[], middle: number): number[] => {
    let top = middle - stackTotal(heights) / 2;
    return heights.map((height) => {
      const center = Math.round(top + height / 2);
      top += height + gap;
      return center;
    });
  };
  const column = (items: readonly StackItem[], maxWidth: number) => {
    const fitsAt = (scale: number) =>
      items.map((item) =>
        fit(item.style, item.value, maxWidth, scale, {
          overshoot: item.overshoot ?? 1,
          maxLines: item.maxLines,
        }),
      );
    const fits = fitsAt(fitScale((scale) => fitsAt(scale).map((item) => item.heightPx)));
    const ys = centers(
      fits.map((item) => item.heightPx),
      cy,
    );
    return fits.map((textFit, index) => ({ fit: textFit, y: ys[index] ?? cy }));
  };
  const lineItems = (style: TextStyle, values: readonly string[]): StackItem[] =>
    values.map((value) => ({ style, value, maxLines: 2 }));

  const [first = "", ...rest] = lines;
  switch (kind) {
    case "number": {
      const placed = column(
        [
          ...(lines.length > 0
            ? [{ style: "Big", value: first, overshoot: POP_SCALE, maxLines: 2 } as const]
            : []),
          ...lineItems("Title", rest),
        ],
        inner.w,
      );
      for (const [index, { fit: textFit, y }] of placed.entries())
        if (index === 0)
          line(0, "Big", `\\pos(${cx},${y})${sizeTag("Big", textFit)}${POP}`, joined(textFit));
        else
          line(
            index,
            "Title",
            `\\move(${cx},${y + yr(0.02)},${cx},${y},0,200)${sizeTag("Title", textFit)}${FADE}`,
            joined(textFit),
          );
      break;
    }
    case "checklist": {
      const s = H / 1920;
      const checkHeight = Math.round(48 * s);
      const textX = xr(0.22);
      const maxWidth = inner.x + inner.w - textX;
      const fitsAt = (scale: number) =>
        lines.map((value) => fit("Title", value, maxWidth, scale, { maxLines: 2 }));
      const heightsOf = (scale: number) =>
        fitsAt(scale).map((item) => Math.max(item.heightPx, checkHeight));
      const scale = fitScale(heightsOf);
      const fits = fitsAt(scale);
      const ys = centers(heightsOf(scale), cy);
      for (const [index, textFit] of fits.entries()) {
        const rowY = ys[index] ?? cy;
        line(index, "Shape", `\\pos(${xr(0.14)},${rowY})${FADE}`, checkVector(profile), {
          layer: 0,
        });
        line(
          index,
          "Title",
          `\\an4\\move(${textX - px(profile, 40)},${rowY},${textX},${rowY},0,200)${sizeTag("Title", textFit)}${FADE}`,
          joined(textFit),
          { layer: 1 },
        );
      }
      break;
    }
    case "compare": {
      const [left = "", right = "", leftBody = "", rightBody = ""] = lines;
      // 가운데 VS 는 Big 의 60% 크기. 두 열은 VS 양옆의 남은 폭 안에서 줄을 나눠 맞춘다.
      const vsSize = Math.round(metrics.Big.base * 0.6);
      const vsHalf = Math.ceil((lineEm("VS", font) * vsSize * POP_SCALE) / 2) + metrics.Big.outline;
      const colGap = Math.round(W * 0.012);
      const columns = {
        left: { from: inner.x, to: cx - vsHalf - colGap },
        right: { from: cx + vsHalf + colGap, to: inner.x + inner.w },
      };
      const width = (side: "left" | "right") => columns[side].to - columns[side].from;
      const centerX = (side: "left" | "right") =>
        Math.round((columns[side].from + columns[side].to) / 2);
      const cellsAt = (scale: number) => ({
        leftTitle: fit("Title", left, width("left"), scale, { maxLines: 3 }),
        rightTitle: fit("Title", right, width("right"), scale, { maxLines: 3 }),
        leftBody: leftBody ? fit("Muted", leftBody, width("left"), scale, { maxLines: 2 }) : null,
        rightBody: rightBody
          ? fit("Body", rightBody, width("right"), scale, { maxLines: 2 })
          : null,
      });
      const heightsOf = (scale: number) => {
        const cells = cellsAt(scale);
        const body = Math.max(cells.leftBody?.heightPx ?? 0, cells.rightBody?.heightPx ?? 0);
        const head = Math.max(cells.leftTitle.heightPx, cells.rightTitle.heightPx);
        return body > 0 ? [head, body] : [head];
      };
      const scaleUsed = fitScale(heightsOf);
      const cells = cellsAt(scaleUsed);
      const [titleY = cy, bodyY = cy] = centers(heightsOf(scaleUsed), cy);
      line(
        0,
        "Title",
        `\\pos(${centerX("left")},${titleY})${sizeTag("Title", cells.leftTitle)}${FADE}`,
        joined(cells.leftTitle),
      );
      line(
        0,
        "Title",
        `\\pos(${centerX("right")},${titleY})${sizeTag("Title", cells.rightTitle)}${FADE}`,
        joined(cells.rightTitle),
      );
      if (cells.leftBody)
        line(
          1,
          "Muted",
          `\\pos(${centerX("left")},${bodyY})${sizeTag("Muted", cells.leftBody)}${FADE}`,
          joined(cells.leftBody),
        );
      if (cells.rightBody)
        line(
          1,
          "Body",
          `\\pos(${centerX("right")},${bodyY})${sizeTag("Body", cells.rightBody)}${FADE}`,
          joined(cells.rightBody),
        );
      line(1, "Big", `\\pos(${cx},${cy})\\fs${vsSize}${POP}`, "VS", { startMs: at(1) });
      break;
    }
    case "question": {
      const placed = column(
        [
          { style: "Big", value: "?", overshoot: POP_SCALE, maxLines: 1 },
          ...lineItems("Title", lines),
        ],
        inner.w,
      );
      for (const [index, { fit: textFit, y }] of placed.entries())
        if (index === 0) line(0, "Big", `\\pos(${cx},${y})${sizeTag("Big", textFit)}${POP}`, "?");
        else
          line(
            index,
            "Title",
            `\\pos(${cx},${y})${sizeTag("Title", textFit)}${FADE}`,
            joined(textFit),
          );
      break;
    }
    case "callout": {
      // 강조 박스: 첫 줄 글 크기에 맞춘 노란 사각형 + 어두운 글자. Shape 스타일이 \an5 라 \pos 는 박스 중심이다.
      const padX = Math.round(W * 0.04);
      const padY = Math.round(H * 0.012);
      const boxMax = Math.floor(inner.w / POP_SCALE);
      const boxFitAt = (scale: number) =>
        fit("Title", first, boxMax - 2 * padX, scale, { maxLines: 2 });
      const bodyFitsAt = (scale: number) =>
        rest.map((value) => fit("Body", value, inner.w, scale, { maxLines: 2 }));
      const heightsOf = (scale: number) => [
        boxFitAt(scale).heightPx + 2 * padY,
        ...bodyFitsAt(scale).map((item) => item.heightPx),
      ];
      const scale = fitScale(heightsOf);
      const titleFit = boxFitAt(scale);
      const bodyFits = bodyFitsAt(scale);
      const [boxY = cy, ...bodyYs] = centers(heightsOf(scale), cy);
      const boxWidth = Math.min(boxMax, Math.max(xr(0.4), titleFit.widthPx + 2 * padX));
      const boxHeight = titleFit.heightPx + 2 * padY;
      line(0, "Shape", `\\an5\\pos(${cx},${boxY})${POP}`, rectVector(boxWidth, boxHeight), {
        layer: 0,
      });
      const ink = THEME.colors.background;
      line(
        0,
        "Title",
        `\\an5\\pos(${cx},${boxY})\\bord0\\shad0\\c&H${ink.slice(4, 6)}${ink.slice(2, 4)}${ink.slice(0, 2)}&${sizeTag("Title", titleFit)}${POP}`,
        joined(titleFit),
        { layer: 1 },
      );
      for (const [index, textFit] of bodyFits.entries())
        line(
          index + 1,
          "Body",
          `\\pos(${cx},${bodyYs[index] ?? cy})${sizeTag("Body", textFit)}${FADE}`,
          joined(textFit),
        );
      break;
    }
    default: {
      const placed = column(lineItems("Title", lines), inner.w);
      for (const [index, { fit: textFit, y }] of placed.entries())
        line(
          index,
          "Title",
          `\\pos(${cx},${y})${sizeTag("Title", textFit)}${FADE}`,
          joined(textFit),
        );
    }
  }
  return `${[header, ...events].join("\n")}\n`;
}
export function cutGraphicAss(cut: TimelineCut, profile: RenderProfile, font: FontSet): string {
  return graphicAss(cut.graphicKind, cut.graphicLines, cut.endMs - cut.startMs, profile, font);
}
