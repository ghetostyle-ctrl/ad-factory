import { expect, test } from "bun:test";
import { clipNeedMsFromScript, clipNeedMsFromTimeline } from "../server/render/clip-need";
import { graphicLinesWithoutCaptions } from "../server/render/graphic-captions";
import type { Caption } from "../shared/narration-captions";
import {
  buildTimeline,
  EXPLAINER_HOLD_MS,
  type RenderTimeline,
  RenderTimelineSchema,
  SILENCE_GAP_MAX_MS,
  type TimelineWord,
  timelineDigest,
  type VoiceMeasurement,
} from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";
import { type VideoScript, VideoScriptSchema } from "../shared/video-script";
import { explanationMeasurements, explanationTimingScript } from "./explanation-timing-fixture";

// 설명 컷 보유(R9)·문장 사이 무음 상한(H6)·설명 컷 콜아웃 제외(H7), 사용자 결정 2026-10-07.
// 어제 완성본(8e3aeb37)은 설명 클립 8초를 통째로 틀고 말은 4초라 무음이 길었다.
function timelineOf(result: ReturnType<typeof buildTimeline>): RenderTimeline {
  if (!("timeline" in result)) throw new Error(`timeline expected, got ${JSON.stringify(result)}`);
  return RenderTimelineSchema.parse(result.timeline);
}
// 문장 글을 어절마다 0.4초씩 고르게 측정한 단어 시각(동작 싱크는 측정된 단어 시각을 요구한다)
function words(text: string): TimelineWord[] {
  return text.split(" ").map((token, index) => ({
    text: token,
    start: index * 0.5,
    end: index * 0.5 + 0.4,
  }));
}

// 어제 패턴: 설명 컷 2개(I1·I2)가 각 6초, 동작은 1.5초에 끝나고 말은 2초. 설명 클립은 처음부터 읽는다(naturalTiming).
function heldExplanations(): { script: VideoScript; measurements: VoiceMeasurement[] } {
  const base = explanationTimingScript();
  const cut = base.cuts[0];
  const line = base.voiceover[0];
  const clip = base.infoClips[0];
  const beat = clip?.explanation?.beats[0];
  if (!cut || !line || !clip?.explanation || !beat) throw new Error("fixture missing");
  const explanation = clip.explanation;
  const clipFor = (id: "I1" | "I2") => ({
    ...clip,
    id,
    explanation: {
      ...explanation,
      id: `${explanation.id}-${id.toLowerCase()}`,
      beats: [{ ...beat, startProgress: 0, endProgress: 1500 / 8000, narrationCue: "지금" }],
    },
  });
  const times: [number, number][] = [
    [0, 2],
    [2, 8],
    [8, 14],
    [14, 50],
  ];
  const texts = [
    "먼저 보세요.",
    "지금 내부 오일을 보세요.",
    "지금 비교를 보세요.",
    "제품을 비교하세요.",
  ];
  const script = VideoScriptSchema.parse({
    ...base,
    durationSec: 50,
    cuts: times.map(([startSec, endSec], index) => ({
      ...cut,
      startSec,
      endSec,
      source: index === 1 || index === 2 ? "veo_clip" : "approved_image",
      veoClip: index === 1 ? "I1" : index === 2 ? "I2" : "",
      phase: "",
    })),
    voiceover: texts.map((text, index) => ({
      ...line,
      text,
      fromCut: index,
      toCut: index,
      startSec: times[index]?.[0] ?? 0,
      endSec: times[index]?.[1] ?? 0,
      callouts: [],
      ...(index === 1 ? { actionSync: { clipId: "I1", beatId: "reveal" } } : {}),
      ...(index === 2 ? { actionSync: { clipId: "I2", beatId: "reveal" } } : {}),
    })),
    infoClips: [clipFor("I1"), clipFor("I2")],
  });
  const measurements: VoiceMeasurement[] = texts.map((text, index) => ({
    index,
    durationMs: [1200, 2000, 2000, 2000][index] ?? 0,
    tempo: 1,
    ...(index === 1 || index === 2 ? { words: words(text) } : {}),
  }));
  return { script, measurements };
}

test("an explainer cut leaves one second after its last action: yesterday's two four-second gaps become 500ms each", () => {
  // Given
  const { script, measurements } = heldExplanations();
  // When
  const timeline = timelineOf(
    buildTimeline(script, measurements, { trimSilence: true, naturalTiming: true }),
  );
  // Then: 도입 컷은 말 끝 + 0.3초, 설명 컷은 동작 끝(1.5초) + 1초 = 2.5초(말 끝 + 0.3초 = 2.3초보다 길다)
  expect(timeline.cuts.slice(0, 3).map((cut) => [cut.startMs, cut.endMs])).toEqual([
    [0, 1500],
    [1500, 4000],
    [4000, 6500],
  ]);
  expect(timeline.cuts[1]?.sourceRef).toEqual({ kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 });
  expect(timeline.cuts[2]?.sourceRef).toEqual({ kind: "veo", clipId: "I2", offsetMs: 0, padMs: 0 });
  // 설명 문장은 자기 컷 시작(동작 시작)에서 말하고, 다음 문장까지의 무음은 보유 1초 − 말 뒤 0.5초 = 0.5초
  const gaps = timeline.voice.slice(1).map((voice, index) => {
    const previous = timeline.voice[index];
    return previous ? voice.startMs - previous.startMs - previous.durationMs : -1;
  });
  expect(gaps).toEqual([300, 500, 500]);
  expect(1500 + EXPLAINER_HOLD_MS - 2000).toBe(SILENCE_GAP_MAX_MS);
  expect(timeline.warnings.filter((warning) => warning.includes("8초"))).toEqual([]);
});

test("an explainer cut stays until the narration ends plus 300ms when speech outlasts the action", () => {
  // Given: 두 번째 문장이 4초(동작 끝 1.5초 + 보유 1초 = 2.5초보다 길다)
  const { script, measurements } = heldExplanations();
  const second = measurements[1];
  if (!second) throw new Error("fixture missing");
  measurements[1] = {
    ...second,
    durationMs: 4000,
    words: words(script.voiceover[1]?.text ?? "").map((word) => ({
      ...word,
      start: word.start * 2,
      end: word.end * 2,
    })),
  };
  // When
  const timeline = timelineOf(
    buildTimeline(script, measurements, { trimSilence: true, naturalTiming: true }),
  );
  // Then
  const cut = timeline.cuts[1];
  const voice = timeline.voice[1];
  if (!cut || !voice) throw new Error("timeline missing");
  expect(voice.startMs).toBe(cut.startMs);
  expect(cut.endMs).toBe(voice.startMs + voice.durationMs + 300);
  expect(cut.endMs - cut.startMs).toBe(4300);
});

test.each([
  ["new planning reads from the start", true],
  ["legacy planning reads the end", false],
])(
  "a phase-less eight-second explainer cut without a synced beat is cut to its late phase with a warning (%s)",
  (_label, naturalTiming) => {
    // Given: I1 을 8초 통째로 요구하는 컷에 2초 문장, 동작 싱크 없음
    const base = explanationTimingScript();
    const script: VideoScript = {
      ...base,
      durationSec: 40,
      cuts: base.cuts.map((cut, index) =>
        index === 2 ? { ...cut, endSec: 40 } : index === 1 ? { ...cut, endSec: 10 } : cut,
      ),
      voiceover: base.voiceover.map(({ actionSync: _sync, ...line }, index) => ({
        ...line,
        endSec: index === 2 ? 40 : line.endSec,
      })),
    };
    const measurements: VoiceMeasurement[] = [
      { index: 0, durationMs: 1200, tempo: 1 },
      { index: 1, durationMs: 2000, tempo: 1 },
      { index: 2, durationMs: 2000, tempo: 1 },
    ];
    // When
    const timeline = timelineOf(
      buildTimeline(script, measurements, { trimSilence: true, naturalTiming }),
    );
    // Then: late 단계(2.5초)만 읽고 타임라인 컷은 phase "late" 를 싣는다. Flow 길이 검사도 같은 끝 지점(8초)을 본다.
    const cut = timeline.cuts[1];
    if (!cut) throw new Error("timeline missing");
    expect(cut.endMs - cut.startMs).toBe(2500);
    expect(cut.phase).toBe("late");
    expect(cut.sourceRef).toEqual({ kind: "veo", clipId: "I1", offsetMs: 5500, padMs: 0 });
    expect(timeline.warnings).toContainEqual(expect.stringContaining("late 단계(2.5초)"));
    expect(clipNeedMsFromTimeline(timeline.cuts, "I1")).toBe(8000);
    expect(clipNeedMsFromScript(script, "I1")).toBe(8000);
    // 다음 문장은 설명 컷 끝에서 바로 시작한다(말 2초 + 0.3초 = 2.3초 < 2.5초)
    expect(timeline.voice[2]?.startMs).toBe(cut.endMs);
  },
);

test("an eight-second explainer cut that a synced beat reads keeps its length and only warns", () => {
  // Given: 기존 픽스처(I1 2~10초, 동작 0.5~0.875)
  const script = explanationTimingScript();
  // When
  const timeline = timelineOf(
    buildTimeline(script, explanationMeasurements(), { trimSilence: true }),
  );
  // Then
  const cut = timeline.cuts[1];
  if (!cut) throw new Error("timeline missing");
  expect(cut.endMs - cut.startMs).toBe(8000);
  expect("phase" in cut).toBe(false);
  expect(timeline.warnings).toContainEqual(expect.stringContaining("8초 통째"));
  expect(timeline.warnings).toContainEqual(expect.stringContaining("그대로"));
  expect(timeline.voice[1]?.startMs).toBe(cut.startMs + 3000);
});

test("callouts are never drawn over explainer cuts", () => {
  // Given: 설명 문장(I1 컷)과 도입 문장(대표 이미지 컷)에 각각 콜아웃
  const script = explanationTimingScript();
  const intro = script.voiceover[0];
  const line = script.voiceover[1];
  if (!intro || !line) throw new Error("fixture missing");
  line.callouts = [{ word: "내부", text: "내부 오일", kind: "label", anchor: "subject" }];
  intro.callouts = [{ word: "먼저", text: "먼저 확인", kind: "label", anchor: "top" }];
  // When
  const timeline = timelineOf(buildTimeline(script, explanationMeasurements()));
  // Then: 설명 세계의 글자는 자막 한 줄뿐이다
  expect(timeline.callouts?.map((item) => [item.cutIndex, item.text])).toEqual([[0, "먼저 확인"]]);
  expect(timelineDigest(RenderTimelineSchema.parse(timeline))).toBe(timelineDigest(timeline));
});

const caption = (text: string, startMs: number, endMs: number): Caption => ({
  text,
  startMs,
  endMs,
  style: "bottom",
});
const panel = (
  graphicKind: "number" | "checklist" | "compare" | "question" | "callout",
  graphicLines: string[],
) => ({
  source: "motion_graphic" as const,
  graphicKind,
  graphicLines,
  startMs: 1000,
  endMs: 6000,
  purpose: "proof" as const,
});
const spoken = [
  caption("오일 원료", 2000, 2800),
  caption("기준이에요.", 2800, 3500),
  caption("지금 비교해", 3500, 4200),
  caption("보세요.", 4200, 5000),
];

test("panel lines already spoken by the captions on screen are left out of the graphic", () => {
  // 강조 상자(첫 줄)는 자리를 정하므로 남고, 자막이 말하는 두 줄은 빠진다
  expect(
    graphicLinesWithoutCaptions(
      panel("callout", [
        "제품 이름",
        "올리브유 100%(스페인산)",
        "오일 원료 기준",
        "지금 비교해 보세요",
      ]),
      spoken,
    ),
  ).toEqual(["제품 이름", "올리브유 100%(스페인산)"]);
  // 같은 자막이라도 컷 시각 밖이면 그대로
  expect(
    graphicLinesWithoutCaptions(
      panel("checklist", ["오일 원료 기준", "지금 비교해 보세요"]),
      spoken.map((item) => ({ ...item, startMs: item.startMs + 6000, endMs: item.endMs + 6000 })),
    ),
  ).toEqual(["오일 원료 기준", "지금 비교해 보세요"]);
  // 두 열이 자리를 나누는 compare 는 손대지 않고, 글줄이 모두 겹치면 빈 패널 대신 그대로 둔다
  expect(
    graphicLinesWithoutCaptions(panel("compare", ["오일 원료 기준", "지금 비교해 보세요"]), spoken),
  ).toEqual(["오일 원료 기준", "지금 비교해 보세요"]);
  expect(
    graphicLinesWithoutCaptions(
      panel("checklist", ["오일 원료 기준", "지금 비교해 보세요"]),
      spoken,
    ),
  ).toEqual(["오일 원료 기준", "지금 비교해 보세요"]);
  // 큰 숫자(첫 줄)는 남고 말한 설명 줄만 빠진다. 다른 숫자(1100%)는 같은 글로 보지 않는다.
  const percent = [
    caption("백 퍼센트거든요.", 2000, 3000),
    caption("올리브유 함량이에요.", 3000, 4000),
  ];
  expect(graphicLinesWithoutCaptions(panel("number", ["100%", "올리브유 함량"]), percent)).toEqual([
    "100%",
  ]);
  expect(
    graphicLinesWithoutCaptions(panel("checklist", ["100%", "올리브유 함량"]), [
      caption("1100%", 2000, 3000),
    ]),
  ).toEqual(["100%", "올리브유 함량"]);
  // 실사 컷은 글줄이 없다
  expect(
    graphicLinesWithoutCaptions({ ...panel("callout", ["제품 이름"]), source: "veo_clip" }, spoken),
  ).toEqual(["제품 이름"]);
  // 어제 완성본의 엔딩: immersive 행동 유도 패널은 compare 로 적혀 있어도 강조 상자 템플릿이라 말한 줄을 뺀다
  expect(
    graphicLinesWithoutCaptions(
      {
        ...panel("compare", [
          "제품 이름",
          "올리브유 100%(스페인산)",
          "오일 원료 기준",
          "지금 비교해 보세요",
        ]),
        purpose: "cta",
        visualPolicy: "immersive_explanations_v1",
      },
      spoken,
    ),
  ).toEqual(["제품 이름", "올리브유 100%(스페인산)"]);
});

test("a timeline JSON saved before the hybrid policy keeps its bytes and digest after parsing", () => {
  // Given: 예전 저장본의 키 순서 그대로(스키마 순서). visualPolicy 는 enum 이 됐지만 예전 값은 그대로 읽힌다.
  const saved = JSON.stringify({
    number: 1,
    durationMs: 4000,
    extendedMs: 0,
    scriptDigest: "saved",
    cuts: [
      {
        index: 0,
        startMs: 0,
        endMs: 4000,
        purpose: "proof",
        source: "veo_clip",
        effect: "hard_cut",
        onScreenText: "",
        caption: null,
        graphicKind: "",
        graphicLines: [],
        sourceRef: { kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 },
        phase: "early",
        visualPolicy: "immersive_explanations_v1",
      },
    ],
    voice: [],
    warnings: [],
    captions: [],
    callouts: [
      {
        cutIndex: 0,
        text: "라벨",
        kind: "label",
        anchor: "subject",
        color: 0,
        startMs: 0,
        endMs: 4000,
      },
    ],
    visualPolicy: "immersive_explanations_v1",
  });
  // When
  const parsed = RenderTimelineSchema.parse(JSON.parse(saved));
  // Then
  expect(JSON.stringify(parsed)).toBe(saved);
  expect(timelineDigest(parsed)).toBe(sha256Hex(saved));
});
