import { expect, test } from "bun:test";
import { sourceImagePrompt } from "../server/source-image-style";
import { renderScript } from "./render-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

const original = "fixture-image-prompt";
const legacy = renderScript(1, "creative-a", 36);
const immersive = {
  ...legacy,
  planning: { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" as const },
};

test("image-only and legacy jobs preserve provider prompts exactly", () => {
  expect(sourceImagePrompt({ videoScripts: [] }, "creative-a", original)).toBe(original);
  expect(sourceImagePrompt({ videoScripts: [legacy] }, "creative-a", original)).toBe(original);
});

test("only the matching immersive video variant adds its image style", () => {
  const matching = sourceImagePrompt({ videoScripts: [immersive] }, "creative-a", original);
  expect(matching.startsWith(`${original}\n`)).toBe(true);
  expect(matching).not.toBe(original);
  expect(sourceImagePrompt({ videoScripts: [immersive] }, "creative-b", original)).toBe(original);
});

test("revised prompts retain the same suffix without copying an older draft", () => {
  const replacement = "fixture-revised-prompt";
  const initial = sourceImagePrompt({ videoScripts: [immersive] }, "creative-a", original);
  const revised = sourceImagePrompt({ videoScripts: [immersive] }, "creative-a", replacement);
  expect(revised.split("\n")[0]).toBe(replacement);
  expect(revised.slice(replacement.length)).toBe(initial.slice(original.length));
});
