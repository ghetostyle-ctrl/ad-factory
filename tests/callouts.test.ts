import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  arrowShape,
  assColor,
  CALLOUT_LAYER,
  calloutAccent,
  calloutCheckShape,
  calloutEvents,
  captionsAss,
  clampCalloutCenter,
  DEFAULT_SUBJECT_BOX,
  ringVector,
  roundedRectVector,
  subjectBoxPx,
} from "../server/render/ass";
import { ffPath, fontOnlyDir, runFfmpeg, runFfprobeJson } from "../server/render/ffmpeg";
import { type FontSet, resolveFont } from "../server/render/fonts";
import { effectFilters, segmentDigest, veoSegmentArgs } from "../server/render/segments";
import { DEFAULT_PROFILE, THEME, THEME_VERSION } from "../server/render/theme";
import { CAPTION_LEAD_MS } from "../shared/narration-captions";
import {
  buildTimeline,
  CALLOUT_COLORS,
  type RenderTimeline,
  RenderTimelineSchema,
  type TimelineCut,
  type TimelineWord,
  timelineDigest,
  type VoiceMeasurement,
} from "../shared/render-timeline";
import type { Callout, VideoScript } from "../shared/video-script";
import { removeTemp, renderProfile, renderScript, renderTemp, tinyClip } from "./render-fixture";

// 콜아웃(R7)·펀치인(R8) 조립: 타임라인 배치 → captions-<n>.ass 이벤트 → zoom_punch 세그먼트. 실렌더는 ffmpeg·폰트가 있을 때만.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const realFont = resolveFont();
const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-callouts-");
});
afterAll(async () => {
  await removeTemp(root);
});

// 문장 "하루 600밀리그램 한 알이면 충분해요"(21자)가 컷 0~2(0~5초)에 묶이고 단어 시각이 있다. 컷 1(2~3초)은 zoom_punch.
const voiceText = "하루 600밀리그램 한 알이면 충분해요";
const words: TimelineWord[] = [
  { text: "하루", start: 0, end: 0.3 },
  { text: "600밀리그램", start: 0.4, end: 1.1 },
  { text: "한", start: 1.2, end: 1.3 },
  { text: "알이면", start: 2.3, end: 2.7 },
  { text: "충분해요", start: 2.8, end: 3.3 },
];
const callouts: Callout[] = [
  { word: "알이면", text: "한 알", kind: "ring", anchor: "subject" },
  { word: "600밀리그램", text: "600밀리그램", kind: "label", anchor: "top" },
  { word: "충분해요", text: "충분", kind: "check", anchor: "right" },
];
function calloutScript(lineCallouts: readonly Callout[] = callouts): VideoScript {
  const script = renderScript(1, "concept-1", 36);
  const first = script.voiceover[0];
  if (!first) throw new Error("voiceover expected");
  return {
    ...script,
    cuts: script.cuts.map((cut) => ({ ...cut, onScreenText: "" })),
    voiceover: [
      {
        ...first,
        text: voiceText,
        startSec: 0,
        endSec: 5,
        fromCut: 0,
        toCut: 2,
        purpose: "hook",
        callouts: [...lineCallouts],
      },
    ],
  };
}
function built(script: VideoScript, measurement: Partial<VoiceMeasurement> = {}): RenderTimeline {
  const result = buildTimeline(script, [
    { index: 0, durationMs: 3400, tempo: 1, words, ...measurement },
  ]);
  if (!("timeline" in result)) throw new Error(`timeline expected: ${JSON.stringify(result)}`);
  return RenderTimelineSchema.parse(result.timeline);
}
const dialogues = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
const drawingOf = (line: string) => /\{\\p1\}(.*)\{\\p0\}/.exec(line)?.[1] ?? "";
const posOf = (line: string) => {
  const match = /\\pos\((-?\d+),(-?\d+)\)/.exec(line);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};
// \p1 도형의 bbox(좌표는 0 이상이어야 한다)
const boxOf = (drawing: string) => {
  const numbers = drawing.match(/-?\d+/g)?.map(Number) ?? [];
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    w: Math.max(...xs),
    h: Math.max(...ys),
  };
};

test("callouts rise at the spoken word minus the caption lead, stay to the end of that cut and cycle three colors", () => {
  // When
  const timeline = built(calloutScript());
  // Then: 뜨는 순서대로 색 0·1·2, 단어 시각 - 200ms, 그 시각을 담은 컷의 끝까지
  expect(timeline.callouts).toEqual([
    {
      cutIndex: 0,
      text: "600밀리그램",
      kind: "label",
      anchor: "top",
      color: 0,
      startMs: 400 - CAPTION_LEAD_MS,
      endMs: 2000,
    },
    {
      cutIndex: 1,
      text: "한 알",
      kind: "ring",
      anchor: "subject",
      color: 1,
      startMs: 2100,
      endMs: 3000,
    },
    {
      cutIndex: 1,
      text: "충분",
      kind: "check",
      anchor: "right",
      color: 2,
      startMs: 2600,
      endMs: 3000,
    },
  ]);
  // 저장(JSON)했다가 다시 읽어도 다이제스트가 같다(조립 loadTimeline 이 이 값으로 변조를 가린다)
  const raw = buildTimeline(calloutScript(), [{ index: 0, durationMs: 3400, tempo: 1, words }]);
  if (!("timeline" in raw)) throw new Error("timeline expected");
  expect(timelineDigest(RenderTimelineSchema.parse(JSON.parse(JSON.stringify(raw.timeline))))).toBe(
    timelineDigest(raw.timeline),
  );
  // zoom_punch 컷 1 은 첫 콜아웃 시각(2100)에 펀치인한다(컷 시작 기준 100ms). 다른 zoom_punch 컷은 콜아웃이 없어 생략(0).
  expect(timeline.cuts[1]).toMatchObject({ effect: "zoom_punch", punchMs: 100 });
  expect("punchMs" in (timeline.cuts[0] ?? {})).toBe(false);
  for (const cut of timeline.cuts.slice(2))
    if (cut.effect === "zoom_punch") expect("punchMs" in cut).toBe(false);
  expect(CALLOUT_COLORS).toBe(THEME.colors.accents.length);
  // 네 번째 콜아웃부터 색이 다시 0 으로 돌아온다
  const four = built(
    calloutScript([...callouts, { word: "한", text: "하나", kind: "label", anchor: "left" }]),
  );
  expect(four.callouts?.map((callout) => callout.color)).toEqual([0, 1, 2, 0]);
  expect(four.callouts?.map((callout) => callout.text)).toEqual([
    "600밀리그램",
    "하나",
    "한 알",
    "충분",
  ]);
});

test("without word timing a callout sits at the proportional position, and an unknown word falls back to the sentence start", () => {
  // Given: 단어 시각 없음 → "알이면"은 21자 중 13번째 글자 → 13/21 × 3400 = 2105ms → 컷 1 이 담고, 200ms 선행은 컷 시작에서 멈춘다
  const proportional = built(calloutScript(), { words: [] });
  expect(proportional.callouts?.find((callout) => callout.kind === "ring")).toMatchObject({
    cutIndex: 1,
    startMs: 2000,
    endMs: 3000,
  });
  // "충분해요"는 17번째 글자 → 2752 → 2552 는 컷 1
  expect(proportional.callouts?.find((callout) => callout.kind === "check")).toMatchObject({
    cutIndex: 1,
    startMs: 2552,
    endMs: 3000,
  });
  // 문장에 없는 어절(대본 규칙이 거부하지만 방어)은 문장 시작에 뜬다
  const unknown = built(
    calloutScript([{ word: "없는말", text: "확인", kind: "label", anchor: "bottom" }]),
  );
  expect(unknown.callouts).toEqual([
    {
      cutIndex: 0,
      text: "확인",
      kind: "label",
      anchor: "bottom",
      color: 0,
      startMs: 0,
      endMs: 2000,
    },
  ]);
});

test("a saved legacy timeline keeps its digest and a script without scene-plan fields writes none of the new keys", () => {
  // Given: 새 필드가 없는 예전 타임라인 JSON(컷 포함)
  const legacy = {
    number: 1,
    durationMs: 2000,
    extendedMs: 0,
    scriptDigest: "legacy",
    cuts: [
      {
        index: 0,
        startMs: 0,
        endMs: 2000,
        purpose: "hook",
        source: "veo_clip",
        effect: "zoom_punch",
        onScreenText: "",
        caption: null,
        graphicKind: "",
        graphicLines: [],
        sourceRef: { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 },
      },
    ],
    voice: [],
    warnings: [],
  };
  // When
  const parsed = RenderTimelineSchema.parse(legacy);
  // Then: 파싱이 goal·phase·punchMs·subjectBox·callouts 를 만들어 넣지 않는다
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
  expect(timelineDigest(parsed)).toBe(timelineDigest(legacy as RenderTimeline));
  // 장면 계획 필드가 없는 대본(예전 대본)으로 만든 새 타임라인도 새 키를 적지 않는다
  const fixture = renderScript(1, "concept-1", 36);
  const plain: VideoScript = {
    ...fixture,
    cuts: fixture.cuts.map((cut) => ({ ...cut, goal: "", phase: "" })),
    voiceover: fixture.voiceover.map((voice) => ({ ...voice, callouts: [] })),
  };
  const result = buildTimeline(
    plain,
    plain.voiceover.map((voice, index) => ({
      index,
      durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
      tempo: 1,
    })),
  );
  if (!("timeline" in result)) throw new Error("timeline expected");
  expect("callouts" in result.timeline).toBe(false);
  for (const cut of result.timeline.cuts)
    expect(
      Object.keys(cut).some((key) => ["goal", "phase", "punchMs", "subjectBox"].includes(key)),
    ).toBe(false);
});

test("callout ASS events: glow below the shape, kinds drawn as vectors, digits in the accent color, all inside the safe area", () => {
  // Given
  const timeline = built(calloutScript());
  // When
  const ass = captionsAss(timeline, DEFAULT_PROFILE, font);
  const lines = dialogues(ass).filter((line) => line.includes(",Callout"));
  // Then: 콜아웃 3개 → 글로우 3 + 도형 3 + 라벨 글자 1
  expect(lines).toHaveLength(7);
  const glow = lines.filter((line) => line.startsWith(`Dialogue: ${CALLOUT_LAYER.glow},`));
  const shapes = lines.filter((line) => line.startsWith(`Dialogue: ${CALLOUT_LAYER.shape},`));
  const texts = lines.filter((line) => line.startsWith(`Dialogue: ${CALLOUT_LAYER.text},`));
  expect([glow.length, shapes.length, texts.length]).toEqual([3, 3, 1]);
  for (const line of glow) expect(line).toContain("\\blur8");
  // 라벨: 둥근 사각형(베지에 4개) + 어두운 반투명 박스 + 글자(숫자 묶음만 강조색 0 = 노랑)
  const label = shapes.find((line) => line.includes("0:00:00.20,0:00:02.00"));
  expect(label).toContain(`\\1c${assColor(THEME.colors.background)}&\\1a&H40&`);
  expect(drawingOf(label ?? "").match(/\bb /g)).toHaveLength(4);
  expect(texts[0]).toContain(
    `{\\c${assColor("FFD54A")}&}600{\\c${assColor(THEME.colors.text)}&}밀리그램`,
  );
  expect(texts[0]).toContain(",Callout,");
  expect(texts[0]).toContain("\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)");
  // 링: 타원 두 개(바깥 + 안쪽, m 두 번·베지에 8개), 색 1 = 시안, 대상 상자(40%×30%) 둘레
  const ring = shapes.find((line) => line.includes("0:00:02.10,0:00:03.00"));
  expect(ring).toContain(`\\1c${assColor("4FC3F7")}&`);
  expect(drawingOf(ring ?? "").match(/\bm /g)).toHaveLength(2);
  expect(drawingOf(ring ?? "").match(/\bb /g)).toHaveLength(8);
  const ringBox = boxOf(drawingOf(ring ?? ""));
  expect(ringBox.w).toBe(Math.round(0.4 * 1080 + 2 * 14));
  expect(ringBox.h).toBe(Math.round(0.3 * 1920 + 2 * 14));
  expect(posOf(ring ?? "")).toEqual({ x: 540, y: 1018 });
  // 체크: 다각형(l 5개), 색 2 = 코랄, 오른쪽 존
  const check = shapes.find((line) => line.includes("0:00:02.60,0:00:03.00"));
  expect(check).toContain(`\\1c${assColor("FF6B6B")}&`);
  expect(drawingOf(check ?? "").match(/\bl /g)).toHaveLength(5);
  expect(posOf(check ?? "")?.x).toBe(756);
  // 모든 도형: 좌표 0 이상, 중심 ± 반폭이 세이프존(좌우 6.7%, 위 11.5%) 안·자막 윗선(69%) 위
  for (const line of [...glow, ...shapes]) {
    const box = boxOf(drawingOf(line));
    const pos = posOf(line);
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(pos).not.toBeNull();
    if (!pos) continue;
    expect(pos.x - box.w / 2).toBeGreaterThanOrEqual(1080 * THEME.safe.side);
    expect(pos.x + box.w / 2).toBeLessThanOrEqual(1080 * (1 - THEME.safe.side));
    expect(pos.y - box.h / 2).toBeGreaterThanOrEqual(1920 * THEME.safe.top);
    expect(pos.y + box.h / 2).toBeLessThanOrEqual(1920 * THEME.callout.floor);
  }
  // 콜아웃은 캡션 이벤트 뒤에 온다
  const all = dialogues(ass);
  const lastCaption = all.map((line) => line.includes(",Caption,")).lastIndexOf(true);
  const firstCallout = all.findIndex((line) => line.includes(",Callout"));
  expect(firstCallout).toBeGreaterThan(lastCaption);
  // 작은 프로파일(108x192)에서도 같은 수의 이벤트가 나오고 PlayRes 가 맞는다
  const small = captionsAss(timeline, renderProfile, font);
  expect(dialogues(small).filter((line) => line.includes(",Callout"))).toHaveLength(7);
  expect(small).toContain("PlayResX: 108");
});

test("arrows point from the anchor zone to the subject box edge, and boxes are clamped into the safe area", () => {
  const cut: TimelineCut = {
    index: 0,
    startMs: 0,
    endMs: 1500,
    purpose: "proof",
    source: "veo_clip",
    effect: "hard_cut",
    onScreenText: "",
    caption: null,
    graphicKind: "",
    graphicLines: [],
    sourceRef: { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 },
  };
  const base = {
    number: 1,
    durationMs: 1500,
    extendedMs: 0,
    scriptDigest: "x",
    voice: [],
    warnings: [],
    cuts: [cut],
  };
  const arrow = (anchor: "left" | "right" | "top" | "bottom" | "subject") =>
    calloutEvents(
      {
        ...base,
        callouts: [
          { cutIndex: 0, text: "여기", kind: "arrow", anchor, color: 0, startMs: 0, endMs: 1500 },
        ],
      },
      DEFAULT_PROFILE,
      font,
    );
  // 왼쪽 존(324, 1056)은 기본 대상 상자(x 324~756)의 왼쪽 가장자리라 촉이 거기서 멈추고 꼬리는 최소 길이(10%)만큼 왼쪽으로 뻗는다
  const left = arrow("left");
  expect(left).toHaveLength(2);
  const shape = left.find((line) => line.startsWith(`Dialogue: ${CALLOUT_LAYER.shape},`)) ?? "";
  expect(drawingOf(shape).match(/\bl /g)).toHaveLength(6);
  const box = boxOf(drawingOf(shape));
  const pos = posOf(shape);
  // 축 길이는 최소 192 이지만 살짝 기울어 bbox 폭은 그보다 조금 작다
  expect(box.w).toBeGreaterThanOrEqual(180);
  expect((pos?.x ?? 0) + box.w / 2).toBeLessThanOrEqual(324 + 1);
  expect((pos?.x ?? 0) - box.w / 2).toBeGreaterThanOrEqual(1080 * THEME.safe.side);
  // 대상 앵커의 화살표는 왼쪽 존에서 출발하는 같은 모양이다
  expect(drawingOf(arrow("subject")[1] ?? "")).toBe(drawingOf(shape));
  // 위 존의 화살표는 아래로(대상 상자 위 가장자리 730 까지) 향한다
  const top = arrow("top");
  const topShape = top.find((line) => line.startsWith(`Dialogue: ${CALLOUT_LAYER.shape},`)) ?? "";
  const topBox = boxOf(drawingOf(topShape));
  const topPos = posOf(topShape);
  expect((topPos?.y ?? 0) + topBox.h / 2).toBeLessThanOrEqual(0.38 * 1920 + 1);
  expect((topPos?.y ?? 0) - topBox.h / 2).toBeGreaterThanOrEqual(1920 * THEME.safe.top);
  // 면책 문구가 있으면 위쪽 한계가 그 아래(30%)로 내려온다
  const withDisclaimer = calloutEvents(
    {
      ...base,
      disclaimer: "개인마다 차이가 있습니다.",
      callouts: [
        {
          cutIndex: 0,
          text: "확인",
          kind: "check",
          anchor: "top",
          color: 0,
          startMs: 0,
          endMs: 1500,
        },
      ],
    },
    DEFAULT_PROFILE,
    font,
  );
  const checkShape = withDisclaimer[1] ?? "";
  expect((posOf(checkShape)?.y ?? 0) - boxOf(drawingOf(checkShape)).h / 2).toBeGreaterThanOrEqual(
    1920 * THEME.artwork.top,
  );
  // 클램프: 모서리 밖 중심은 안으로, 세이프 폭보다 넓은 상자는 가운데
  expect(clampCalloutCenter({ x: 0, y: 0 }, { w: 200, h: 200 }, DEFAULT_PROFILE)).toEqual({
    x: 1080 * THEME.safe.side + 100,
    y: 1920 * THEME.safe.top + 100,
  });
  expect(clampCalloutCenter({ x: 900, y: 1900 }, { w: 2000, h: 100 }, DEFAULT_PROFILE)).toEqual({
    x: 540,
    y: 1920 * THEME.callout.floor - 50,
  });
  // 팔레트 순환·기본 대상 상자·도형 빌더
  expect([0, 1, 2, 3, 4].map(calloutAccent)).toEqual([
    "FFD54A",
    "4FC3F7",
    "FF6B6B",
    "FFD54A",
    "4FC3F7",
  ]);
  expect(subjectBoxPx(undefined, DEFAULT_PROFILE)).toEqual({ x: 324, y: 729.6, w: 432, h: 576 });
  expect(DEFAULT_SUBJECT_BOX).toEqual({ x: 0.3, y: 0.38, w: 0.4, h: 0.3 });
  expect(ringVector({ w: 100, h: 60 }, 10)).toMatch(/^\{\\p1\}m 100 30 b .* m 90 30 b .*\{\\p0\}$/);
  expect(roundedRectVector({ w: 100, h: 40 }, 8)).toMatch(/^\{\\p1\}m 8 0 l 92 0 b /);
  expect(arrowShape({ x: 0, y: 0 }, { x: 100, y: 0 }, 10).size).toEqual({ w: 100, h: 38 });
  expect(calloutCheckShape(DEFAULT_PROFILE).size).toEqual({ w: 150, h: 120 });
  expect(calloutCheckShape(renderProfile).size.w).toBeLessThan(20);
});

test("zoom_punch waits for the punch frame before snapping and the segment digest follows punchMs", () => {
  // 10fps 프로파일: 500ms → P=5 → 5프레임 동안 1.0, 3프레임 1.18, 그다음부터 풀림
  expect(effectFilters("zoom_punch", 2000, renderProfile, { punchMs: 500 }).chain).toContain(
    "zoompan=z='if(lt(in\\,5)\\,1\\,if(lt(in\\,8)\\,1.18\\,max(1\\,1.18-0.02*(in-5-3))))'",
  );
  expect(effectFilters("zoom_punch", 2000, renderProfile).chain).toContain(
    "if(lt(in\\,0)\\,1\\,if(lt(in\\,3)\\,1.18\\,max(1\\,1.18-0.02*(in-0-3))))",
  );
  expect(effectFilters("zoom_punch", 2000, DEFAULT_PROFILE, { punchMs: 100 }).chain).toContain(
    "if(lt(in\\,3)\\,1\\,if(lt(in\\,6)",
  );
  // 세그먼트 빌더는 타임라인 컷의 punchMs 를 넘긴다
  const cut: TimelineCut = {
    index: 1,
    startMs: 2000,
    endMs: 3000,
    purpose: "hook",
    source: "veo_clip",
    effect: "zoom_punch",
    onScreenText: "",
    caption: null,
    graphicKind: "",
    graphicLines: [],
    sourceRef: { kind: "veo", clipId: "A", offsetMs: 2000, padMs: 0 },
    punchMs: 500,
  };
  const args = veoSegmentArgs(cut, "clip.mp4", renderProfile, "o.mp4");
  expect(args[args.indexOf("-filter_complex") + 1]).toContain("if(lt(in\\,5)\\,1\\,if(lt(in\\,8)");
  const { punchMs: _punchMs, ...plain } = cut;
  const plainArgs = veoSegmentArgs(plain, "clip.mp4", renderProfile, "o.mp4");
  expect(plainArgs[plainArgs.indexOf("-filter_complex") + 1]).toContain("if(lt(in\\,0)\\,1\\,");
  const base = {
    sourceDigest: "d",
    themeVersion: THEME_VERSION,
    fontDigest: "f",
    profile: renderProfile,
  };
  expect(segmentDigest({ ...base, cut })).not.toBe(segmentDigest({ ...base, cut: plain }));
  expect(segmentDigest({ ...base, cut })).toBe(segmentDigest({ ...base, cut: { ...cut } }));
  expect(THEME_VERSION).toBe(4);
  expect(segmentDigest({ ...base, cut })).not.toBe(
    segmentDigest({ ...base, cut, themeVersion: 3 }),
  );
});

// 렌더된 글자·도형(밝은 픽셀)의 외곽 상자(ass.test 와 같은 방식)
async function inkBounds(ass: string, name: string, seconds: number) {
  if (!realFont) throw new Error("font expected");
  const assPath = join(root, `${name}.ass`);
  const metaPath = join(root, `${name}.txt`);
  await Bun.write(assPath, ass);
  const fonts = await fontOnlyDir(realFont, root);
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=1080x1920:r=30:d=${seconds}`,
      "-vf",
      `ass=${ffPath(assPath)}:fontsdir=${ffPath(fonts)},bbox=min_val=70,metadata=print:file=${ffPath(metaPath)}`,
      "-f",
      "null",
      "-",
    ],
    { signal: new AbortController().signal, timeoutMs: 120_000 },
  );
  const text = await Bun.file(metaPath).text();
  const values = (key: string) =>
    [...text.matchAll(new RegExp(`lavfi\\.bbox\\.${key}=(\\d+)`, "g"))].map((match) =>
      Number(match[1]),
    );
  const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map(values);
  if (!x1?.length || !x2?.length || !y1?.length || !y2?.length) throw new Error("no ink found");
  return { x1: Math.min(...x1), y1: Math.min(...y1), x2: Math.max(...x2), y2: Math.max(...y2) };
}
function grayFrame(assPath: string, fonts: string, seconds: number): Uint8Array {
  const frame = Bun.spawnSync([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=1080x1920:r=30:d=${seconds + 0.5}`,
    "-vf",
    `ass=${ffPath(assPath)}:fontsdir=${ffPath(fonts)}`,
    "-ss",
    String(seconds),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ]);
  if (frame.exitCode !== 0) throw new Error(frame.stderr.toString().slice(-500));
  return frame.stdout;
}

test.skipIf(!hasFfmpeg || !realFont)(
  "real 1080x1920 render: every callout kind lands inside the safe area and the ring is hollow",
  async () => {
    if (!realFont) return;
    const cut: TimelineCut = {
      index: 0,
      startMs: 0,
      endMs: 1500,
      purpose: "proof",
      source: "veo_clip",
      effect: "hard_cut",
      onScreenText: "",
      caption: null,
      graphicKind: "",
      graphicLines: [],
      sourceRef: { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 },
    };
    const base: RenderTimeline = {
      number: 1,
      durationMs: 1500,
      extendedMs: 0,
      scriptDigest: "callouts",
      voice: [],
      warnings: [],
      captions: [],
      cuts: [cut],
    };
    const cases = [
      { kind: "label", anchor: "top", text: "하루 600밀리그램" },
      { kind: "ring", anchor: "subject", text: "한 알" },
      { kind: "arrow", anchor: "left", text: "여기" },
      { kind: "check", anchor: "right", text: "확인" },
      { kind: "label", anchor: "bottom", text: "열여섯자열여섯자열여섯자열여섯자" },
    ] as const;
    // 글로우(\bord6\blur8)가 도형 밖으로 번지는 만큼만 여유를 둔다
    const bleed = 24;
    for (const [index, item] of cases.entries()) {
      const ass = captionsAss(
        {
          ...base,
          callouts: [{ cutIndex: 0, color: index, startMs: 0, endMs: 1500, ...item }],
        },
        DEFAULT_PROFILE,
        realFont,
      );
      const bounds = await inkBounds(ass, `callout-${item.kind}-${item.anchor}`, 1.5);
      expect(bounds.x1).toBeGreaterThanOrEqual(1080 * THEME.safe.side - bleed);
      expect(bounds.x2).toBeLessThanOrEqual(1080 * (1 - THEME.safe.side) + bleed);
      expect(bounds.y1).toBeGreaterThanOrEqual(1920 * THEME.safe.top - bleed);
      expect(bounds.y2).toBeLessThanOrEqual(1920 * THEME.callout.floor + bleed);
    }
    // 링: 안쪽 타원을 반대 방향으로 그려 가운데가 비고 테두리만 밝다(채움 규칙과 무관)
    const ringAss = captionsAss(
      {
        ...base,
        callouts: [
          {
            cutIndex: 0,
            color: 1,
            startMs: 0,
            endMs: 1500,
            kind: "ring",
            anchor: "subject",
            text: "한 알",
          },
        ],
      },
      DEFAULT_PROFILE,
      realFont,
    );
    const ringPath = join(root, "ring-hollow.ass");
    await Bun.write(ringPath, ringAss);
    const fonts = await fontOnlyDir(realFont, root);
    const gray = grayFrame(ringPath, fonts, 1);
    const at = (x: number, y: number) => gray[y * 1080 + x] ?? 0;
    // 중심(540,1018)은 검고, 테두리(바깥 반지름 302 - 두께 14 의 가운데: y ≈ 1018 - 295)는 밝다
    expect(at(540, 1018)).toBeLessThan(40);
    expect(at(540, 1018 - 295)).toBeGreaterThan(100);
    expect(at(540 + 223, 1018)).toBeGreaterThan(100);
  },
  240_000,
);

test.skipIf(!hasFfmpeg || !realFont)(
  "real 108x192 render: a zoom_punch segment with punchMs plus the callout ASS passes through ffmpeg",
  async () => {
    if (!realFont) return;
    const timeline = built(calloutScript());
    const clip = tinyClip(join(root, "clip.mp4"));
    const punchCut = timeline.cuts[1];
    if (punchCut?.punchMs !== 100) throw new Error("punch cut expected");
    const segment = join(root, "punch.mp4");
    await runFfmpeg(veoSegmentArgs(punchCut, clip, renderProfile, segment), {
      signal: new AbortController().signal,
      timeoutMs: 120_000,
    });
    // 컷 1 구간(2~3초)의 콜아웃만 세그먼트 시간(0~1초)으로 옮겨 입힌다
    const shifted: RenderTimeline = {
      ...timeline,
      durationMs: 1000,
      cuts: [{ ...punchCut, index: 0, startMs: 0, endMs: 1000 }],
      captions: [],
      callouts: (timeline.callouts ?? [])
        .filter((callout) => callout.cutIndex === 1)
        .map((callout) => ({
          ...callout,
          cutIndex: 0,
          startMs: callout.startMs - 2000,
          endMs: callout.endMs - 2000,
        })),
    };
    const assPath = join(root, "punch.ass");
    await Bun.write(assPath, captionsAss(shifted, renderProfile, realFont));
    const fonts = await fontOnlyDir(realFont, root);
    const out = join(root, "punch-callouts.mp4");
    await runFfmpeg(
      [
        "-i",
        segment,
        "-vf",
        `ass=${ffPath(assPath)}:fontsdir=${ffPath(fonts)},format=yuv420p`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        out,
      ],
      { signal: new AbortController().signal, timeoutMs: 120_000 },
    );
    const probed = z
      .object({
        format: z.object({ duration: z.string() }),
        streams: z.array(z.object({ width: z.number().optional(), height: z.number().optional() })),
      })
      .parse(
        await runFfprobeJson(
          ["-show_entries", "format=duration:stream=width,height", out],
          new AbortController().signal,
        ),
      );
    expect([probed.streams[0]?.width, probed.streams[0]?.height]).toEqual([108, 192]);
    expect(Math.abs(Number(probed.format.duration) - 1)).toBeLessThanOrEqual(0.11);
  },
  180_000,
);
