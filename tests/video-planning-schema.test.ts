import { expect, test } from "bun:test";
import { VideoPlanningSchema } from "../shared/video-planning";
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
