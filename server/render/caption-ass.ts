import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import { CAPTION_LOOK } from "../../shared/caption-direction";
import type { Caption } from "../../shared/narration-captions";
import { StudioError } from "../errors";
import { assColor, assDialogue, assEscape } from "./ass-primitives";
import { captionFontScale, captionFontSupports, captionPopFont } from "./caption-fonts";
import { captionIconEvent } from "./caption-icons";
import type { FontSet } from "./fonts";
import { fitText } from "./text-fit";
import type { RenderProfile } from "./theme";

const slash = String.fromCharCode(92);
const tag = (name: string, value: string | number = "") => `${slash}${name}${value}`;
const alphaTag = (value: number) => `&H${value.toString(16).padStart(2, "0").toUpperCase()}&`;

// 2026-10-12 레퍼런스 쇼츠 스타일(사용자 결정 "앞으로는 이런 스타일로"). 서체는 기본 Pretendard Bold 하나.
// box(plain·옛 handwritten/warm/elegant) = 흰 글자 + 글자에 딱 붙는 반투명 검정 박스(CaptionBox 스타일, BorderStyle 3),
//   핵심어만 노랑.
// emphasis(impact) = 박스 없이 1.3배·검정 외곽선, 핵심어 코랄 빨강 1.1배, 같은 핵심어를 화면 중앙 팝 글자로 한 번 더.
// 실사(chest)·설명(lower) 위치는 그대로. 글자 수를 줄이거나 자르지 않는다(안 들어가면 오류).
export function directedCaptionEvents(
  caption: Caption,
  profile: RenderProfile,
  baseFont: FontSet,
): string[] {
  const look = CAPTION_LOOK[caption.tone ?? "plain"];
  const style = AD_EDIT_STYLE.caption;
  const font = baseFont;
  const scale = profile.height / 1920;
  const sizePx = look === "emphasis" ? style.emphasis.px : style.box.px;
  const base = Math.max(1, Math.round(sizePx * captionFontScale(font) * scale));
  const outline = Math.max(
    1,
    Math.round((look === "emphasis" ? style.emphasis.outlinePx : style.box.paddingPx) * scale),
  );
  const fit = fitText(caption.text, {
    font,
    base,
    maxWidth: profile.width * style.widthRatio,
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
  const white = `${assColor(style.white)}&`;
  const accentRgb = look === "emphasis" ? style.emphasis.keyword : style.box.keyword;
  const accent = `${assColor(accentRgb)}&`;
  const keywordSize = look === "emphasis" ? Math.round(base * style.emphasis.keywordScale) : base;
  const text = fit.lines
    .map((line) => {
      const escaped = assEscape(line, Infinity);
      const at = keyword ? escaped.indexOf(keyword) : -1;
      if (at < 0) return escaped;
      return `${escaped.slice(0, at)}{${tag("c", accent)}${tag("fs", keywordSize)}}${keyword}{${tag("c", white)}${tag("fs", base)}}${escaped.slice(at + keyword.length)}`;
    })
    .join(`${slash}N`);
  const y = Math.round((caption.placement === "chest" ? style.chestY : style.centerY) * scale);
  const x = Math.round(profile.width / 2);
  const position = `${tag("an5")}${tag("pos", `(${x},${y})`)}`;
  const fontTags = `${tag("fn", font.family)}${tag("b", 700)}${tag("fs", base)}`;
  const boxAlpha = alphaTag(style.box.alpha);
  const colors =
    look === "emphasis"
      ? `${tag("c", white)}${tag("3c", `${assColor(style.outline)}&`)}${tag("bord", outline)}${tag("shad", Math.max(1, Math.round(2 * scale)))}`
      : `${tag("c", white)}${tag("3c", "&H000000&")}${tag("3a", boxAlpha)}${tag("4c", "&H000000&")}${tag("4a", boxAlpha)}${tag("bord", outline)}${tag("shad", 0)}`;
  const motion =
    look === "emphasis"
      ? `${tag("fad", "(40,0)")}${tag("fscx", 92)}${tag("fscy", 92)}${tag("t", `(0,160,${tag("fscx", 100)}${tag("fscy", 100)})`)}`
      : tag("fad", "(70,0)");
  const iconSize = Math.max(24, Math.round(88 * scale));
  const events = [
    assDialogue({
      startMs: caption.startMs,
      endMs: caption.endMs,
      style: look === "emphasis" ? "Caption" : "CaptionBox",
      text: `{${position}${fontTags}${colors}${motion}}${text}`,
    }),
    ...captionIconEvent({
      icon: caption.icon ?? "none",
      x: x - iconSize / 2,
      y: y - fit.heightPx / 2 - iconSize - 18 * scale,
      size: iconSize,
      color: accentRgb,
      startMs: caption.startMs,
      endMs: caption.endMs,
    }),
  ];
  if (look === "emphasis" && caption.keyword && caption.placement === "chest")
    events.push(...popWordEvents(caption.keyword, caption, profile, baseFont));
  return events;
}

// 강조 문장의 핵심어를 화면 중앙(얼굴 아래·말 자막 위)에 팝 글자로 한 번 더. 레퍼런스처럼 노랑 채움 + 두꺼운 검정 외곽선 + 그림자,
// 70%→100% 로 튀어나온다. 설명 컷(lower)에는 넣지 않는다(03 라벨이 주인공).
function popWordEvents(
  word: string,
  caption: Caption,
  profile: RenderProfile,
  baseFont: FontSet,
): string[] {
  const style = AD_EDIT_STYLE.caption.pop;
  const scale = profile.height / 1920;
  const preferred = captionPopFont(baseFont);
  const font = captionFontSupports(preferred, word) ? preferred : baseFont;
  const base = Math.max(1, Math.round(style.px * captionFontScale(font) * scale));
  const outline = Math.max(1, Math.round(style.outlinePx * scale));
  const fit = fitText(word, {
    font,
    base,
    maxWidth: profile.width * style.widthRatio,
    outline,
    overshoot: 1,
    minRatio: 0.6,
    maxLines: 1,
  });
  const x = Math.round(profile.width / 2);
  const y = Math.round(style.y * scale);
  const tags = [
    tag("an5"),
    tag("pos", `(${x},${y})`),
    tag("fn", font.family),
    tag("b", font === baseFont ? 700 : 0),
    tag("fs", fit.size),
    tag("c", `${assColor(style.fill)}&`),
    tag("3c", `${assColor(style.outline)}&`),
    tag("bord", outline),
    tag("shad", Math.max(1, Math.round(style.shadowPx * scale))),
    tag("fad", "(40,0)"),
    tag("fscx", 70),
    tag("fscy", 70),
    tag("t", `(0,180,${tag("fscx", 100)}${tag("fscy", 100)})`),
  ].join("");
  return [
    assDialogue({
      startMs: caption.startMs,
      endMs: caption.endMs,
      style: "Pop",
      layer: 1,
      text: `{${tags}}${assEscape(fit.lines.join(" "), Infinity)}`,
    }),
  ];
}
