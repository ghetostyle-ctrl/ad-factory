import type { z } from "zod";
import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import type {
  RenderTimeline,
  SubjectBox,
  TimelineCallout,
  TimelineCut,
} from "../../shared/render-timeline";
import { type GraphicKindSchema, isInfoClipId } from "../../shared/video-script";
import { motionCalloutEvents } from "./ass-motion";
import { assColor, assDialogue, assEscape, assLines } from "./ass-primitives";
import type { FontSet } from "./fonts";
import { effectiveGraphicKind, graphicCaptionSpans } from "./graphic-captions";
import { fitLines, fitText, lineEm, type TextFit } from "./text-fit";
import {
  type RenderProfile,
  renderColors,
  renderStylePolicy,
  THEME,
  themePx,
  type VisualPolicy,
} from "./theme";

export { assColor, assDialogue, assEscape, assLines, assTime } from "./ass-primitives";

// ASS(libass) 자막·모션그래픽 빌더. drawtext 는 쓰지 않는다(8.1 win64 결함 실측). 좌표·크기는 프로파일 비례.
type GraphicKind = z.infer<typeof GraphicKindSchema>;
export const ASS_LINE_STAGGER_MS = 350;
// 캡션 애니메이션: 80ms 페이드인. 팝: 40%→115%→100%.
const FADE = "\\fad(80,0)";
const POP =
  "\\fad(60,0)\\fscx40\\fscy40\\t(0,180,\\fscx115\\fscy115)\\t(180,300,\\fscx100\\fscy100)";

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
  readonly outlineColor?: string;
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
        `Style: ${style.name},${font.family},${style.fontSize},${style.primary},${assColor("0000FF")},${style.outlineColor ?? assColor("000000")},${assColor("000000", 0x80)},${style.bold === false ? 0 : -1},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},${style.marginL},${style.marginR},${style.marginV},1`,
    ),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return lines.join("\n");
}
// 1080x1920 기준 px 를 프로파일 비례로(최소 1)
const px = (profile: RenderProfile, base: number) =>
  Math.max(1, Math.round((base * profile.height) / 1920));
function captionStyles(profile: RenderProfile, policy?: VisualPolicy): AssStyle[] {
  const colors = renderColors(policy);
  const common = {
    primary: assColor(colors.text),
    ...(policy ? { outlineColor: assColor(colors.background) } : {}),
    outline: px(profile, policy ? 3 : 6),
    shadow: policy ? 0 : px(profile, 2),
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
      fontSize: px(profile, policy ? 42 : 28),
      alignment: 8,
      marginV: themePx(profile, 0.235),
      bold: false,
      outline: px(profile, 2),
      shadow: 0,
    },
    ...calloutStyles(profile, policy),
  ];
}
// ASS 는 자동 줄바꿈이 없어(WrapStyle 2) 긴 줄은 프레임 밖으로 잘린다. 줄 폭(text-fit.ts 의 진행폭)으로
// 글꼴 크기를 줄여 맞춘다: 하단 캡션은 좌우 세이프존(릴스 UI) 안, 팝은 115% 확대 최대치가 프레임 폭의 96% 안.
const POP_SCALE = 1.15;
const fontSizeTag = (fit: TextFit, base: number): string =>
  fit.size < base ? `\\fs${fit.size}` : "";
// captions-<n>.ass: 컷 자막. text_pop 컷은 하단 캡션 대신 중앙 팝.
export function captionsAss(
  timeline: RenderTimeline,
  profile: RenderProfile,
  font: FontSet,
): string {
  const policy = renderStylePolicy(timeline.visualPolicy);
  const colors = {
    ...renderColors(policy),
    text: AD_EDIT_STYLE.caption.white,
    accent: AD_EDIT_STYLE.caption.accent,
  };
  const styles = captionStyles(profile, policy).map((style) =>
    style.name === "Caption" || style.name === "Pop"
      ? {
          ...style,
          fontSize: px(
            profile,
            (style.name === "Pop"
              ? AD_EDIT_STYLE.caption.pointPx
              : AD_EDIT_STYLE.caption.normalPx) * (font.family === "Pretendard" ? 2444 / 2048 : 1),
          ),
          primary: assColor(AD_EDIT_STYLE.caption.white),
          outlineColor: assColor(AD_EDIT_STYLE.caption.outline),
          outline: px(profile, style.name === "Pop" ? 7 : 5),
          shadow: px(profile, 3),
          alignment: 5,
          marginV: 0,
        }
      : style,
  );
  const header = assHeader(profile, font, styles);
  const baseOf = (name: string) => styles.find((style) => style.name === name)?.fontSize ?? 1;
  const outline = px(profile, 6);
  const center = `\\pos(${Math.round(profile.width / 2)},${px(profile, AD_EDIT_STYLE.caption.centerY)})`;
  const captions = (
    timeline.captions ?? timeline.cuts.flatMap((cut) => (cut.caption ? [cut.caption] : []))
  ).flatMap((caption) =>
    timeline.captions &&
    timeline.voice.some(
      (voice) =>
        caption.startMs < voice.startMs + voice.durationMs && caption.endMs > voice.startMs,
    )
      ? [caption]
      : graphicCaptionSpans(caption, timeline.cuts, ASS_LINE_STAGGER_MS),
  );
  const events = captions.flatMap((caption) => {
    if (!caption.text.trim()) return [];
    const base = baseOf(caption.style === "pop" ? "Pop" : "Caption");
    const fitted = fitText(caption.text, {
      font,
      base,
      outline,
      maxWidth: profile.width * AD_EDIT_STYLE.caption.widthRatio,
      minRatio: 1,
      maxLines: 2,
    });
    const lines = fitted.lines.map((line) => assEscape(line, Number.POSITIVE_INFINITY));
    let text = lines.join("\\N");
    const keyword = caption.keyword ? assEscape(caption.keyword, Number.POSITIVE_INFINITY) : "";
    if (keyword && text.includes(keyword)) {
      const at = text.indexOf(keyword);
      text = `${text.slice(0, at)}{\\c${assColor(colors.accent)}&}${keyword}{\\c${assColor(colors.text)}&}${text.slice(at + keyword.length)}`;
    }
    const point = caption.style === "pop";
    const motion = point ? "\\fscx94\\fscy94\\t(0,200,\\fscx100\\fscy100)" : "";
    return [
      assDialogue({
        startMs: caption.startMs,
        endMs: caption.endMs,
        style: point ? "Pop" : "Caption",
        text: `{${center}${FADE}${fontSizeTag(fitted, base)}${motion}}${text}`,
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
    // 고정 제목은 설명 컷(I1~I3) 위에서 숨긴다. 실측(2026-10-06): INFO 프레임이 머리글·라벨을 직접 가지므로
    // 제목이 그 위에 겹쳐 두 글이 포개졌다. 면책 문구는 법적 표시라 끊지 않는다.
    const spans =
      slot.name === "FixedTitle"
        ? fixedTitleSpans(timeline)
        : [{ startMs: 0, endMs: timeline.durationMs }];
    for (const span of spans)
      events.push(
        assDialogue({
          startMs: span.startMs,
          endMs: span.endMs,
          style: slot.name,
          text: `{${fontSizeTag(fit, base)}}${lines.join("\\N")}`,
          layer: 1,
        }),
      );
  }
  // 콜아웃(R7)은 캡션·제목 이벤트 뒤에 붙인다(레이어 2~4 라 그리는 순서와 무관하게 위에 놓인다).
  events.push(...calloutEvents(timeline, profile, font));
  return `${[header, ...events].join("\n")}\n`;
}
// 설명 컷(Flow 에서 만든 CLEAN→INFO 전환 클립)을 뺀 구간. 인접한 설명 컷은 하나로 합친다.
export function fixedTitleSpans(
  timeline: Pick<RenderTimeline, "durationMs" | "cuts">,
): { readonly startMs: number; readonly endMs: number }[] {
  const hidden = timeline.cuts
    .filter((cut) => cut.sourceRef.kind === "veo" && isInfoClipId(cut.sourceRef.clipId))
    .map((cut) => ({ startMs: cut.startMs, endMs: cut.endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  const spans: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const gap of hidden) {
    if (gap.startMs > cursor) spans.push({ startMs: cursor, endMs: gap.startMs });
    cursor = Math.max(cursor, gap.endMs);
  }
  if (cursor < timeline.durationMs) spans.push({ startMs: cursor, endMs: timeline.durationMs });
  return spans;
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
  policy?: VisualPolicy,
): string {
  const colors = renderColors(policy);
  const W = profile.width;
  const H = profile.height;
  const xr = (ratio: number) => Math.round(W * ratio);
  const yr = (ratio: number) => Math.round(H * ratio);
  const accent = assColor(colors.accent);
  const muted = assColor(colors.muted);
  const metrics = {
    Big: { base: themePx(profile, THEME.scale.graphicNumber), outline: px(profile, 6) },
    Title: { base: themePx(profile, THEME.scale.graphicTitle), outline: px(profile, 6) },
    Body: { base: themePx(profile, THEME.scale.graphicBody), outline: px(profile, 5) },
    Muted: { base: themePx(profile, THEME.scale.graphicBody), outline: px(profile, 6) },
  } as const;
  const base = {
    primary: assColor(colors.text),
    ...(policy ? { outlineColor: assColor(colors.background) } : {}),
    outline: policy ? 0 : px(profile, 6),
    shadow: policy ? 0 : px(profile, 4),
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
      const ink = policy ? colors.text : colors.background;
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
  return graphicAss(
    effectiveGraphicKind(cut),
    cut.graphicLines,
    cut.endMs - cut.startMs,
    profile,
    font,
    renderStylePolicy(cut.visualPolicy),
  );
}

// --- 콜아웃(R7, 2026-10-06) ------------------------------------------------------------------------------
// 문장의 어절이 발음되는 시각에 뜨는 큰 표시: 라벨(둥근 반투명 어두운 박스 + 글자, 숫자는 강조색)·링(타원 테두리)·
// 화살표(두꺼운 선 + 삼각 촉, 앵커 존에서 대상 쪽으로)·체크(checkVector 를 키운 것). 크기는 1080 기준 선 13px·
// 라벨 64px 볼드·링 두께 14px(프로파일 비례). 콜아웃마다 팔레트 3색을 돌려 쓰고, 같은 도형을 강조색 \blur 로
// 아래 레이어에 한 번 더 그려 글로우를 만든다. 위치는 anchor 존(subject = 컷의 subjectBox 중심, left/right =
// 너비 30%/70%·높이 55%, top = 24%, bottom = 66%)이고 세이프존(릴스 UI)과 하단 음성 자막 영역(floor)을
// 침범하지 않게 상자를 안으로 민다. \p1 좌표는 모두 0 이상이고 bbox 중심을 \an5\pos 로 둔다.
export const CALLOUT_LAYER = { glow: 2, shape: 3, text: 4 } as const;
export const DEFAULT_SUBJECT_BOX: SubjectBox = { x: 0.3, y: 0.38, w: 0.4, h: 0.3 };
// 등장: 60ms 페이드인 + 70%→108%→100% 확대(캡션 POP 과 같은 톤, 180ms).
const CALLOUT_POP =
  "\\fad(60,0)\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)\\t(120,180,\\fscx100\\fscy100)";
const BEZIER_K = 0.5523;
type Point = { readonly x: number; readonly y: number };
type Size = { readonly w: number; readonly h: number };
type Rect = Point & Size;
function calloutStyles(profile: RenderProfile, policy?: VisualPolicy): AssStyle[] {
  const colors = renderColors(policy);
  const base = { shadow: 0, alignment: 5, marginL: 0, marginR: 0, marginV: 0 };
  return [
    {
      ...base,
      name: "Callout",
      fontSize: themePx(profile, THEME.callout.label),
      primary: assColor(colors.text),
      ...(policy ? { outlineColor: assColor(colors.background) } : {}),
      outline: px(profile, 3),
    },
    {
      ...base,
      name: "CalloutShape",
      fontSize: 20,
      primary: assColor(colors.accent),
      outline: 0,
    },
    ...["MotionLeader", "MotionTarget"].map((name) => ({
      ...base,
      name,
      fontSize: 20,
      primary: assColor(colors.accent),
      outline: 0,
    })),
  ];
}
// 색 인덱스(타임라인 callouts[].color) → 팔레트 RGB. 범위 밖이면 돌려서 고른다.
export function calloutAccent(color: number): string {
  const colors = THEME.colors;
  const palette = colors.accents;
  const index = ((color % palette.length) + palette.length) % palette.length;
  return palette[index] ?? colors.accent;
}
const fmt = (value: number) => String(Math.round(value));
const pt = (x: number, y: number) => `${fmt(x)} ${fmt(y)}`;
const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
  `b ${pt(x1, y1)} ${pt(x2, y2)} ${pt(x3, y3)}`;
// 타원 한 바퀴(3차 베지에 4개). clockwise=false 는 반대 방향: 링의 안쪽 구멍이 어느 채움 규칙에서도 비게 한다.
function ellipsePath(cx: number, cy: number, rx: number, ry: number, clockwise: boolean): string {
  const k = BEZIER_K;
  const start = `m ${pt(cx + rx, cy)}`;
  if (clockwise)
    return [
      start,
      curve(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
      curve(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
      curve(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
      curve(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
    ].join(" ");
  return [
    start,
    curve(cx + rx, cy - k * ry, cx + k * rx, cy - ry, cx, cy - ry),
    curve(cx - k * rx, cy - ry, cx - rx, cy - k * ry, cx - rx, cy),
    curve(cx - rx, cy + k * ry, cx - k * rx, cy + ry, cx, cy + ry),
    curve(cx + k * rx, cy + ry, cx + rx, cy + k * ry, cx + rx, cy),
  ].join(" ");
}
// 링: 바깥 타원(시계) + 안쪽 타원(반시계) = 두께 thickness 의 테두리. bbox 는 (0,0)~(w,h).
export function ringVector(size: Size, thickness: number): string {
  const rx = size.w / 2;
  const ry = size.h / 2;
  const inner = { rx: Math.max(1, rx - thickness), ry: Math.max(1, ry - thickness) };
  return `{\\p1}${ellipsePath(rx, ry, rx, ry, true)} ${ellipsePath(rx, ry, inner.rx, inner.ry, false)}{\\p0}`;
}
// 둥근 사각형(라벨 박스). bbox 는 (0,0)~(w,h).
export function roundedRectVector(size: Size, radius: number): string {
  const { w, h } = size;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const k = BEZIER_K;
  return [
    `{\\p1}m ${pt(r, 0)} l ${pt(w - r, 0)}`,
    curve(w - r + k * r, 0, w, r - k * r, w, r),
    `l ${pt(w, h - r)}`,
    curve(w, h - r + k * r, w - r + k * r, h, w - r, h),
    `l ${pt(r, h)}`,
    curve(r - k * r, h, 0, h - r + k * r, 0, h - r),
    `l ${pt(0, r)}`,
    `${curve(0, r - k * r, r - k * r, 0, r, 0)}{\\p0}`,
  ].join(" ");
}
type Shape = { readonly drawing: string; readonly size: Size; readonly center: Point };
// 다각형: 점들을 bbox 왼쪽 위가 (0,0) 이 되게 옮겨 적고, 원래 bbox 중심을 돌려준다(\an5\pos 에 쓴다).
function polygonShape(points: readonly Point[]): Shape {
  const [first, ...rest] = points;
  if (!first) return { drawing: "", size: { w: 0, h: 0 }, center: { x: 0, y: 0 } };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const size = { w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  const drawing = `{\\p1}m ${pt(first.x - minX, first.y - minY)} ${rest
    .map((point) => `l ${pt(point.x - minX, point.y - minY)}`)
    .join(" ")}{\\p0}`;
  return { drawing, size, center: { x: minX + size.w / 2, y: minY + size.h / 2 } };
}
// 화살표: from 에서 to(촉 끝)까지 두께 thickness 의 선 + 삼각 촉(길이 3.2배·반폭 1.9배).
export function arrowShape(from: Point, to: Point, thickness: number): Shape {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const head = Math.min(length, thickness * 3.2);
  const headHalf = thickness * 1.9;
  const half = thickness / 2;
  const base = { x: to.x - ux * head, y: to.y - uy * head };
  return polygonShape([
    { x: from.x + nx * half, y: from.y + ny * half },
    { x: base.x + nx * half, y: base.y + ny * half },
    { x: base.x + nx * headHalf, y: base.y + ny * headHalf },
    to,
    { x: base.x - nx * headHalf, y: base.y - ny * headHalf },
    { x: base.x - nx * half, y: base.y - ny * half },
    { x: from.x - nx * half, y: from.y - ny * half },
  ]);
}
// 체크 표시: checkVector(1080 기준 60x48, 음수 좌표 포함)를 0 이상으로 옮기고 scale 배 키운 것(기본 2.5배 = 150x120).
export function calloutCheckShape(profile: RenderProfile, scale = 2.5): Shape {
  const s = (profile.height / 1920) * scale;
  const raw: readonly Point[] = [
    { x: 0, y: 28 },
    { x: 20, y: 48 },
    { x: 60, y: 8 },
    { x: 52, y: 0 },
    { x: 20, y: 32 },
    { x: 8, y: 20 },
  ];
  return polygonShape(raw.map((point) => ({ x: point.x * s, y: point.y * s })));
}
// 컷의 대상 상자(비율) → 픽셀. 타임라인에 없으면 기본 상자.
export function subjectBoxPx(box: SubjectBox | undefined, profile: RenderProfile): Rect {
  const ratio = box ?? DEFAULT_SUBJECT_BOX;
  return {
    x: ratio.x * profile.width,
    y: ratio.y * profile.height,
    w: ratio.w * profile.width,
    h: ratio.h * profile.height,
  };
}
// 앵커 존의 기준점(픽셀).
export function calloutZonePoint(
  anchor: TimelineCallout["anchor"],
  box: Rect,
  profile: RenderProfile,
): Point {
  const W = profile.width;
  const H = profile.height;
  switch (anchor) {
    case "subject":
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    case "left":
      return { x: W * THEME.callout.zoneSide, y: H * THEME.callout.zoneY };
    case "right":
      return { x: W * (1 - THEME.callout.zoneSide), y: H * THEME.callout.zoneY };
    case "top":
      return { x: W / 2, y: H * THEME.callout.zoneTop };
    case "bottom":
      return { x: W / 2, y: H * THEME.callout.zoneBottom };
    default:
      return anchor satisfies never;
  }
}
// 상자(size)가 세이프존 안·자막 윗선(floor) 위에 들어오도록 중심을 민다. 상자가 범위보다 크면 범위 가운데에 둔다.
// topRatio 는 위쪽 한계(기본 릴스 UI 세이프존, 면책 문구가 있으면 그 아래 THEME.artwork.top).
export function clampCalloutCenter(
  center: Point,
  size: Size,
  profile: RenderProfile,
  topRatio: number = THEME.safe.top,
): Point {
  const W = profile.width;
  const H = profile.height;
  const minX = W * THEME.safe.side + size.w / 2;
  const maxX = W * (1 - THEME.safe.side) - size.w / 2;
  const minY = H * topRatio + size.h / 2;
  const maxY = H * THEME.callout.floor - size.h / 2;
  return {
    x: minX > maxX ? W / 2 : Math.min(maxX, Math.max(minX, center.x)),
    y:
      minY > maxY
        ? (H * (topRatio + THEME.callout.floor)) / 2
        : Math.min(maxY, Math.max(minY, center.y)),
  };
}
type CalloutDrawing = Shape & { readonly label: TextFit | null };
function calloutDrawing(
  callout: TimelineCallout,
  box: Rect,
  profile: RenderProfile,
  font: FontSet,
): CalloutDrawing {
  const W = profile.width;
  const H = profile.height;
  const zone = calloutZonePoint(callout.anchor, box, profile);
  switch (callout.kind) {
    case "ring": {
      const thickness = Math.max(2, themePx(profile, THEME.callout.ring));
      // 대상 앵커는 대상 상자를 두르고, 다른 존은 너비 26% 의 원.
      const size =
        callout.anchor === "subject"
          ? { w: box.w + 2 * thickness, h: box.h + 2 * thickness }
          : { w: W * 0.26, h: W * 0.26 };
      return { drawing: ringVector(size, thickness), size, center: zone, label: null };
    }
    case "label": {
      const padX = Math.round(W * 0.03);
      const padY = Math.round(H * 0.012);
      const outline = px(profile, 3);
      const fit = fitText(assEscape(callout.text, Number.POSITIVE_INFINITY), {
        font,
        base: themePx(profile, THEME.callout.label),
        outline,
        maxWidth: W * (1 - 2 * THEME.safe.side) - 2 * padX,
        maxLines: 1,
      });
      const size = { w: fit.widthPx + 2 * outline + 2 * padX, h: fit.heightPx + 2 * padY };
      return {
        drawing: roundedRectVector(size, Math.round(H * 0.012)),
        size,
        center: zone,
        label: fit,
      };
    }
    case "arrow": {
      const thickness = Math.max(2, themePx(profile, THEME.callout.line));
      // 대상 앵커의 화살표는 왼쪽 존에서 대상으로 향한다(대상 중심에서 출발할 수는 없다).
      const start = callout.anchor === "subject" ? calloutZonePoint("left", box, profile) : zone;
      const target = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const dx = start.x - target.x;
      const dy = start.y - target.y;
      const distance = Math.hypot(dx, dy) || 1;
      const ux = dx / distance;
      const uy = dy / distance;
      // 촉은 대상 상자 가장자리에서 멈춘다(얼굴·제품을 가리지 않게): 중심에서 그 방향으로 반폭·반높이 중 먼저 닿는 쪽.
      const reach = Math.min(
        Math.abs(ux) > 1e-6 ? box.w / 2 / Math.abs(ux) : Number.POSITIVE_INFINITY,
        Math.abs(uy) > 1e-6 ? box.h / 2 / Math.abs(uy) : Number.POSITIVE_INFINITY,
      );
      const tip = { x: target.x + ux * reach, y: target.y + uy * reach };
      const length = Math.max(H * 0.1, distance - reach);
      const tail = { x: tip.x + ux * length, y: tip.y + uy * length };
      return { ...arrowShape(tail, tip, thickness), label: null };
    }
    case "check":
      return { ...calloutCheckShape(profile), center: zone, label: null };
    default:
      return callout.kind satisfies never;
  }
}
// 타임라인 콜아웃 → ASS Dialogue 줄(글로우·도형·라벨 글자). 콜아웃이 없는 예전 타임라인은 [].
export function calloutEvents(
  timeline: Pick<RenderTimeline, "cuts" | "callouts" | "disclaimer" | "visualPolicy">,
  profile: RenderProfile,
  font: FontSet,
): string[] {
  const policy = renderStylePolicy(timeline.visualPolicy);
  const colors = renderColors(policy);
  const events: string[] = [];
  const blur = px(profile, 8);
  const glowBorder = px(profile, 6);
  const labelBase = themePx(profile, THEME.callout.label);
  // 면책 문구(법적 표시, 높이 23.5%~)가 있으면 콜아웃은 그 아래에서만 움직인다.
  const top = timeline.disclaimer?.trim() ? THEME.artwork.top : THEME.safe.top;
  for (const callout of timeline.callouts ?? []) {
    const cut = timeline.cuts.find((item) => item.index === callout.cutIndex);
    if (policy && (cut?.sourceRef.kind === "graphic" || cut?.effect === "text_pop")) continue;
    if (callout.motion?.verification === "verified" && cut) {
      events.push(
        ...motionCalloutEvents({ ...callout, motion: callout.motion }, cut, {
          profile,
          font,
          top,
          policy,
        }),
      );
      continue;
    }
    const box = subjectBoxPx(cut?.subjectBox, profile);
    const drawable = callout.motion ? { ...callout, kind: "label" as const } : callout;
    const shape = calloutDrawing(drawable, box, profile, font);
    if (!shape.drawing) continue;
    const accent = assColor(policy ? colors.accent : calloutAccent(callout.color));
    const at = clampCalloutCenter(shape.center, shape.size, profile, top);
    const pos = `\\an5\\pos(${fmt(at.x)},${fmt(at.y)})`;
    const timing = { startMs: callout.startMs, endMs: callout.endMs };
    // 글로우: 같은 도형을 강조색·테두리·\blur 로 아래 레이어에
    if (!policy)
      events.push(
        assDialogue({
          ...timing,
          style: "CalloutShape",
          layer: CALLOUT_LAYER.glow,
          text: `{${pos}\\1c${accent}&\\3c${accent}&\\bord${glowBorder}\\blur${blur}${CALLOUT_POP}}${shape.drawing}`,
        }),
      );
    // 본체: 라벨은 반투명 어두운 박스, 나머지는 강조색 채움
    const fill = shape.label ? `\\1c${assColor(colors.background)}&\\1a&H40&` : `\\1c${accent}&`;
    events.push(
      assDialogue({
        ...timing,
        style: "CalloutShape",
        layer: CALLOUT_LAYER.shape,
        text: `{${pos}${fill}\\bord0${CALLOUT_POP}}${shape.drawing}`,
      }),
    );
    if (shape.label) {
      // 숫자 묶음은 강조색(자막 keyword 와 같은 방식). 입력은 한글·숫자라 변환 없이 escape 만 한다.
      const text = shape.label.lines
        .join("\\N")
        .replace(
          /\d+(?:[.,]\d+)*/g,
          (digits) => `{\\c${accent}&}${digits}{\\c${assColor(colors.text)}&}`,
        );
      events.push(
        assDialogue({
          ...timing,
          style: "Callout",
          layer: CALLOUT_LAYER.text,
          text: `{${pos}${fontSizeTag(shape.label, labelBase)}${CALLOUT_POP}}${text}`,
        }),
      );
    }
  }
  return events;
}
