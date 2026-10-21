import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runFfprobeJson } from "../server/render/ffmpeg";
import { resolveFont } from "../server/render/fonts";
import { mechanismStackFilter, renderScreenClip } from "../server/render/hf-render";
import {
  mechanismHtml,
  phoneScreenHtml,
  renderScreen,
  screenTemplate,
} from "../server/render/screens";
import { sceneFromCopyInstructions } from "../server/video-scripts";
import { buildTimeline } from "../shared/render-timeline";
import { videoScriptFromResponse } from "../shared/script-repair";
import { sceneProblemsV2 } from "../shared/script-rules-v2";
import { sha256Hex } from "../shared/sha256";
import { VideoPlanningSchema } from "../shared/video-planning";
import {
  type CutMechanism,
  type CutScreen,
  emptyMechanism,
  emptyScreen,
  fillHfCutFields,
  HfVideoScriptResponseSchema,
  scriptDigestJson,
  type VideoScript,
  VideoScriptSchema,
} from "../shared/video-script";
import { hfLabelFixture } from "./hf-label-fixture";
import { removeTemp, renderScript, renderTemp, tinyClip, tinyStill } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

// 폰 화면·작용 원리 컷 소스(2026-10-21, higgsfield-remake 규칙 반영 ③). 유료 호출 0, 로컬 픽스처만.

const SEARCH: CutScreen = {
  kind: "search",
  title: "",
  query: "올리브 캡슐",
  lines: ["원재료", "대두유 섞인", "추천", "가격"],
  highlight: "대두유 섞인",
  numbers: [],
};
const CHAT: CutScreen = {
  kind: "chat",
  title: "퓨어 고객센터",
  query: "",
  lines: ["나: 정품 구분하는 법 있나요?", "상대: 원재료명에 올리브유 100%만 적혀 있어요."],
  highlight: "올리브유 100%",
  numbers: [],
};
const SHOP: CutScreen = {
  kind: "shop",
  title: "",
  query: "올리브 캡슐",
  lines: [
    "가품: 올리브 캡슐 대용량",
    "퓨어 올리브 캡슐",
    "가품: 올리브 오일 캡슐",
    "올리브 캡슐 세트",
  ],
  numbers: ["9,900원", "28,656원", "12,800원", "8,500원"],
  highlight: "가품 주의",
};
const PRICE: CutScreen = {
  kind: "price",
  title: "퓨어 공식스토어",
  query: "",
  lines: ["퓨어 올리브 캡슐 30캡슐", "첫 구매 할인|-7,960원"],
  numbers: ["39,800원", "28,656원"],
  highlight: "할인코드 받기",
};
const DOC: CutScreen = {
  kind: "doc",
  title: "ScienceDirect",
  query: "",
  lines: ["Olive oil and capsules", "Extra virgin olive oil keeps polyphenols."],
  highlight: "polyphenols",
  numbers: [],
};
const MECH: CutMechanism = {
  chips: ["냉압착 올리브유", "캡슐에 그대로"],
  counterLabel: "한 캡슐",
  counterSteps: ["600"],
  counterUnit: "mg",
  result: "원료가 살아 있어요",
};

// --- 1. 스키마 ----------------------------------------------------------------------------------------------------
test("old saved scripts parse with empty screen and mechanism and keep their HEAD digests", () => {
  // Given: 두 필드가 생기기 전에 저장된 대본 JSON(혼합형 응답 변환본·렌더 픽스처)
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: "h1",
    targetSec: 36,
    hasCardSlides: false,
  });
  const strip = (value: VideoScript) => {
    const json = JSON.parse(JSON.stringify(value));
    for (const cut of json.cuts) {
      delete cut.screen;
      delete cut.mechanism;
    }
    return json;
  };
  const hybrid = VideoScriptSchema.parse(strip(script));
  const legacy = VideoScriptSchema.parse(strip(renderScript(1, "h1")));
  // Then: 기본값으로 읽히고, 다이제스트는 변경 전 HEAD(61a6acd)에서 잰 값과 같다
  expect(hybrid.cuts[0]?.screen).toEqual(emptyScreen());
  expect(hybrid.cuts[0]?.mechanism).toEqual(emptyMechanism());
  expect(scriptDigestJson(hybrid)).not.toContain('"screen"');
  expect(sha256Hex(scriptDigestJson(hybrid))).toBe(
    "a2562fa7be703f2789491567b9b0675363be12d695cc4b58d340de4f69c34364",
  );
  expect(sha256Hex(scriptDigestJson(legacy))).toBe(
    "f4b2c2892c1551d446e2f3af3a48ee873805d13c09c2cfd3db9f9a725806ac85",
  );
  // 내용이 있는 컷만 다이제스트에 들어간다
  const withScreen = VideoScriptSchema.parse({
    ...hybrid,
    cuts: hybrid.cuts.map((cut, index) =>
      index === 2 ? { ...cut, source: "phone_screen", screen: SEARCH } : cut,
    ),
  });
  expect(scriptDigestJson(withScreen)).toContain('"screen":{"kind":"search"');
});

test("the copy-first HF response schema requires screen and mechanism on every cut (strict)", () => {
  // Given: JSON 스키마
  const schema = z.toJSONSchema(HfVideoScriptResponseSchema) as unknown as {
    properties: {
      sentences: {
        items: {
          properties: {
            cuts: {
              items: {
                required: string[];
                properties: Record<string, { required?: string[]; additionalProperties?: boolean }>;
              };
            };
          };
        };
      };
    };
  };
  const cut = schema.properties.sentences.items.properties.cuts.items;
  // Then: 두 필드가 필수이고 안쪽 칸도 모두 필수·추가 칸 금지
  expect(cut.required).toContain("screen");
  expect(cut.required).toContain("mechanism");
  expect(cut.properties["screen"]?.required).toEqual([
    "kind",
    "title",
    "query",
    "lines",
    "highlight",
    "numbers",
  ]);
  expect(cut.properties["screen"]?.additionalProperties).toBe(false);
  expect(cut.properties["mechanism"]?.required).toEqual([
    "chips",
    "counterLabel",
    "counterSteps",
    "counterUnit",
    "result",
  ]);
  // 빠진 응답은 strict 파싱에서 거부되고, 앱의 파싱 전 보정은 빈 값으로 채운다
  const old = hybridScriptResponse();
  const response = {
    ...old,
    infoClips: old.infoClips.map((clip) => ({
      ...clip,
      labelLayer: hfLabelFixture(
        clip.infoLines.length,
        clip.objects.map((object) => object.subjectId),
      ),
    })),
  };
  expect(HfVideoScriptResponseSchema.safeParse(response).success).toBe(false);
  const parsed = HfVideoScriptResponseSchema.parse(fillHfCutFields(response));
  expect(parsed.sentences[0]?.cuts[0]?.screen.kind).toBe("none");
  // 편지 2 지시문이 두 칸의 모양을 알려 준다
  const prompt = sceneFromCopyInstructions({ infoClips: true });
  expect(prompt).toContain("screen{kind, title, query, lines[], highlight, numbers[]}");
  expect(prompt).toContain("PHONE SCREENS AND MECHANISM");
});

// --- 2. 규칙 ------------------------------------------------------------------------------------------------------
const hypothesis = (() => {
  const item = sourcePlanResponse("fact-1").hypotheses[0];
  if (!item) throw new TypeError("Missing test hypothesis");
  return item;
})();
const FACTS = [
  "한 통 30캡슐, 한 캡슐 600mg",
  "정가 39,800원, 첫 구매 할인 7,960원, 최종가 28,656원",
  "올리브유 100%",
];
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true, facts: FACTS };
type Cut = VideoScript["cuts"][number];
type CutPatch = Partial<Cut> & { readonly len?: number };
const SHORT = ["아침 영양제, 고민되시죠?", "좋은 줄만 알았어요.", "차이는 원료예요."];
function baseScript(): VideoScript {
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 36,
    hasCardSlides: false,
  });
  const parsed = VideoScriptSchema.parse({
    ...script,
    flow: "copy_first",
    planning: VideoPlanningSchema.parse({
      ...fixtureVideoPlanning(),
      visualPolicy: "hybrid_explainer_v1",
    }),
  });
  return {
    ...parsed,
    voiceover: parsed.voiceover.map((voice, index) => ({
      ...voice,
      text: SHORT[index] ?? voice.text,
    })),
  };
}
function edit(script: VideoScript, patches: Readonly<Record<number, CutPatch>>): VideoScript {
  let at = 0;
  const cuts = script.cuts.map((cut, index) => {
    const { len, ...patch } = patches[index] ?? {};
    const length = len ?? cut.endSec - cut.startSec;
    const next = { ...cut, ...patch, startSec: at, endSec: at + length };
    at += length;
    return next;
  });
  return { ...script, cuts, durationSec: at };
}
const phone = (screen: CutScreen, len = 2.5): CutPatch => ({
  source: "phone_screen",
  veoClip: "",
  phase: "",
  stillId: "",
  screen,
  len,
});
const mech = (mechanism: CutMechanism, len = 3.5): CutPatch => ({
  source: "mechanism",
  veoClip: "A",
  phase: "late",
  stillId: "S1",
  mechanism,
  len,
});
const scene = (script: VideoScript) => sceneProblemsV2(script, expected);
const has = (list: readonly string[], text: string) => list.some((item) => item.includes(text));
// 컷 2 = 진짜 원인(③) 문장, 컷 7 = 이유(⑥) 문장 — 증거 자리.
function passing(): VideoScript {
  return edit(baseScript(), { 2: phone(PRICE), 7: mech(MECH) });
}

test("a phone screen under real_cause and a mechanism under reason_why pass the scene rules", () => {
  expect(scene(passing())).toEqual({ hard: [], soft: [] });
});

test("scene rules reject empty, misplaced, too many, too long and fact-less screen and mechanism cuts", () => {
  // 폰 화면 kind none
  expect(
    has(scene(edit(passing(), { 2: phone(emptyScreen()) })).hard, "화면 종류가 없습니다"),
  ).toBe(true);
  // 작용 원리 칩 0개·결과 없음
  const bare = scene(edit(passing(), { 7: mech({ ...MECH, chips: [], result: "" }) })).hard;
  expect(has(bare, "칩(chips)이 0개")).toBe(true);
  expect(has(bare, "결과 문구(result)가 없습니다")).toBe(true);
  // 다른 소스에 screen·mechanism 내용
  const stray = scene(edit(passing(), { 4: { screen: SEARCH }, 5: { mechanism: MECH } })).hard;
  expect(has(stray, "폰 화면 컷이 아닌데 화면 내용(screen)")).toBe(true);
  expect(has(stray, "작용 원리 컷이 아닌데 작용 원리 내용(mechanism)")).toBe(true);
  // 길이: 폰 화면 4.5초, 작용 원리 2.5초·6초
  expect(has(scene(edit(passing(), { 2: phone(PRICE, 4.5) })).hard, "폰 화면 컷은 1.5~4초")).toBe(
    true,
  );
  expect(has(scene(edit(passing(), { 7: mech(MECH, 2.5) })).hard, "작용 원리 컷은 3~5.5초")).toBe(
    true,
  );
  expect(has(scene(edit(passing(), { 7: mech(MECH, 6) })).hard, "작용 원리 컷은 3~5.5초")).toBe(
    true,
  );
  // 개수: 폰 화면 4개, 작용 원리 3개
  const many = edit(passing(), { 4: phone(DOC), 5: phone(SEARCH), 6: phone(CHAT) });
  expect(has(scene(many).hard, "폰 화면 컷이 4개")).toBe(true);
  const mechs = edit(passing(), { 4: mech(MECH), 5: mech(MECH) });
  expect(has(scene(mechs).hard, "작용 원리 컷이 3개")).toBe(true);
  // 첫·마지막 컷
  expect(has(scene(edit(passing(), { 0: phone(SEARCH) })).hard, "첫 컷과 마지막 컷은 실사")).toBe(
    true,
  );
  expect(has(scene(edit(passing(), { 13: mech(MECH) })).hard, "첫 컷과 마지막 컷은 실사")).toBe(
    true,
  );
  // 사실에 없는 숫자(계산한 할인율·지어낸 카운터)
  const pct = scene(
    edit(passing(), { 2: phone({ ...PRICE, numbers: ["39,800원", "28,656원", "28%"] }) }),
  );
  expect(has(pct.hard, "사실에 없는 숫자(28)")).toBe(true);
  const counter = scene(edit(passing(), { 7: mech({ ...MECH, counterSteps: ["120", "600"] }) }));
  expect(has(counter.hard, "사실에 없는 숫자(120)")).toBe(true);
  // 선언하지 않은 클립·정지 이미지
  const undeclared = scene(edit(passing(), { 7: { ...mech(MECH), veoClip: "C", stillId: "S2" } }));
  expect(has(undeclared.hard, '선언하지 않은 실사 클립 "C"')).toBe(true);
  expect(has(undeclared.hard, '선언하지 않은 정지 이미지 "S2"')).toBe(true);
});

test("a phone screen under a pain or believed_cause sentence is only a warning", () => {
  // 컷 1 = 믿는 원인(②) 문장
  const result = scene(edit(passing(), { 1: phone(SEARCH) }));
  expect(result.hard).toEqual([]);
  expect(has(result.soft, "증거가 아닌 자리")).toBe(true);
});

test("repair keeps screen and mechanism only on their own sources and counts mechanism clip use", () => {
  // Given: HF 응답에서 컷 하나는 폰 화면, 다른 컷은 실수로 screen 을 적었다
  const old = hybridScriptResponse();
  const response = HfVideoScriptResponseSchema.parse(
    fillHfCutFields({
      ...old,
      infoClips: old.infoClips.map((clip) => ({
        ...clip,
        labelLayer: hfLabelFixture(
          clip.infoLines.length,
          clip.objects.map((object) => object.subjectId),
        ),
      })),
      sentences: old.sentences.map((sentence, index) => ({
        ...sentence,
        cuts: sentence.cuts.map((cut, k) =>
          index === 2 && k === 0
            ? {
                ...cut,
                source: "phone_screen",
                veoClip: "",
                phase: "",
                screen: SEARCH,
                mechanism: emptyMechanism(),
              }
            : index === 0
              ? { ...cut, screen: CHAT, mechanism: emptyMechanism() }
              : { ...cut, screen: emptyScreen(), mechanism: emptyMechanism() },
        ),
      })),
    }),
  );
  const { script, repairs } = videoScriptFromResponse(response, {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 36,
    hasCardSlides: false,
  });
  expect(script.cuts[2]?.source).toBe("phone_screen");
  expect(script.cuts[2]?.screen).toEqual(SEARCH);
  expect(script.cuts[0]?.screen).toEqual(emptyScreen());
  expect(repairs.some((item) => item.includes("폰 화면 내용(screen) 삭제"))).toBe(true);
});

// --- 3. 타임라인 --------------------------------------------------------------------------------------------------
test("the timeline maps phone_screen and mechanism cuts to screen and mechanism source refs", () => {
  const script = passing();
  const result = buildTimeline(
    script,
    script.voiceover.map((voice, index) => ({
      index,
      artifactName: `voice-1-${index}.wav`,
      durationMs: Math.round((voice.endSec - voice.startSec) * 1000) - 200,
      tempo: 1,
      words: [],
      attempt: 1,
    })),
    { sources: { approvedImage: "approved.png", stills: { S1: "still-1-S1-1.png" } } },
  );
  if (!("timeline" in result)) throw new Error(JSON.stringify(result));
  const { timeline } = result;
  expect(timeline.cuts[2]?.sourceRef).toEqual({
    kind: "screen",
    screen: PRICE,
    artifactName: "approved.png",
  });
  expect(timeline.cuts[7]?.sourceRef).toEqual({
    kind: "mechanism",
    mechanism: MECH,
    stillId: "S1",
    veoClip: "A",
    phase: "late",
    artifactName: "approved.png",
  });
});

// --- 4. 템플릿 ----------------------------------------------------------------------------------------------------
test("the five phone templates and the mechanism template carry their key elements", () => {
  const search = phoneScreenHtml(SEARCH, "", 2.4, 30);
  // 검색: 한 글자씩 타이핑 span, 주황으로 바뀔 줄, 확대 팝업
  expect(search).toContain('<span class="ty" id="scrt0">올<i class="cur"></i></span>');
  expect(search).toContain('<li class="hi">');
  expect(search).toContain('<div class="pop">올리브 캡슐');
  expect(search).toContain('window.__timelines["screen"]=tl');
  expect(search).toContain("assets/screen-bold.ttf");
  expect(search).not.toContain("googleapis");
  // 채팅: 확대 팝업과 박스 구절
  const chat = phoneScreenHtml(CHAT, "", 2.4, 30);
  expect(chat).toContain('<div class="cpop">');
  expect(chat).toContain('원재료명에 <span class="hl">올리브유 100%</span>만 적혀 있어요.');
  expect(chat).toContain('<div class="msg me m0">');
  // 쇼핑: 가품 줄은 빨간 테두리(bad), 정상 줄만 shade, 도장
  const shop = phoneScreenHtml(SHOP, "img.png", 2.4, 30);
  expect(shop.match(/class="it bad"/g)).toHaveLength(2);
  expect(shop.match(/<i class="shade"><\/i>/g)).toHaveLength(2);
  expect(shop).toContain('<div class="stamp">가품 주의</div>');
  expect(shop).toContain('<img src="assets/img.png">');
  // 가격: 계산 박스, 최종가 단계, 할인 줄
  const price = phoneScreenHtml(PRICE, "img.png", 2.4, 30);
  expect(price).toContain(
    '<i class="box"></i><span class="fv fv0">39,800원</span><span class="fv fv1">28,656원</span>',
  );
  expect(price).toContain(
    '<div class="rw red"><span>첫 구매 할인</span><span>-7,960원</span></div>',
  );
  // 문서: 형광펜 구절
  const doc = phoneScreenHtml(DOC, "", 2.4, 30);
  expect(doc).toContain(
    '<div class="zpop">Extra virgin olive oil keeps <span class="mk">polyphenols</span>.</div>',
  );
  // 작용 원리: 칩 2개, 카운터, 결과, 입자
  const mechanism = mechanismHtml(MECH, "img.png", 4.5, 30);
  expect(mechanism).toContain('<div class="chip c1"><i>1</i>냉압착 올리브유</div>');
  expect(mechanism).toContain('<div class="chip c2"><i>2</i>캡슐에 그대로</div>');
  expect(mechanism).toContain('<span class="v v0">600</span><span class="u">mg</span>');
  expect(mechanism).toContain('<div class="res">원료가 살아 있어요 &#10140;</div>');
  expect(mechanism.match(/class="p g\d+"/g)).toHaveLength(42);
  // 모델이 쓴 글은 이스케이프한다
  const js: string[] = [];
  const escaped = renderScreen(
    screenTemplate({ ...SEARCH, query: "<b>x</b>" }, ""),
    "s",
    0,
    2,
    js,
    1,
  );
  expect(escaped).toContain("&lt;b&gt;x&lt;/b&gt;");
  // 작용 원리 합치기: 위 954 + 띠 12 + 아래 954
  expect(mechanismStackFilter({ width: 1080, height: 1920, fps: 30 }, 4000)).toContain(
    "crop=1080:954:0:0",
  );
  expect(mechanismStackFilter({ width: 1080, height: 1920, fps: 30 }, 4000)).toContain(
    "color=c=black:s=1080x12",
  );
});

// --- 5. 렌더(HyperFrames 를 쓸 수 있을 때만) -----------------------------------------------------------------------
const hfCli = resolve(import.meta.dir, "../node_modules/hyperframes/bin/hyperframes.mjs");
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
const canRender =
  hasFfmpeg && Boolean(Bun.which("node")) && existsSync(hfCli) && Boolean(resolveFont());
const Probe = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  format: z.object({ duration: z.string() }),
});
test.skipIf(!canRender)(
  "a phone_screen cut renders to a 2-second segment and a mechanism cut stacks a live bottom",
  async () => {
    const dir = await renderTemp("studio-screen-");
    try {
      const font = resolveFont();
      if (!font) throw new Error("font");
      const profile = { width: 216, height: 384, fps: 10 };
      const signal = new AbortController().signal;
      const image = tinyStill(join(dir, "product.png"));
      const out = join(dir, "screen.mp4");
      await renderScreenClip({
        kind: "screen",
        screen: SHOP,
        durationMs: 2000,
        image: { path: image, digest: "img" },
        font,
        profile,
        scratch: dir,
        out,
        signal,
      });
      const probed = Probe.parse(
        await runFfprobeJson(
          ["-show_entries", "stream=codec_type,width,height:format=duration", out],
          signal,
        ),
      );
      const video = probed.streams.find((stream) => stream.codec_type === "video");
      expect(video?.width).toBe(216);
      expect(video?.height).toBe(384);
      expect(Math.abs(Number(probed.format.duration) - 2)).toBeLessThan(0.15);
      expect(probed.streams.some((stream) => stream.codec_type === "audio")).toBe(false);
      // 작용 원리: 아래 실사 클립을 붙여도 같은 규격
      const mechOut = join(dir, "mechanism.mp4");
      await renderScreenClip({
        kind: "mechanism",
        mechanism: MECH,
        durationMs: 3000,
        image: { path: image, digest: "img" },
        bottom: {
          path: tinyClip(join(dir, "clip.mp4"), 4),
          digest: "clip",
          video: true,
          offsetMs: 2000,
        },
        font,
        profile,
        scratch: dir,
        out: mechOut,
        signal,
      });
      const mechProbe = Probe.parse(
        await runFfprobeJson(
          ["-show_entries", "stream=codec_type,width,height:format=duration", mechOut],
          signal,
        ),
      );
      expect(mechProbe.streams.find((stream) => stream.codec_type === "video")?.height).toBe(384);
      expect(Math.abs(Number(mechProbe.format.duration) - 3)).toBeLessThan(0.15);
    } finally {
      await removeTemp(dir);
    }
  },
  300_000,
);
