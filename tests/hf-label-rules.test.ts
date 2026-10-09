import { expect, test } from "bun:test";
import { infoTextProblems } from "../server/flow-import";
import { flowExportFor, flowTexts } from "../server/flow-instructions";
import {
  infoClipExpectsText,
  infoMotionPrompt,
  infoOverlayPrompt,
} from "../shared/flow-info-prompts";
import { videoScriptFromResponse } from "../shared/script-repair";
import { InfoClipSchema, scriptDigestJson, VideoScriptSchema } from "../shared/video-script";
import { hfLabelFixture } from "./hf-label-fixture";
import { providerStore } from "./provider-fixtures";
import { hybridScriptResponse } from "./video-script-fixture";

function inputs() {
  const response = hybridScriptResponse();
  const first = response.infoClips[0];
  if (!first) throw new TypeError("Missing fixture clip");
  return {
    motionPrompt: "",
    graphicOrder: [],
    ...first,
    labelLayer: hfLabelFixture(
      first.infoLines.length,
      first.objects.map((x) => x.subjectId),
    ),
  };
}

test("stores the complete annotation plan without changing its exact label lines", () => {
  // Given
  const input = inputs();
  // When
  const result = InfoClipSchema.safeParse(input);
  // Then
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data).toMatchObject({ infoLines: input.infoLines, labelLayer: input.labelLayer });
});

test("requires text-free INFO while retaining label wording for the compositor", () => {
  // Given
  const clip = inputs();
  // When
  const expectsText = infoClipExpectsText(clip);
  const problems = infoTextProblems(clip, [], ["arrow", "ring"]);
  // Then
  expect(expectsText).toBe(false);
  expect(problems).toEqual([]);
  expect(clip.infoLines.length).toBeGreaterThan(0);
});

test("rejects even one generated letter and label plates in a text-free INFO", () => {
  // Given
  const clip = inputs();
  // When
  const text = infoTextProblems(clip, ["가"]);
  const plate = infoTextProblems(clip, [], ["name_tag", "value_box"]);
  // Then
  expect(text.length).toBeGreaterThan(0);
  expect(plate.length).toBeGreaterThan(0);
});

test("does not send label text to either Veo image or motion prompts", () => {
  // Given
  const clip = { ...inputs(), infoLines: ["라벨전용기밀문구"] };
  const texts = flowTexts();
  // When
  const prompts = [infoOverlayPrompt(clip, texts), infoMotionPrompt(clip, texts)];
  // Then: user data routing, not a pinned prompt sentence
  for (const prompt of prompts) {
    for (const label of clip.infoLines) expect(prompt).not.toContain(label);
    for (const graphic of clip.labelLayer.veoGraphics) expect(prompt).toContain(graphic);
  }
});

test("retains label plans through response repair and the real Flow export builder", () => {
  // Given
  const response = hybridScriptResponse();
  const first = inputs();
  const changed = { ...response, infoClips: [first, ...response.infoClips.slice(1)] };
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing fixture job");
    // When
    const { script } = videoScriptFromResponse(changed, {
      number: 1,
      hypothesisId: "concept-1",
      targetSec: 36,
      hasCardSlides: false,
    });
    const data = flowExportFor({ ...job, videoScripts: [script] }, 1);
    // Then
    expect(data.infoClips[0]).toMatchObject({
      infoLines: first.infoLines,
      labelLayer: first.labelLayer,
      suggestedModel: "Veo 3.1 - Lite",
    });
    expect(scriptDigestJson(script)).toContain('"labelLayer"');
  } finally {
    store.close();
  }
});

test("preserves the digest and old INFO inspection when a saved script has no label plan", () => {
  // Given
  const { script } = videoScriptFromResponse(hybridScriptResponse(), {
    number: 1,
    hypothesisId: "concept-1",
    targetSec: 36,
    hasCardSlides: false,
  });
  const before = scriptDigestJson(VideoScriptSchema.parse(script));
  // When
  const saved = VideoScriptSchema.parse(JSON.parse(JSON.stringify(script)));
  // Then
  expect(scriptDigestJson(saved)).toBe(before);
  expect(before).not.toContain('"labelLayer"');
  const clip = saved.infoClips[0];
  if (!clip) throw new TypeError("Missing fixture clip");
  expect(infoTextProblems(clip, clip.infoLines)).toEqual([]);
  expect(infoTextProblems(clip, []).length).toBeGreaterThan(0);
});

for (const [name, mutate] of [
  [
    "unknown target",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.targetId = "missing";
    },
  ],
  [
    "missing label reference",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.lineIndex = 3;
    },
  ],
  [
    "outside safe frame",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.box.x = 0.9;
    },
  ],
  [
    "too small font",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.fontSizePx = 40;
    },
  ],
  [
    "low contrast",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.textColor = l.plateColor;
    },
  ],
  [
    "no reading hold",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const l = p.labels[0];
      if (l) l.endSec = l.fullSec + 0.1;
    },
  ],
  [
    "uncovered motion interval",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const a = p.labels[0]?.anchors[0];
      if (a) a.atSec = 3;
    },
  ],
  [
    "reversed motion keyframes",
    (p: ReturnType<typeof hfLabelFixture>) => {
      const a = p.labels[0]?.anchors[1];
      if (a) a.atSec = 0;
    },
  ],
] as const)
  test(`rejects ${name} in an annotation plan`, () => {
    // Given
    const clip = inputs();
    mutate(clip.labelLayer);
    // When
    const result = InfoClipSchema.safeParse(clip);
    // Then
    expect(result.success).toBe(false);
  });

test("rejects duplicate references and simultaneously overlapping label plates", () => {
  // Given
  const clip = inputs(),
    layer = hfLabelFixture(
      2,
      clip.objects.map((x) => x.subjectId),
    );
  const first = layer.labels[0],
    second = layer.labels[1];
  if (!first || !second) throw new TypeError("Missing fixture label");
  const duplicate = { ...layer, labels: [first, { ...second, lineIndex: first.lineIndex }] };
  const overlap = { ...layer, labels: [first, { ...second, box: first.box }] };
  // When / Then
  for (const labelLayer of [duplicate, overlap])
    expect(
      InfoClipSchema.safeParse({ ...clip, infoLines: ["첫 문구", "둘째 문구"], labelLayer })
        .success,
    ).toBe(false);
});

test("rejects label connectors while allowing structural line shapes", () => {
  // Given
  const clip = inputs();
  // When
  const structural = infoTextProblems(clip, [], ["arrow", "ring", "leader_line"]);
  const annotation = infoTextProblems(
    clip,
    [],
    ["label_connector", "label_endpoint", "empty_label_box"],
  );
  // Then
  expect(structural).toEqual([]);
  expect(annotation.length).toBeGreaterThan(0);
});
