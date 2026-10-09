import { expect, test } from "bun:test";
import { classifyScriptProblems, scenePlanProblems } from "../shared/script-rules";
import { VideoPlanningDraftResponseSchema, VideoPlanningSchema } from "../shared/video-planning";
import { InfoClipSchema, scriptDigestJson, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { sourcePlanResponse } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { fixtureClipPlan } from "./video-script-fixture";

function requiredHypothesis() {
  const hypothesis = sourcePlanResponse("fact-1").hypotheses[0];
  if (!hypothesis) throw new TypeError("Missing test hypothesis");
  return hypothesis;
}
const hypothesis = requiredHypothesis();
const info = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  cleanPrompt: "Transparent oil capsule",
  infoPrompt: "Three-dimensional oil separates inside a cutaway capsule",
  graphicOrder: ["Shell separates", "Oil volume is revealed"],
  plan: fixtureClipPlan("I1"),
});
const expected = { number: 1, durationSec: 36, hypothesis, infoClipsAllowed: true };
function explanationScript() {
  const base = renderScript(1, hypothesis.id, 36);
  return {
    ...base,
    planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" as const },
    voiceover: base.voiceover.map((voice, index) => ({
      ...voice,
      purpose: index === 0 ? ("mechanism" as const) : ("story" as const),
      chainStep: "bridge" as const,
    })),
  };
}

test("new immersive planning rejects an explanation without an actual INFO cut", () => {
  // Given: a mechanism is narrated over the old live-action/flat-card sequence.
  const script = explanationScript();
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((item) => item.includes("설명 문장") && item.includes("I1~I3"))).toBe(
    true,
  );
});

test("an INFO declaration without a cut in the explained sentence cannot satisfy the gate", () => {
  // Given
  const script = explanationScript();
  script.infoClips = [info];
  script.cuts = script.cuts.map((cut, index) =>
    index === 5
      ? {
          ...cut,
          source: "veo_clip",
          veoClip: "I1",
          phase: "early",
        }
      : cut,
  );
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((item) => item.includes("설명 문장"))).toBe(true);
});

test("legacy planning remains editable without the new explanation policy", () => {
  // Given
  const script = VideoScriptSchema.parse({
    ...explanationScript(),
    planning: fixtureVideoPlanning(),
  });
  const before = scriptDigestJson(script);
  // When
  const parsed = VideoScriptSchema.parse(script);
  const problems = classifyScriptProblems(parsed, expected);
  // Then
  expect(Object.hasOwn(parsed.planning ?? {}, "visualPolicy")).toBe(false);
  expect(scriptDigestJson(parsed)).toBe(before);
  expect(problems.hard.some((item) => item.includes("설명 문장"))).toBe(false);
});

test("new policy allows a full eight-second visual action while legacy retains its old cut limit", () => {
  // Given
  const script = explanationScript();
  script.cuts = script.cuts.slice(0, 1).map((cut) => ({ ...cut, startSec: 0, endSec: 8 }));
  // When
  const fresh = scenePlanProblems(script);
  const legacy = scenePlanProblems({ ...script, planning: fixtureVideoPlanning() });
  // Then
  expect(fresh.hard.some((item) => item.includes("길이 8초"))).toBe(false);
  expect(legacy.hard.some((item) => item.includes("길이 8초"))).toBe(true);
});

test("new planning stores content-led duration up to sixty without backfilling older planning", () => {
  // Given
  const old = fixtureVideoPlanning();
  const { copyReview, ...draft } = old;
  // When
  const parsed = VideoPlanningSchema.safeParse({
    ...old,
    durationSec: 54,
    visualPolicy: "immersive_explanations_v1",
  });
  // Then
  expect(parsed.success).toBe(true);
  expect(VideoPlanningDraftResponseSchema.safeParse({ ...draft, durationSec: 60 }).success).toBe(
    true,
  );
  expect(VideoPlanningDraftResponseSchema.safeParse({ ...draft, durationSec: 61 }).success).toBe(
    false,
  );
  expect(VideoPlanningSchema.parse(old)).toEqual(old);
  expect(copyReview.status).toBe("revised");
});

test("an explanation requires its own used INFO clip, not an unrelated declaration", () => {
  // Given
  const script = explanationScript();
  script.infoClips = [info];
  script.cuts = script.cuts.map((cut, index) =>
    index === 0
      ? {
          ...cut,
          source: "veo_clip",
          veoClip: "I1",
          phase: "early",
        }
      : cut,
  );
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((item) => item.includes("설명 문장"))).toBe(false);
});

test("the INFO requirement is limited to the Flow path", () => {
  // Given
  const script = explanationScript();
  // When
  const problems = classifyScriptProblems(script, { ...expected, infoClipsAllowed: false });
  // Then
  expect(problems.hard.some((item) => item.includes("설명 문장"))).toBe(false);
});

test("a declared INFO scene omitted by purpose relabeling is still rejected", () => {
  // Given
  const script = explanationScript();
  script.planning.concept.scenePlan = [
    { scene: "구성 분리", source: "info_clip", reason: "구성 설명" },
  ];
  script.voiceover = script.voiceover.map((voice) => ({ ...voice, purpose: "story" }));
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((item) => item.includes("기획에서 정한 3D 설명"))).toBe(true);
});

test("overlapping INFO phase reads are rejected before media production", () => {
  // Given: seven total seconds still overlap inside an eight-second source.
  const script = explanationScript();
  const first = script.cuts[0];
  if (!first) throw new TypeError("Missing first cut");
  script.infoClips = [info];
  script.cuts = [
    { ...first, source: "veo_clip", veoClip: "I1", phase: "early", startSec: 0, endSec: 1 },
    { ...first, source: "veo_clip", veoClip: "I1", phase: "mid", startSec: 1, endSec: 5 },
    { ...first, source: "veo_clip", veoClip: "I1", phase: "late", startSec: 5, endSec: 7 },
  ];
  // When
  const problems = classifyScriptProblems(script, expected);
  // Then
  expect(problems.hard.some((item) => item.includes("클립 I1") && item.includes("겹쳐"))).toBe(
    true,
  );
});
