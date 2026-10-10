import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import { CAPTION_TONES } from "../../shared/caption-direction";
import type { Caption } from "../../shared/narration-captions";
import { StudioError } from "../errors";
import { assColor, assDialogue, assEscape } from "./ass-primitives";
import { captionFont, captionFontScale, captionFontSupports } from "./caption-fonts";
import { captionIconEvent } from "./caption-icons";
import type { FontSet } from "./fonts";
import { fitText } from "./text-fit";
import type { RenderProfile } from "./theme";

const slash = String.fromCharCode(92);
const tag = (name: string, value: string | number = "") => `${slash}${name}${value}`;
export function directedCaptionEvents(
  caption: Caption,
  profile: RenderProfile,
  baseFont: FontSet,
): string[] {
  const tone = caption.tone ?? "plain";
  const style = CAPTION_TONES[tone];
  const selected = captionFont(tone, baseFont);
  const font = captionFontSupports(selected, caption.text) ? selected : baseFont;
  const sizePx = font === baseFont && tone !== "plain" ? CAPTION_TONES.plain.px : style.px;
  const scale = profile.height / 1920;
  const base = Math.max(1, Math.round(sizePx * captionFontScale(font) * scale));
  const outline = Math.max(
    1,
    Math.round((tone === "handwritten" || tone === "elegant" ? 3 : 5) * scale),
  );
  const fit = fitText(caption.text, {
    font,
    base,
    maxWidth: profile.width * AD_EDIT_STYLE.caption.widthRatio,
    outline,
    overshoot: 1.1,
    minRatio: 1,
    maxLines: 2,
  });
  if (fit.size < base * 0.98)
    throw new StudioError(
      "caption_fit",
      `자막이 모바일 안전 영역에 들어오지 않습니다. 문구를 자르지 말고 구절 경계를 조정하세요: ${caption.text}`,
    );
  const keyword = caption.keyword ? assEscape(caption.keyword, Infinity) : "";
  const white = `${assColor(AD_EDIT_STYLE.caption.white)}&`;
  const accent = `${assColor(style.accent)}&`;
  const text = fit.lines
    .map((line) => {
      const escaped = assEscape(line, Infinity);
      const at = keyword ? escaped.indexOf(keyword) : -1;
      if (at < 0) return escaped;
      return `${escaped.slice(0, at)}{${tag("c", accent)}${tag("fs", Math.round(base * 1.08))}}${keyword}{${tag("c", white)}${tag("fs", base)}}${escaped.slice(at + keyword.length)}`;
    })
    .join(`${slash}N`);
  const y = Math.round(
    (caption.placement === "chest" ? AD_EDIT_STYLE.caption.chestY : AD_EDIT_STYLE.caption.centerY) *
      scale,
  );
  const x = Math.round(profile.width / 2);
  const motion = {
    plain: tag("fad", "(70,0)"),
    handwritten: tag("fad", "(120,0)"),
    impact: `${tag("fad", "(40,0)")}${tag("fscx", 92)}${tag("fscy", 92)}${tag("t", `(0,160,${tag("fscx", 100)}${tag("fscy", 100)})`)}`,
    warm: `${tag("fad", "(100,0)")}${tag("fscx", 96)}${tag("fscy", 96)}${tag("t", `(0,180,${tag("fscx", 100)}${tag("fscy", 100)})`)}`,
    elegant: tag("fad", "(150,0)"),
  }[tone];
  const fontTags = `${tag("fn", font.family)}${tag("b", style.bold || font === baseFont ? 700 : 0)}${tag("fs", base)}`;
  const position = `${tag("an5")}${tag("pos", `(${x},${y})`)}`;
  const colors = `${tag("c", white)}${tag("3c", "&H1C2517&")}${tag("bord", outline)}${tag("shad", Math.max(1, Math.round(2 * scale)))}`;
  const iconSize = Math.max(24, Math.round(88 * scale));
  return [
    assDialogue({
      startMs: caption.startMs,
      endMs: caption.endMs,
      style: "Caption",
      text: `{${position}${fontTags}${colors}${motion}}${text}`,
    }),
    ...captionIconEvent({
      icon: caption.icon ?? "none",
      x: x - iconSize / 2,
      y: y - fit.heightPx / 2 - iconSize - 18 * scale,
      size: iconSize,
      color: style.accent,
      startMs: caption.startMs,
      endMs: caption.endMs,
    }),
  ];
}
