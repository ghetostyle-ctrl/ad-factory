import { expect, test } from "bun:test";
import { verifyLongVideoScript } from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import { type ProductionAsset, ProductionAssetSchema } from "../shared/production-assets";
import {
  assignClipOffsets,
  buildTimeline,
  cardIndex,
  pickProjectAsset,
  type RenderTimeline,
  RenderTimelineSchema,
  TIMELINE_DEFAULTS,
  timelineDigest,
  type VoiceMeasurement,
} from "../shared/render-timeline";
import { videoScriptFromResponse } from "../shared/script-repair";
import {
  NARRATION_MAX_CHARS_PER_SEC,
  VIDEO_MAX_SEC,
  type VideoScript,
} from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { flatOf, nestedScriptResponse } from "./video-script-fixture";

const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[1]);
const script = () => renderScript(1, hypothesis.id, 36);
// 36초 픽스처는 문장 14개가 컷 2개(또는 1개)씩에 묶여 있다(문장 0: 컷 0~1 = 0~3초, 문장 2: 컷 3~4 = 5~8초 …).
// 문장 창 안에 들어가는 실측: 묶인 컷 범위보다 0.6초 짧게.
const inWindow = (
  fixture: VideoScript,
  overrides: Partial<Record<number, Partial<VoiceMeasurement>>> = {},
) =>
  fixture.voiceover.map((voice, index) => ({
    index,
    durationMs: (voice.endSec - voice.startSec) * 1000 - 600,
    tempo: 1,
    artifactName: `voice-1-${String(index).padStart(2, "0")}-1.wav`,
    ...overrides[index],
  }));
const windowMs = (fixture: VideoScript, index: number) => {
  const voice = fixture.voiceover[index];
  if (!voice) throw new Error(`문장 ${index} 없음`);
  return (voice.endSec - voice.startSec) * 1000;
};
function timelineOf(result: ReturnType<typeof buildTimeline>): RenderTimeline {
  if (!("timeline" in result)) throw new Error(`timeline expected, got ${JSON.stringify(result)}`);
  return RenderTimelineSchema.parse(result.timeline);
}
function asset(input: Partial<ProductionAsset["settings"]> & { title: string }): ProductionAsset {
  const { title, ...settings } = input;
  return ProductionAssetSchema.parse({
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title,
    filename: "clip.mp4",
    contentType: "video/mp4",
    bytes: 1000,
    sha256: "a".repeat(64),
    durationSec: 6,
    width: 1080,
    height: 1920,
    hasAudio: true,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    settings: { ...settings, targets: settings.targets ?? { mode: "all" } },
  });
}

test("render fixture script obeys the long-script rules (all sources, all effects, clips A-D)", () => {
  const fixture = script();
  expect(() =>
    verifyLongVideoScript(fixture, {
      number: 1,
      durationSec: 36,
      hypothesis,
      hasProjectClips: true,
    }),
  ).not.toThrow();
  expect(new Set(fixture.cuts.map((cut) => cut.source)).size).toBe(6);
  expect(new Set(fixture.cuts.map((cut) => cut.effect)).size).toBe(8);
  expect(fixture.veoClips.map((clip) => clip.id)).toEqual(["A", "B", "C", "D"]);
});

test("measurements inside their windows keep every cut and sentence where the script put them", () => {
  // Given
  const fixture = script();
  // When
  const timeline = timelineOf(buildTimeline(fixture, inWindow(fixture)));
  // Then
  expect(timeline.durationMs).toBe(36000);
  expect(timeline.extendedMs).toBe(0);
  expect(timeline.cuts.map((cut) => [cut.startMs, cut.endMs])).toEqual(
    fixture.cuts.map((cut) => [cut.startSec * 1000, cut.endSec * 1000]),
  );
  // 문장은 묶인 첫 컷의 시작에 걸린다
  expect(timeline.voice.map((voice) => voice.startMs)).toEqual(
    fixture.voiceover.map((voice) => (fixture.cuts[voice.fromCut]?.startSec ?? -1) * 1000),
  );
  expect(timeline.voice[0]?.artifactName).toBe("voice-1-00-1.wav");
  expect(timeline.warnings.some((warning) => warning.includes("대표 이미지"))).toBe(true);
});

test("a sentence past its window with tempo headroom asks for one re-synthesis at the needed tempo", () => {
  // Given: 문장 0(컷 0~1 = 0~3초 창)이 3.6초 → 300ms slack 을 넘는다
  const result = buildTimeline(script(), inWindow(script(), { 0: { durationMs: 3600 } }));
  // Then: 1 × 3600 / 3000 = 1.2
  expect(result).toEqual({ overflow: [{ index: 0, requiredTempo: 1.2 }] });
  // 필요 템포가 1.3 을 넘으면 상한에서 자른다
  const capped = buildTimeline(script(), inWindow(script(), { 0: { durationMs: 4500 } }));
  expect(capped).toEqual({ overflow: [{ index: 0, requiredTempo: TIMELINE_DEFAULTS.maxTempo }] });
});

test("leftover overflow after re-synthesis lands on the sentence's own cuts first (last cut first), then following cuts, 500ms each", () => {
  // Given: 문장 0(컷 0~1, 0~3초)이 재합성(attempt 2, 템포 1.2) 뒤에도 3.9초 → 초과 600ms
  const fixture = script();
  const timeline = timelineOf(
    buildTimeline(fixture, inWindow(fixture, { 0: { durationMs: 3900, tempo: 1.2, attempt: 2 } })),
  );
  // Then: 범위의 마지막 컷 1 에 500ms, 그다음 컷 0 에 100ms(뒤따르는 컷은 건드리지 않는다)
  const lengths = timeline.cuts.map((cut) => cut.endMs - cut.startMs);
  expect(lengths.slice(0, 4)).toEqual([2100, 1500, 2000, 1000]);
  expect(timeline.extendedMs).toBe(600);
  expect(timeline.durationMs).toBe(36600);
  for (let index = 1; index < timeline.cuts.length; index++)
    expect(timeline.cuts[index]?.startMs).toBe(timeline.cuts[index - 1]?.endMs ?? -1);
  // 뒤 문장은 앞 문장 끝 + 150ms 이후에 시작한다(자기 컷 시작 3600 보다 늦다)
  expect(timeline.voice[1]?.startMs).toBe(3900 + TIMELINE_DEFAULTS.gapMs);
  // 범위 안에 모션그래픽 컷이 있으면 건너뛰고 범위의 다른 컷 → 뒤따르는 컷으로 넘긴다:
  // 문장 2(컷 3~4, 5~8초; 컷 3 은 모션그래픽) 초과 600ms → 컷 4 에 500ms, 컷 5 에 100ms
  const graphic = timelineOf(
    buildTimeline(fixture, inWindow(fixture, { 2: { durationMs: 3900, tempo: 1.3, attempt: 2 } })),
  );
  expect(graphic.cuts[3]?.source).toBe("motion_graphic");
  expect(graphic.cuts.slice(2, 7).map((cut) => cut.endMs - cut.startMs)).toEqual([
    2000, 1000, 2500, 1100, 2000,
  ]);
  // 템포 상한에 이미 도달한 문장은 재합성 없이 바로 분산한다
  expect(
    "timeline" in
      buildTimeline(fixture, inWindow(fixture, { 0: { durationMs: 3900, tempo: 1.3 } })),
  ).toBe(true);
});

test("more than three seconds of extension or a video past sixty seconds is too_long with the sentence index", () => {
  // Given: 문장 0 이 6.7초 → 초과 3400ms 는 컷 전부에 500ms 씩 나눠도 총 연장 3초를 넘는다
  expect(
    buildTimeline(script(), inWindow(script(), { 0: { durationMs: 6700, attempt: 2 } })),
  ).toEqual({ error: "too_long", index: 0 });
  // 문장마다 1~2초씩 넘치면 앞 문장이 민 만큼 뒤 문장도 밀려(드리프트) 3초를 넘는다.
  // 모션그래픽 컷은 연장을 받지 않아 받을 수 있는 컷이 줄어, 세 번째 문장에서 이미 한도를 넘는다.
  const overrides = Object.fromEntries(
    [0, 1, 2, 3, 4].map((index) => [index, { durationMs: 4000, attempt: 2 }]),
  );
  expect(buildTimeline(script(), inWindow(script(), overrides))).toEqual({
    error: "too_long",
    index: 2,
  });
  // 60초 대본은 700ms 만 늘어도 상한을 넘는다(문장 2 = 컷 4~5 = 6~9초, 3초 창)
  const longest = renderScript(1, hypothesis.id, VIDEO_MAX_SEC);
  expect(windowMs(longest, 2)).toBe(3000);
  expect(
    buildTimeline(longest, inWindow(longest, { 2: { durationMs: 4000, attempt: 2 } })),
  ).toEqual({ error: "too_long", index: 2 });
});

test("the extension never lands on motion_graphic cuts, so their length and 40% share stay within the script limits", () => {
  // Given: 여러 문장이 재합성 뒤에도 600ms 씩 넘치는 대본(연장이 여러 컷에 퍼진다)
  const fixture = script();
  const overrides = Object.fromEntries(
    [0, 4, 6, 9].map((index) => [
      index,
      { durationMs: windowMs(fixture, index) + 600, tempo: 1.3, attempt: 2 },
    ]),
  );
  const timeline = timelineOf(buildTimeline(fixture, inWindow(fixture, overrides)));
  expect(timeline.extendedMs).toBeGreaterThan(0);
  // Then: 연장은 실사·이미지 컷에만 얹혔고 그래픽 컷은 대본 길이 그대로다
  let graphicMs = 0;
  for (const [index, cut] of timeline.cuts.entries()) {
    const scripted = fixture.cuts[index];
    if (!scripted) throw new Error("cut missing");
    const length = cut.endMs - cut.startMs;
    if (cut.source === "motion_graphic") {
      expect(length).toBe((scripted.endSec - scripted.startSec) * 1000);
      graphicMs += length;
    } else expect(length - (scripted.endSec - scripted.startSec) * 1000).toBeLessThanOrEqual(500);
  }
  // 그래픽 합계는 그대로이고 전체만 늘어나므로 비율은 대본 때보다 커지지 않는다
  const scriptedGraphicMs = fixture.cuts
    .filter((cut) => cut.source === "motion_graphic")
    .reduce((sum, cut) => sum + (cut.endSec - cut.startSec) * 1000, 0);
  expect(graphicMs).toBe(scriptedGraphicMs);
  expect(graphicMs / timeline.durationMs).toBeLessThanOrEqual(scriptedGraphicMs / (36 * 1000));
  // 뒤에 연장을 받을 컷이 하나도 없으면(전부 모션그래픽) 컷을 늘리지 않고 too_long 으로 멈춘다
  const allGraphic = {
    ...fixture,
    cuts: fixture.cuts.map((cut) => ({ ...cut, source: "motion_graphic" as const })),
  };
  expect(
    buildTimeline(
      allGraphic,
      inWindow(fixture, { 0: { durationMs: 3900, tempo: 1.3, attempt: 2 } }),
    ),
  ).toEqual({ error: "too_long", index: 0 });
});

test("cuts that share a Veo clip read consecutive offsets and pad past eight seconds", () => {
  const timeline = timelineOf(buildTimeline(script(), inWindow(script())));
  const refs = timeline.cuts
    .filter((cut) => cut.sourceRef.kind === "veo" && cut.sourceRef.clipId === "A")
    .map((cut) => cut.sourceRef);
  expect(refs).toEqual([
    { kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 },
    { kind: "veo", clipId: "A", offsetMs: 2000, padMs: 0 },
    { kind: "veo", clipId: "A", offsetMs: 3000, padMs: 0 },
  ]);
  const offsets = assignClipOffsets([
    { index: 0, source: "veo_clip", veoClip: "A", startMs: 0, endMs: 5000 },
    { index: 1, source: "approved_image", veoClip: "", startMs: 5000, endMs: 6000 },
    { index: 2, source: "veo_clip", veoClip: "A", startMs: 6000, endMs: 10000 },
    { index: 3, source: "veo_clip", veoClip: "A", startMs: 10000, endMs: 11000 },
  ]);
  expect(offsets.get(2)).toEqual({ clipId: "A", offsetMs: 5000, padMs: 1000 });
  expect(offsets.get(3)).toEqual({ clipId: "A", offsetMs: 8000, padMs: 1000 });
  expect(offsets.has(1)).toBe(false);
});

test("card_slide cuts cycle through the card images with k mod n", () => {
  const cards = ["card-c-1-1.png", "card-c-2-1.png"];
  const timeline = timelineOf(buildTimeline(script(), inWindow(script()), { sources: { cards } }));
  const refs = timeline.cuts
    .filter((cut) => cut.source === "card_slide")
    .map((cut) => cut.sourceRef);
  expect(refs).toEqual([
    { kind: "card", artifactName: "card-c-1-1.png", slideIndex: 0 },
    { kind: "card", artifactName: "card-c-2-1.png", slideIndex: 1 },
  ]);
  const single = timelineOf(
    buildTimeline(script(), inWindow(script()), { sources: { cards: ["only.png"] } }),
  );
  expect(
    single.cuts.filter((cut) => cut.source === "card_slide").map((cut) => cut.sourceRef),
  ).toEqual([
    { kind: "card", artifactName: "only.png", slideIndex: 0 },
    { kind: "card", artifactName: "only.png", slideIndex: 0 },
  ]);
  expect(cardIndex(3, 2)).toBe(1);
  expect(cardIndex(0, 0)).toBe(0);
});

test("project_clip picks by title match first, then placement order, and rewinds past endSec", () => {
  // Given
  const opening = asset({ title: "Opening scene", placement: "auto", startSec: 1, audio: "keep" });
  const ending = asset({ title: "Ending shot", placement: "ending" });
  const timeline = timelineOf(
    buildTimeline(script(), inWindow(script()), { sources: { projectAssets: [ending, opening] } }),
  );
  // Then: 컷 3 의 구도("촬영본 Opening scene …")가 제목과 부분일치 → startSec 1초부터
  expect(timeline.cuts[2]?.sourceRef).toEqual({
    kind: "project",
    assetId: opening.id,
    startMs: 1000,
    audio: "keep",
  });
  // 제목이 안 맞으면 컷 위치(초반)에 맞는 placement 를 먼저 고른다
  const auto = asset({ title: "B-roll", placement: "auto" });
  const early = asset({ title: "Intro", placement: "opening" });
  const picked = pickProjectAsset(
    { screenComposition: "장면", startMs: 3000, endMs: 5000 },
    [ending, auto, early],
    1,
    { durationMs: 36000, ordinal: 0 },
  );
  expect(picked?.assetId).toBe(early.id);
  // 누적 사용이 endSec 을 넘으면 처음으로 되감는다
  const short = asset({ title: "Loop", startSec: 0, endSec: 3 });
  const used = new Map<string, number>();
  const cut = { screenComposition: "장면", startMs: 0, endMs: 2000 };
  expect(pickProjectAsset(cut, [short], 1, { used })?.startMs).toBe(0);
  expect(pickProjectAsset(cut, [short], 1, { used })?.startMs).toBe(0);
  // 다른 영상 번호만 겨냥한 촬영본은 후보에서 빠진다
  const other = asset({ title: "Other", targets: { mode: "selected", videoNumbers: [2] } });
  expect(pickProjectAsset(cut, [other], 1)).toBeNull();
  expect(timelineOf(buildTimeline(script(), inWindow(script()))).cuts[2]?.sourceRef.kind).toBe(
    "image",
  );
});

test("captions lead speech by 200ms and text_pop cuts use the pop style", () => {
  const timeline = timelineOf(buildTimeline(script(), inWindow(script())));
  // 컷 0: 문장 0 이 0ms 에 시작 → 0 아래로는 내려가지 않는다
  expect(timeline.cuts[0]?.caption).toEqual({
    text: "이런 분 주목",
    startMs: 0,
    endMs: 2000,
    style: "bottom",
  });
  // 컷 3(5~6초)은 모션그래픽이라 화면이 글줄을 직접 그리므로 자막이 없다
  expect(timeline.cuts[3]?.source).toBe("motion_graphic");
  expect(timeline.cuts[3]?.caption).toBeNull();
  // 컷 10(15~17초): 문장 6(컷 10~11)이 15초에 시작 → 14800
  expect(script().voiceover[6]?.fromCut).toBe(10);
  expect(timeline.cuts[10]?.caption?.startMs).toBe(14800);
  expect(timeline.cuts[10]?.caption?.style).toBe("pop");
  expect(timeline.cuts[1]?.caption).toBeNull();
  expect(timeline.cuts.find((cut) => cut.source === "motion_graphic")?.sourceRef).toEqual({
    kind: "graphic",
  });
});

test("the same input yields the same timeline digest and a changed measurement changes it", () => {
  const first = timelineOf(buildTimeline(script(), inWindow(script())));
  const second = timelineOf(buildTimeline(script(), inWindow(script())));
  expect(timelineDigest(first)).toBe(timelineDigest(second));
  expect(timelineDigest(first)).toMatch(/^[0-9a-f]{64}$/);
  const changed = timelineOf(
    buildTimeline(script(), inWindow(script(), { 0: { durationMs: 2500 } })),
  );
  expect(timelineDigest(changed)).not.toBe(timelineDigest(first));
  expect(() => buildTimeline(script(), inWindow(script()).slice(0, -1))).toThrow("실측이 없습니다");
});

test("모션그래픽 컷에는 자막을 겹쳐 올리지 않는다", () => {
  const script = renderScript(1, "concept-1", 36);
  const graphic = script.cuts.find((cut) => cut.source === "motion_graphic");
  expect(graphic).toBeDefined();
  const withText = {
    ...script,
    cuts: script.cuts.map((cut) =>
      cut.source === "motion_graphic" ? { ...cut, onScreenText: "600mg" } : cut,
    ),
  };
  const measurements = withText.voiceover.map((voice, index) => ({
    index,
    durationMs: Math.max(500, (voice.endSec - voice.startSec) * 1000 - 400),
    tempo: 1,
  }));
  const result = buildTimeline(withText, measurements);
  if (!("timeline" in result)) throw new Error("타임라인이 만들어지지 않았습니다.");
  const cut = result.timeline.cuts.find((item) => item.source === "motion_graphic");
  expect(cut?.caption).toBeNull();
});

test("still image cuts map to still refs numbered by their order within the same still", () => {
  const fixture = script();
  const timeline = timelineOf(
    buildTimeline(fixture, inWindow(fixture), {
      sources: { stills: { S1: "still-1-S1-1.png" } },
    }),
  );
  const stills = timeline.cuts.flatMap((cut) =>
    cut.sourceRef.kind === "still" ? [{ source: cut.source, ref: cut.sourceRef }] : [],
  );
  // 36초 픽스처: 정지 이미지 S1(2컷)·S2(2컷)이 컷 순서대로 offsetIndex 0,1
  expect(stills.every((item) => item.source === "still_image")).toBe(true);
  expect(stills.map((item) => [item.ref.stillId, item.ref.offsetIndex])).toEqual([
    ["S1", 0],
    ["S1", 1],
    ["S2", 0],
    ["S2", 1],
  ]);
  // 타임라인 확정 시점에는 정지 이미지가 아직 없으므로 이름은 비어 있고(조립 단계가 기록에서 찾는다), 이름을 주면 채운다.
  expect(stills.map((item) => item.ref.artifactName)).toEqual([
    "still-1-S1-1.png",
    "still-1-S1-1.png",
    "",
    "",
  ]);
  // 자막이 없는 정지 이미지 컷은 caption 이 비고, 자막이 있는 컷(S1 두 번째)은 다른 이미지 컷처럼 자막을 얹는다
  expect(timeline.cuts.find((cut) => cut.source === "still_image")?.caption).toBeNull();
  const captioned = timeline.cuts.filter((cut) => cut.source === "still_image" && cut.caption);
  expect(captioned.map((cut) => cut.caption?.text)).toEqual(["지금 확인", "링크는 아래"]);
});

test("a still image cut without a still id falls back to the approved image with a warning", () => {
  const fixture = script();
  const broken = {
    ...fixture,
    cuts: fixture.cuts.map((cut) =>
      cut.stillId === "S1" ? { ...cut, stillId: "" as const } : cut,
    ),
  };
  const timeline = timelineOf(
    buildTimeline(broken, inWindow(broken), {
      sources: { approvedImage: "approved.png" },
    }),
  );
  expect(timeline.warnings.some((warning) => warning.includes("정지 이미지 ID"))).toBe(true);
  const fallbacks = timeline.cuts.filter(
    (cut) => cut.source === "still_image" && cut.sourceRef.kind === "image",
  );
  expect(fallbacks).toHaveLength(2);
  expect(
    fallbacks.every(
      (cut) => cut.sourceRef.kind === "image" && cut.sourceRef.artifactName === "approved.png",
    ),
  ).toBe(true);
});

test("a script converted from the nested model response builds a timeline with no overflow or extension", () => {
  // 중첩 응답 → 저장 대본: 문장 시간 = 컷 시간이므로 검사기 속도(초당 6.5자)로 합성됐다고 보면 창 초과가 없다
  const fixture = script();
  const flat = flatOf({
    ...fixture,
    cuts: fixture.cuts.map((cut) => ({
      ...cut,
      onScreenText: cut.onScreenText.replace(/\s+/g, " ").trim(),
    })),
  });
  const { script: nested, repairs } = videoScriptFromResponse(nestedScriptResponse(flat), {
    number: 1,
    hypothesisId: hypothesis.id,
    targetSec: 36,
    hasCardSlides: true,
  });
  expect(repairs).toEqual([]);
  expect(() =>
    verifyLongVideoScript(nested, {
      number: 1,
      durationSec: 36,
      hypothesis,
      hasProjectClips: true,
    }),
  ).not.toThrow();
  const measurements = nested.voiceover.map((voice, index) => ({
    index,
    durationMs: Math.round(([...voice.text].length / NARRATION_MAX_CHARS_PER_SEC) * 1000),
    tempo: 1,
  }));
  const result = buildTimeline(nested, measurements);
  expect("overflow" in result).toBe(false);
  const timeline = timelineOf(result);
  expect(timeline.extendedMs).toBe(0);
  expect(timeline.durationMs).toBe(36000);
  expect(timeline.voice.map((voice) => voice.startMs)).toEqual(
    nested.voiceover.map((voice) => (nested.cuts[voice.fromCut]?.startSec ?? -1) * 1000),
  );
});

test("final speech within the slack still extends the tail rather than being trimmed", () => {
  const fixture = script();
  const last = fixture.voiceover.length - 1;
  const measurements = inWindow(fixture, {
    [last]: { durationMs: windowMs(fixture, last) + 233, tempo: 1.2 },
  });
  const timeline = timelineOf(buildTimeline(fixture, measurements));
  expect(timeline.durationMs).toBe(36233);
  expect(timeline.extendedMs).toBe(233);
  expect(timeline.cuts.at(-1)?.endMs).toBe(36233);
  const voice = timeline.voice.at(-1);
  expect(voice ? voice.startMs + voice.durationMs : 0).toBe(timeline.durationMs);
  expect(timeline.captions?.every((caption) => caption.endMs <= timeline.durationMs)).toBe(true);
});

test("tail speech overrun cannot exceed the video or extension limits", () => {
  const longest = renderScript(1, hypothesis.id, 60);
  const last = longest.voiceover.length - 1;
  expect(
    buildTimeline(
      longest,
      inWindow(longest, { [last]: { durationMs: windowMs(longest, last) + 100, tempo: 1.3 } }),
    ),
  ).toEqual({ error: "too_long", index: last });
  const fixture = script();
  const index = fixture.voiceover.length - 1;
  const measurements = inWindow(fixture, {
    [index]: { durationMs: windowMs(fixture, index) + 233, tempo: 1.2 },
  });
  expect(buildTimeline(fixture, measurements, { maxExtendMs: 200 })).toEqual({
    error: "too_long",
    index,
  });
  expect(buildTimeline(fixture, measurements, { maxSpreadMs: 200 })).toEqual({
    error: "too_long",
    index,
  });
});

test("a final graphic keeps its length while speech overflow extends its preceding bound image", () => {
  const fixture = script();
  const before = fixture.cuts.at(-2);
  const last = fixture.cuts.at(-1);
  const line = fixture.voiceover.at(-1);
  if (!before || !last || !line) throw new Error("tail fixture missing");
  fixture.voiceover = [
    {
      ...line,
      fromCut: fixture.cuts.length - 2,
      toCut: fixture.cuts.length - 1,
      startSec: before.startSec,
      endSec: 36,
    },
  ];
  fixture.cuts = fixture.cuts.map((cut, index) =>
    index === fixture.cuts.length - 1
      ? { ...cut, source: "motion_graphic", graphicKind: "question", graphicLines: ["자세히 보기"] }
      : cut,
  );
  const durationMs = (36 - before.startSec) * 1000 + 233;
  const timeline = timelineOf(buildTimeline(fixture, [{ index: 0, durationMs, tempo: 1.2 }]));
  expect(timeline.durationMs).toBe(36233);
  expect(timeline.cuts.at(-1)?.endMs).toBe(36233);
  expect((timeline.cuts.at(-1)?.endMs ?? 0) - (timeline.cuts.at(-1)?.startMs ?? 0)).toBe(
    (last.endSec - last.startSec) * 1000,
  );
});
