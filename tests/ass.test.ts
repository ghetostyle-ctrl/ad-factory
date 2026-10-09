import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assColor,
  assEscape,
  assTime,
  captionsAss,
  checkVector,
  fixedTitleSpans,
  graphicAss,
  graphicPanel,
} from "../server/render/ass";
import { ffPath, fontOnlyDir, runFfmpeg } from "../server/render/ffmpeg";
import { type FontSet, resolveFont } from "../server/render/fonts";
import { fitLines, fitText, lineEm } from "../server/render/text-fit";
import { DEFAULT_PROFILE } from "../server/render/theme";
import { buildTimeline, type RenderTimeline, type TimelineCut } from "../shared/render-timeline";
import { removeTemp, renderProfile, renderScript, renderTemp } from "./render-fixture";

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const realFont = resolveFont();
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-ass-");
});
afterAll(async () => {
  await removeTemp(root);
});

const font: FontSet = { dir: "C:/fonts", family: "Pretendard", bold: "b.ttf", medium: "m.ttf" };
// 예전 타임라인 흉내: 음성 자막(captions)·콜아웃(callouts)이 없다(렌더 픽스처는 마지막 문장에 라벨 콜아웃이 있다).
function legacyTimeline(timeline: RenderTimeline): RenderTimeline {
  const { captions: _captions, callouts: _callouts, ...legacy } = timeline;
  return legacy;
}
const malgun: FontSet = {
  dir: "C:/Windows/Fonts",
  family: "Malgun Gothic",
  bold: "malgunbd.ttf",
  medium: "malgun.ttf",
};

test("assEscape neutralises braces and backslashes, converts newlines and splits long lines", () => {
  expect(assEscape("a{b}c\\d")).toBe("a(b)c/d");
  expect(assEscape("첫 줄\n둘째 줄")).toBe("첫 줄\\N둘째 줄");
  expect(assEscape("가".repeat(20))).toBe(`${"가".repeat(16)}\\N${"가".repeat(4)}`);
});
test("assTime and assColor formats", () => {
  expect(assTime(0)).toBe("0:00:00.00");
  expect(assTime(61_234)).toBe("0:01:01.23");
  expect(assTime(3_600_000 + 5_010)).toBe("1:00:05.01");
  expect(assColor("FFD54A")).toBe("&H004AD5FF");
  expect(assColor("000000", 0x80)).toBe("&H80000000");
});
test("captions use profile-proportional style, lead timing and a pop style for text_pop cuts", () => {
  const script = renderScript(1, "concept-1", 36);
  const built = buildTimeline(
    script,
    // 문장은 컷 범위에 묶여 있으므로 실측은 그 범위(1~3초)보다 0.5초 짧게 둔다
    script.voiceover.map((voice, index) => ({
      index,
      durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
      tempo: 1,
    })),
  );
  if (!("timeline" in built)) throw new Error("timeline expected");
  const small = captionsAss(legacyTimeline(built.timeline), renderProfile, font);
  expect(small).toContain("PlayResX: 108");
  expect(small).toContain("PlayResY: 192");
  // 192 × 0.0375 = 7
  expect(small).toMatch(/Style: Caption,Pretendard,7,/);
  const large = captionsAss(legacyTimeline(built.timeline), DEFAULT_PROFILE, malgun);
  expect(large).toMatch(/Style: Caption,Malgun Gothic,72,&H00FFFFFF,[^\n]*,1,6,2,2,72,72,442,1/);
  const dialogues = large.split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(dialogues.length).toBe(built.timeline.cuts.filter((cut) => cut.caption).length);
  // 첫 컷 자막은 0초(200ms 선행은 0 에서 잘린다)·페이드
  expect(dialogues[0]).toContain("0:00:00.00,0:00:02.00,Caption,,0,0,0,,{\\fad(80,0)}이런 분 주목");
  const pop = dialogues.find((line) => line.includes(",Pop,"));
  expect(pop).toContain("\\pos(540,960)");
  expect(pop).toContain("\\t(0,180,\\fscx115\\fscy115)");
  expect(pop).toContain("핵심은 이것");
  // 모션그래픽 컷의 글줄은 자막으로 겹쳐 올리지 않는다
  expect(large).not.toContain("600mg\\N하루 한 번");
  // 자막은 문장보다 200ms 먼저: 두 번째 컷의 문장은 2초 시작이 아니라 3초 문장이므로 컷 시작
  const popCut = built.timeline.cuts.find((cut) => cut.caption?.style === "pop");
  expect(popCut?.caption?.startMs).toBe(popCut ? popCut.startMs - 200 : -1);
});
test("graphic templates render each kind with staggered lines, vector checks and no glyph check marks", () => {
  const kinds = ["number", "checklist", "compare", "question", "callout"] as const;
  const lines = ["600mg", "하루 한 번", "셋째", "넷째"];
  for (const kind of kinds) {
    const ass = graphicAss(kind, lines, 1200, DEFAULT_PROFILE, font);
    const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogues.length).toBeGreaterThanOrEqual(lines.length);
    expect(ass).not.toContain("✓");
    expect(ass).toContain("\\pos(");
    for (const dialogue of dialogues) expect(dialogue).toMatch(/,0:00:0[01]\.\d\d,0:00:01\.20,/);
    if (kind === "checklist") {
      expect(ass).toContain("{\\p1}m 0 20 l 20 40 l 60 0");
      expect(dialogues.filter((line) => line.includes("{\\p1}"))).toHaveLength(lines.length);
      // 줄마다 350ms 지연
      expect(dialogues.some((line) => line.includes("0:00:00.35,"))).toBe(true);
      expect(dialogues.some((line) => line.includes("0:00:00.70,"))).toBe(true);
    }
    if (kind === "number")
      expect(ass).toMatch(/Big,,0,0,0,,\{\\pos\(540,\d+\)(?:\\fs\d+)?\\fad\(60,0\)\\fscx40/);
    if (kind === "compare") expect(ass).toContain("VS");
    if (kind === "question") expect(ass).toMatch(/fscy100\)\}\?\n/);
    if (kind === "callout") {
      // 박스는 글 크기에 맞춘 사각형이고 \an5 이므로 \pos 가 곧 중심이다: 박스와 제목이 같은 점이어야 겹친다
      expect(ass).toMatch(/\{\\p1\}m 0 0 l \d+ 0 l \d+ \d+ l 0 \d+\{\\p0\}/);
      const boxLine = dialogues.find((line) => line.includes("{\\p1}"));
      const titleLine = dialogues.find((line) => line.includes(",Title,"));
      const boxPosition = /\\an5\\pos\(540,\d+\)/.exec(boxLine ?? "")?.[0];
      expect(boxPosition).toBeDefined();
      expect(titleLine).toContain(boxPosition ?? "missing box position");
      // 제목은 노란 박스 위의 어두운 글자(배경색 101828), 외곽선 없음
      expect(titleLine).toContain("\\c&H281810&");
      expect(titleLine).toContain("\\bord0");
    }
  }
  expect(checkVector(renderProfile)).toBe("{\\p1}m 0 2 l 2 4 l 6 0 l 5 -1 l 2 2 l 1 1{\\p0}");
  expect(graphicAss("number", ["7"], 1200, renderProfile, font)).toMatch(
    /Style: Big,Pretendard,19,/,
  );
});

// 24자 최악의 줄 3종: 전각 한글(공백 없음), 공백 있는 한글, 폭이 넓은 대문자
const WORST = [
  [..."가나다라마바사아자차카타파하거너더러머버서어저처커"].slice(0, 24).join(""),
  [..."국내산 원료만 사용한 믿을 수 있는 제품입니다"].slice(0, 24).join(""),
  "WWWWWWWWWWWWWWWWWWWWWWWW",
];

test("fitText keeps the longest line inside the budget and only splits when the size gets too small", () => {
  const options = { font: { ...font }, maxWidth: 888, base: 72, outline: 4 };
  // 짧은 줄은 기본 크기 그대로, 한 줄
  expect(fitText("600mg", options)).toMatchObject({ size: 72, lines: ["600mg"] });
  // 24자 한 줄은 읽을 만한 크기(기본의 75%)가 안 나오면 maxLines 까지 균형 있게 나눈다
  const wrapped = fitText(WORST[0] ?? "", { ...options, maxLines: 2 });
  expect(wrapped.lines).toHaveLength(2);
  expect(wrapped.lines.join("")).toBe(WORST[0] ?? "");
  expect(wrapped.size).toBeGreaterThanOrEqual(54);
  expect(wrapped.widthPx + 2 * 4).toBeLessThanOrEqual(888);
  // 공백이 있으면 낱말 경계에서 끊는다
  const spaced = fitText(WORST[1] ?? "", { ...options, maxWidth: 600, maxLines: 2 });
  expect(spaced.lines).toHaveLength(2);
  expect(spaced.lines.join(" ")).toBe(WORST[1] ?? "");
  // 줄 수가 정해진 자막은 가장 긴 줄 기준으로 크기만 줄인다
  const caption = fitLines([WORST[0]?.slice(0, 16) ?? "", "짧은 줄"], { ...options, base: 120 });
  expect(caption.size).toBeLessThan(120);
  expect(caption.widthPx + 2 * 4).toBeLessThanOrEqual(888);
  expect(lineEm("가", font)).toBeCloseTo((864 / 1000) * (2048 / 2444), 5);
});

function pickPop(timeline: RenderTimeline) {
  return timeline.cuts.find((cut) => cut.caption?.style === "pop");
}
test("captions shrink long lines to fit: pop within the frame at 115%, bottom within the safe zone", () => {
  const script = renderScript(1, "concept-1", 36);
  const built = buildTimeline(
    script,
    // 문장은 컷 범위에 묶여 있으므로 실측은 그 범위(1~3초)보다 0.5초 짧게 둔다
    script.voiceover.map((voice, index) => ({
      index,
      durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
      tempo: 1,
    })),
  );
  if (!("timeline" in built)) throw new Error("timeline expected");
  const long = `${"가".repeat(16)}\n${"나".repeat(16)}`;
  const popCut = pickPop(built.timeline);
  const bottomCut = built.timeline.cuts.find((cut) => cut.caption?.style === "bottom");
  if (!popCut?.caption || !bottomCut?.caption) throw new Error("caption cuts expected");
  const timeline: RenderTimeline = {
    ...built.timeline,
    cuts: [
      { ...popCut, caption: { ...popCut.caption, text: long } },
      { ...bottomCut, caption: { ...bottomCut.caption, text: long } },
    ],
  };
  const ass = captionsAss(legacyTimeline(timeline), DEFAULT_PROFILE, font);
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const pop = dialogues.find((line) => line.includes(",Pop,"));
  const bottom = dialogues.find((line) => line.includes(",Caption,"));
  // Pop 기본 120px 16자 줄은 1080 폭을 넘으므로 \fs 로 줄인다(115% 확대 최대치가 프레임 안)
  const popSize = Number(/\\fs(\d+)/.exec(pop ?? "")?.[1]);
  expect(popSize).toBeLessThan(120);
  expect(lineEm("가".repeat(16), font) * popSize * 1.15).toBeLessThanOrEqual(1080 * 0.96);
  // 하단 캡션 72px 16자는 세이프존(936px) 안이라 줄이지 않는다
  expect(bottom).not.toContain("\\fs");
  expect(lineEm("가".repeat(16), font) * 72 + 12).toBeLessThanOrEqual(936);
  // 프로파일이 작아도 같은 비율로 동작한다
  expect(captionsAss(legacyTimeline(timeline), renderProfile, font)).toContain("PlayResX: 108");
});

// 렌더된 글자(밝은 픽셀)의 외곽 상자: 검은 배경에 ASS 만 입혀 프레임마다 bbox 를 읽고 합친다
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
  return {
    x1: Math.min(...x1),
    y1: Math.min(...y1),
    x2: Math.max(...x2),
    y2: Math.max(...y2),
  };
}

test.skipIf(!hasFfmpeg || !realFont)(
  "real 1080x1920 render: worst-case 16-char captions stay inside the frame and safe zone",
  async () => {
    if (!realFont) return;
    const script = renderScript(1, "concept-1", 36);
    const built = buildTimeline(
      script,
      // 문장은 컷 범위에 묶여 있으므로 실측은 그 범위(1~3초)보다 0.5초 짧게 둔다
      script.voiceover.map((voice, index) => ({
        index,
        durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
        tempo: 1,
      })),
    );
    if (!("timeline" in built)) throw new Error("timeline expected");
    const popCut = pickPop(built.timeline);
    const bottomCut = built.timeline.cuts.find((cut) => cut.caption?.style === "bottom");
    if (!popCut?.caption || !bottomCut?.caption) throw new Error("caption cuts expected");
    for (const [index, worst] of WORST.entries()) {
      const text = `${worst.slice(0, 16)}\n${worst.slice(8, 24)}`;
      const at = (cut: typeof popCut) => ({
        ...cut,
        startMs: 0,
        endMs: 1500,
        caption: cut.caption && { ...cut.caption, text, startMs: 0, endMs: 1500 },
      });
      const popBounds = await inkBounds(
        captionsAss(
          legacyTimeline({ ...built.timeline, cuts: [at(popCut)] }),
          DEFAULT_PROFILE,
          realFont,
        ),
        `pop-${index}`,
        1.5,
      );
      // 115% 팝 최대치에서도 프레임(0~1079) 안, 좌우 여백 남김
      expect(popBounds.x1).toBeGreaterThanOrEqual(10);
      expect(popBounds.x2).toBeLessThanOrEqual(1079 - 10);
      const bottomBounds = await inkBounds(
        captionsAss(
          legacyTimeline({ ...built.timeline, cuts: [at(bottomCut)] }),
          DEFAULT_PROFILE,
          realFont,
        ),
        `bottom-${index}`,
        1.5,
      );
      // 하단 캡션은 릴스 UI 좌우 세이프존(72px) 안
      expect(bottomBounds.x1).toBeGreaterThanOrEqual(72);
      expect(bottomBounds.x2).toBeLessThanOrEqual(1080 - 72);
    }
  },
  180_000,
);

test.skipIf(!hasFfmpeg || !realFont)(
  "real 1080x1920 render: 24-char graphic lines stay inside the panel for all five kinds",
  async () => {
    if (!realFont) return;
    const panel = graphicPanel(DEFAULT_PROFILE);
    const kinds = ["number", "checklist", "compare", "question", "callout"] as const;
    for (const kind of kinds) {
      const lines = [WORST[0] ?? "", WORST[1] ?? "", WORST[2] ?? "", WORST[0] ?? ""];
      // 3초 동안 줄이 350ms 간격으로 모두 나타나고, 팝(115%)은 첫 0.3초에 지나간다
      const bounds = await inkBounds(
        graphicAss(kind, lines, 3000, DEFAULT_PROFILE, realFont),
        `graphic-${kind}`,
        3,
      );
      expect(bounds.x1).toBeGreaterThanOrEqual(panel.x);
      expect(bounds.x2).toBeLessThanOrEqual(panel.x + panel.w);
      expect(bounds.y1).toBeGreaterThanOrEqual(panel.y);
      expect(bounds.y2).toBeLessThanOrEqual(panel.y + panel.h);
    }
  },
  180_000,
);

test("measured phrase captions override legacy cuts and keep title and disclaimer in separate slots", () => {
  // Given
  const timeline: RenderTimeline = {
    number: 1,
    durationMs: 4000,
    extendedMs: 0,
    scriptDigest: "fixture",
    voice: [],
    warnings: [],
    cuts: [],
    captions: [
      {
        text: "하루 600밀리그램",
        keyword: "600밀리그램",
        startMs: 200,
        endMs: 1600,
        style: "bottom",
      },
    ],
    fixedTitle: ["바쁜 하루에도", "가볍게 시작해요"],
    disclaimer: "개인마다 차이가 있습니다.\n원료에 관한 설명입니다.",
  };
  // When
  const ass = captionsAss(timeline, DEFAULT_PROFILE, font);
  // Then
  const lines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(lines).toHaveLength(3);
  expect(lines.find((line) => line.includes(",FixedTitle,"))).toContain(
    "바쁜 하루에도\\N가볍게 시작해요",
  );
  expect(lines.find((line) => line.includes(",Disclaimer,"))).toContain(
    "개인마다 차이가 있습니다.",
  );
  const caption = lines.find((line) => line.includes(",Caption,")) ?? "";
  expect(caption).toContain("0:00:00.20,0:00:01.60");
  expect(caption).not.toContain("\\N");
  expect(caption.match(/\\c&H004AD5FF&/g)).toHaveLength(1);
});

test("an explicitly empty phrase track suppresses legacy cut captions", () => {
  const script = renderScript(1, "concept-1", 36);
  const built = buildTimeline(
    script,
    script.voiceover.map((voice, index) => ({
      index,
      durationMs: (voice.endSec - voice.startSec) * 1000 - 500,
      tempo: 1,
    })),
  );
  if (!("timeline" in built)) throw new Error("timeline expected");
  const ass = captionsAss(
    { ...legacyTimeline(built.timeline), captions: [] },
    DEFAULT_PROFILE,
    font,
  );
  expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:"))).toEqual([]);
});

test.skipIf(!hasFfmpeg || !realFont)(
  "synthetic render keeps fixed title, disclaimer and spoken caption in disjoint safe slots",
  async () => {
    if (!realFont) return;
    const base: RenderTimeline = {
      number: 1,
      durationMs: 1500,
      extendedMs: 0,
      scriptDigest: "synthetic",
      voice: [],
      warnings: [],
      cuts: [],
      captions: [],
    };
    const title = await inkBounds(
      captionsAss(
        { ...base, fixedTitle: ["바쁜 하루에도", "가볍게 시작해요"] },
        DEFAULT_PROFILE,
        realFont,
      ),
      "fixed-title",
      1.5,
    );
    const disclaimer = await inkBounds(
      captionsAss(
        {
          ...base,
          disclaimer:
            "원료에 관한 설명입니다. 개인마다 차이가 있습니다. 구매 전 제품 표시사항을 확인해 주세요.",
        },
        DEFAULT_PROFILE,
        realFont,
      ),
      "disclaimer",
      1.5,
    );
    const caption = await inkBounds(
      captionsAss(
        {
          ...base,
          captions: [
            { text: "아침부터 가볍게\n하루를 시작해요", startMs: 0, endMs: 1500, style: "bottom" },
          ],
        },
        DEFAULT_PROFILE,
        realFont,
      ),
      "spoken-caption",
      1.5,
    );
    expect(title.y1).toBeGreaterThanOrEqual(1920 * 0.115);
    expect(title.y2).toBeLessThan(disclaimer.y1);
    const graphic = await inkBounds(
      graphicAss("number", ["600mg", "하루 한 번"], 1500, DEFAULT_PROFILE, realFont),
      "graphic-between-header-and-caption",
      1.5,
    );
    expect(disclaimer.y2).toBeLessThan(graphic.y1);
    expect(graphic.y2).toBeLessThan(caption.y1);
    expect(caption.y2).toBeLessThanOrEqual(1920 * 0.77);
    for (const bounds of [title, disclaimer, caption]) {
      expect(bounds.x1).toBeGreaterThanOrEqual(72);
      expect(bounds.x2).toBeLessThanOrEqual(1008);
    }
  },
  60_000,
);

test("the fixed title is hidden over INFO transition cuts and shown elsewhere", () => {
  // Given: 설명 컷 I2 가 2~4초, 그 밖은 A 클립·대표 이미지
  const cut = (
    index: number,
    startMs: number,
    endMs: number,
    sourceRef: TimelineCut["sourceRef"],
  ) =>
    ({
      index,
      startMs,
      endMs,
      purpose: "hook",
      source: "veo_clip",
      effect: "hard_cut",
      onScreenText: "",
      caption: null,
      graphicKind: "",
      graphicLines: [],
      sourceRef,
    }) as TimelineCut;
  const timeline: RenderTimeline = {
    number: 1,
    durationMs: 6000,
    extendedMs: 0,
    scriptDigest: "fixture",
    voice: [],
    warnings: [],
    captions: [],
    fixedTitle: ["출근 전 1초"],
    cuts: [
      cut(0, 0, 2000, { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 }),
      cut(1, 2000, 4000, { kind: "veo", clipId: "I2", offsetMs: 0, padMs: 0 }),
      cut(2, 4000, 6000, { kind: "image", artifactName: "image-h1-1.png" }),
    ],
  };
  // When
  const spans = fixedTitleSpans(timeline);
  const ass = captionsAss(timeline, DEFAULT_PROFILE, font);
  // Then
  expect(spans).toEqual([
    { startMs: 0, endMs: 2000 },
    { startMs: 4000, endMs: 6000 },
  ]);
  const titles = ass.split("\n").filter((line) => line.includes(",FixedTitle,"));
  expect(titles).toHaveLength(2);
  expect(titles[0]).toContain("0:00:00.00,0:00:02.00");
  expect(titles[1]).toContain("0:00:04.00,0:00:06.00");
  // 설명 컷이 없으면 전체 구간 하나
  expect(fixedTitleSpans({ durationMs: 6000, cuts: timeline.cuts.slice(0, 1) })).toEqual([
    { startMs: 0, endMs: 6000 },
  ]);
});
