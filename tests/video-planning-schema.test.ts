import { expect, test } from "bun:test";
import { z } from "zod";
import { VideoPlanningDraftResponseSchema, VideoPlanningSchema } from "../shared/video-planning";
import { scriptDigestJson, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

test("legacy saved scripts retain their approval digest without invented planning", () => {
  const original = VideoScriptSchema.omit({ planning: true }).parse(
    renderScript(1, "concept-1", 36),
  );
  const before = scriptDigestJson(original);
  const parsed = VideoScriptSchema.parse(JSON.parse(JSON.stringify(original)));
  expect(Object.hasOwn(parsed, "planning")).toBe(false);
  expect(scriptDigestJson(parsed)).toBe(before);
});

test("audience, concept and editorial history survive script storage and affect approval", () => {
  const original = renderScript(1, "concept-1", 36);
  const planning = fixtureVideoPlanning();
  const stored = VideoScriptSchema.parse({ ...original, planning });
  const restored = VideoScriptSchema.parse(JSON.parse(JSON.stringify(stored)));
  expect(restored.planning).toEqual(planning);
  expect(restored.planning?.copyReview.edits[0]?.before).toBe("사용성 확인");
  expect(scriptDigestJson(restored)).not.toBe(scriptDigestJson(original));
});

test("planning saved before the stop/muted/scene fields still parses and keeps its digest", () => {
  const { viewerChange, mutedMessage, stopReason, scenePlan, ...oldConcept } =
    fixtureVideoPlanning().concept;
  expect([viewerChange, mutedMessage, stopReason, scenePlan].every(Boolean)).toBe(true);
  const original = { ...renderScript(1, "concept-1", 36) };
  const stored = VideoScriptSchema.parse({
    ...original,
    planning: { ...fixtureVideoPlanning(), concept: oldConcept },
  });
  expect(Object.hasOwn(stored.planning?.concept ?? {}, "mutedMessage")).toBe(false);
  const restored = VideoScriptSchema.parse(JSON.parse(JSON.stringify(stored)));
  expect(scriptDigestJson(restored)).toBe(scriptDigestJson(stored));
});

test("the model response requires the four new planning fields", () => {
  const { copyReview: _review, ...legacyDraft } = fixtureVideoPlanning();
  const draft = { ...legacyDraft, durationSec: 48 };
  expect(VideoPlanningDraftResponseSchema.safeParse(draft).success).toBe(true);
  const { mutedMessage: _muted, ...withoutMuted } = draft.concept;
  expect(
    VideoPlanningDraftResponseSchema.safeParse({ ...draft, concept: withoutMuted }).success,
  ).toBe(false);
  expect(
    VideoPlanningDraftResponseSchema.safeParse({
      ...draft,
      concept: { ...draft.concept, mutedMessage: "가".repeat(41) },
    }).success,
  ).toBe(false);
  expect(
    VideoPlanningDraftResponseSchema.safeParse({
      ...draft,
      concept: { ...draft.concept, scenePlan: [draft.concept.scenePlan?.[0]] },
    }).success,
  ).toBe(false);
  const json = JSON.stringify(z.toJSONSchema(VideoPlanningDraftResponseSchema));
  for (const key of ["viewerChange", "mutedMessage", "stopReason", "scenePlan"])
    expect(json).toContain(key);
});

test("planning storage rejects missing audience context and invalid editorial positions", () => {
  const planning = fixtureVideoPlanning();
  expect(VideoPlanningSchema.safeParse({ ...planning, audience: {} }).success).toBe(false);
  expect(
    VideoPlanningSchema.safeParse({
      ...planning,
      copyReview: {
        ...planning.copyReview,
        edits: [{ ...planning.copyReview.edits[0], lineIndex: -1 }],
      },
    }).success,
  ).toBe(false);
});
