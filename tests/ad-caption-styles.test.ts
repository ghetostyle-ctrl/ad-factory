import { expect, test } from "bun:test";
import { captionsAss } from "../server/render/ass";
import { assColor } from "../server/render/ass-primitives";
import { directedCaptionEvents } from "../server/render/caption-ass";
import { captionFontSupports, captionPopFont } from "../server/render/caption-fonts";
import { resolveFont } from "../server/render/fonts";
import { DEFAULT_PROFILE } from "../server/render/theme";
import { adCaptionPoints } from "../shared/ad-caption-points";
import { AD_EDIT_STYLE } from "../shared/ad-edit-style";
import { captionDirectionFor, supportedCaptionIcon } from "../shared/caption-direction";
import { CaptionSchema } from "../shared/narration-captions";
import {
  RenderTimelineSchema,
  TimelineCutSchema,
  type TimelineVoice,
} from "../shared/render-timeline";
import { flattenSentences } from "../shared/script-repair";
import {
  scriptDigestJson,
  VideoScriptResponseSchema,
  VideoScriptSchema,
  videoScriptFromFlat,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { flatOf, nestedScriptResponse } from "./video-script-fixture";

const bs = String.fromCharCode(92);
const direction = { tone: "handwritten", keyword: "올리브유", icon: "leaf" } as const;
const text = "올리브유인 줄 알았는데요.";
const voice: TimelineVoice = {
  index: 0,
  text,
  startMs: 0,
  durationMs: 2000,
  tempo: 1,
  words: [],
  artifactName: "voice.wav",
};
function scriptWithDirection() {
  const script = renderScript(1, "concept-1", 36);
  return VideoScriptSchema.parse({
    ...script,
    flow: "copy_first",
    voiceover: [{ ...script.voiceover[0], text, captionDirection: direction }],
  });
}
function timelineWith(caption: Record<string, unknown>) {
  return RenderTimelineSchema.parse({
    number: 1,
    durationMs: 2000,
    extendedMs: 0,
    scriptDigest: "fixture",
    cuts: [],
    voice: [voice],
    warnings: [],
    captions: [{ text, startMs: 0, endMs: 2000, style: "bottom", ...caption }],
  });
}

test("stored caption direction preserves narration without changing old script digests", () => {
  // Given
  const old = VideoScriptSchema.parse(renderScript(1, "concept-1", 36));
  const oldDigest = scriptDigestJson(old);
  // When
  const script = scriptWithDirection();
  // Then
  expect(script.voiceover[0]?.text).toBe(text);
  expect(script.voiceover[0]?.captionDirection).toEqual(direction);
  expect(scriptDigestJson(VideoScriptSchema.parse(old))).toBe(oldDigest);
});

test("caption selection carries approved direction to spoken text only", () => {
  // Given
  const script = scriptWithDirection();
  const cue = CaptionSchema.parse({ text, startMs: 0, endMs: 2000, style: "bottom" });
  // When
  const result = adCaptionPoints([cue], script, [voice], []);
  // Then
  expect(result[0]?.text).toBe(text);
  expect(result[0]?.tone).toBe("handwritten");
  expect(result[0]?.keyword).toBe("올리브유");
  expect(result[0]?.icon).toBe("leaf");
});

// 2026-10-12 레퍼런스 쇼츠 스타일: 말 자막은 Pretendard Bold + 글자에 붙는 반투명 검정 박스. 옛 손글씨 tone 도 같은 모양.
test("spoken captions render as bold sans on a translucent box, even for retired tones", () => {
  // Given
  const font = resolveFont();
  if (!font) throw new Error("bundled font expected");
  const timeline = timelineWith({
    tone: "handwritten",
    keyword: "올리브유",
    icon: "leaf",
    placement: "chest",
  });
  // When
  const ass = captionsAss(timeline, DEFAULT_PROFILE, font);
  const dialogue = ass.split("\n").find((line) => line.includes(",CaptionBox,"));
  // Then
  expect(ass).toMatch(/Style: CaptionBox,[^\n]*,3,\d+,0,5,/);
  expect(dialogue).toBeDefined();
  expect(dialogue).toContain(`${bs}fn${font.family}`);
  expect(dialogue).not.toContain("Nanum Pen");
  expect(dialogue).toContain(`${bs}3a&H70&`);
  expect(dialogue).toContain(`${bs}c${assColor(AD_EDIT_STYLE.caption.box.keyword)}&`);
  expect(ass).toContain(`${bs}p1`);
  expect(ass).toContain("올리브유");
  expect(ass).toContain("인 줄 알았는데요.");
  expect(ass).not.toContain(",Pop,");
  expect(ass).not.toContain("undefined");
});

test("impact captions render larger with an outline and repeat the keyword as a pop word", () => {
  // Given
  const font = resolveFont();
  if (!font) throw new Error("bundled font expected");
  const timeline = timelineWith({ tone: "impact", keyword: "올리브유", placement: "chest" });
  // When
  const lines = captionsAss(timeline, DEFAULT_PROFILE, font).split("\n");
  const line = lines.find(
    (event) => event.startsWith("Dialogue: 0,") && event.includes(",Caption,"),
  );
  const pop = lines.find((event) => event.startsWith("Dialogue: 1,") && event.includes(",Pop,"));
  // Then
  expect(line).toBeDefined();
  expect(line).toContain(`${bs}fn${font.family}`);
  expect(line).toContain(`${bs}c${assColor(AD_EDIT_STYLE.caption.emphasis.keyword)}&`);
  expect(line).not.toContain(`${bs}3a`);
  expect(pop).toBeDefined();
  expect(pop).toContain(`${bs}fnBlack Han Sans`);
  expect(pop).toContain(`${bs}c${assColor(AD_EDIT_STYLE.caption.pop.fill)}&`);
  expect(pop).toContain(`${bs}pos(540,${AD_EDIT_STYLE.caption.pop.y})`);
  expect(pop).toContain("올리브유");
  const size = (event: string | undefined) => Number(/\\fs(\d+)/.exec(event ?? "")?.[1] ?? 0);
  expect(size(line)).toBeGreaterThan(
    size(lines.find((event) => event.includes(",CaptionBox,")) ?? `${bs}fs0`) || 0,
  );
});

test("impact captions on explainer cuts keep the lower box look without a pop word", () => {
  const font = resolveFont();
  if (!font) throw new Error("bundled font expected");
  const events = directedCaptionEvents(
    CaptionSchema.parse({
      text,
      startMs: 0,
      endMs: 2000,
      style: "bottom",
      tone: "impact",
      keyword: "올리브유",
      placement: "lower",
    }),
    DEFAULT_PROFILE,
    font,
  );
  expect(events.some((event) => event.includes(",Pop,"))).toBe(false);
  expect(events[0]).toContain(`${bs}pos(540,${AD_EDIT_STYLE.caption.centerY})`);
});

test("INFO overlap keeps neutral captions below labels without extra emphasis", () => {
  const script = scriptWithDirection();
  const cue = CaptionSchema.parse({
    text,
    startMs: 0,
    endMs: 2000,
    style: "pop",
    keyword: "올리브유",
  });
  const cut = TimelineCutSchema.parse({
    index: 0,
    startMs: 1000,
    endMs: 3000,
    purpose: "proof",
    source: "veo_clip",
    effect: "hard_cut",
    onScreenText: "",
    caption: null,
    graphicKind: "",
    graphicLines: [],
    sourceRef: { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
  });
  expect(adCaptionPoints([cue], script, [voice], [cut])[0]).toEqual({
    text,
    startMs: 0,
    endMs: 2000,
    style: "bottom",
    tone: "plain",
    icon: "none",
    placement: "lower",
  });
});

test("absent emphasis and coincidental Korean syllables do not create icons", () => {
  const line = scriptWithDirection().voiceover[0];
  if (!line) throw new Error("fixture voice missing");
  expect(
    captionDirectionFor({
      ...line,
      captionDirection: { tone: "warm", keyword: "할인", icon: "coin" },
    }),
  ).toEqual({ tone: "warm", keyword: "", icon: "none" });
  for (const [icon, keyword] of [
    ["coin", "원재료명"],
    ["clock", "성분"],
    ["bottle", "유통"],
    ["drop", "건물"],
  ] as const)
    expect(supportedCaptionIcon(icon, keyword)).toBe("none");
  expect(supportedCaptionIcon("coin", "3,000원")).toBe("coin");
  expect(supportedCaptionIcon("clock", "5분")).toBe("clock");
});

test("scripts without stored direction emphasize only the pain hook and the call to action", () => {
  const line = scriptWithDirection().voiceover[0];
  if (!line) throw new Error("fixture voice missing");
  const toneOf = (chainStep: typeof line.chainStep) =>
    captionDirectionFor({ ...line, captionDirection: undefined, chainStep }).tone;
  expect(toneOf("pain")).toBe("impact");
  expect(toneOf("cta")).toBe("impact");
  expect(toneOf("product_fact")).toBe("plain");
  expect(toneOf("")).toBe("plain");
});

test("pop word glyphs missing from Black Han Sans fall back to the bundled plain font", () => {
  const font = resolveFont();
  if (!font) throw new Error("bundled font expected");
  const unusual = "갂";
  expect(captionFontSupports(captionPopFont(font), unusual)).toBe(false);
  const pop = directedCaptionEvents(
    CaptionSchema.parse({
      text: unusual,
      startMs: 0,
      endMs: 1000,
      style: "bottom",
      tone: "impact",
      keyword: unusual,
      placement: "chest",
    }),
    DEFAULT_PROFILE,
    font,
  ).find((event) => event.includes(",Pop,"));
  expect(pop).toBeDefined();
  expect(pop).toContain(`${bs}fn${font.family}`);
  expect(pop).not.toContain("Black Han Sans");
  expect(pop).toContain(unusual);
});

test("unreadably long captions stop rendering instead of shrinking or cutting copy", () => {
  const font = resolveFont();
  if (!font) throw new Error("bundled font expected");
  expect(() =>
    directedCaptionEvents(
      CaptionSchema.parse({
        text: "올리브유 원재료를 확인하세요 ".repeat(12).trim(),
        startMs: 0,
        endMs: 1000,
        style: "bottom",
        tone: "handwritten",
      }),
      DEFAULT_PROFILE,
      font,
    ),
  ).toThrow("문구를 자르지 말고");
});

test("scene response direction survives flattening and stored script parsing", () => {
  const original = VideoScriptSchema.parse(renderScript(1, "concept-1", 36));
  original.voiceover = original.voiceover.map((line, index) =>
    index === 0 ? { ...line, text, captionDirection: direction } : line,
  );
  const response = VideoScriptResponseSchema.parse(nestedScriptResponse(flatOf(original)));
  const flat = flattenSentences(response, { number: 1, hypothesisId: "concept-1", targetSec: 36 });
  const saved = VideoScriptSchema.parse(videoScriptFromFlat(flat));
  expect(saved.voiceover[0]?.captionDirection).toEqual(direction);
  expect(saved.voiceover[0]?.text).toBe(text);
});
