import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelSettings, saveModelSettings, snapshotModels } from "../server/model-settings";
import { defaultScriptModel, ExecutionModelsSchema, ModelSettingsSchema } from "../shared/models";

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "studio-models-"));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("retains selected settings after a fresh disk read when settings are saved", () => {
  // Given
  const directory = root();
  const selected = {
    ...getModelSettings(directory),
    textProvider: "openai",
    textModel: "custom-text-v7",
    codexModel: "custom-codex-v3",
    imageModel: "gpt-image-2.5-flare",
    imageQuality: "max",
    ttsSelection: "manual",
    ttsVoiceId: "tc_68537c9420b646f2176890ba",
    ttsTempo: 1.05,
  } as const;
  // When
  saveModelSettings(directory, selected);
  // Then
  expect(getModelSettings(directory)).toEqual(selected);
  expect(JSON.parse(readFileSync(join(directory, "model-settings.json"), "utf8"))).toEqual(
    selected,
  );
});

test("keeps a frozen execution model when later settings change", () => {
  // Given
  const directory = root();
  saveModelSettings(directory, {
    ...getModelSettings(directory),
    textProvider: "codex",
    codexModel: null,
    imageModel: "gpt-image-2.5-sunburst",
    imageQuality: "xhigh",
    ttsSelection: "manual",
    ttsVoiceId: "tc_69f2e455ea79fd197aa0476f",
  });
  const started = snapshotModels(directory);
  // When
  saveModelSettings(directory, {
    ...getModelSettings(directory),
    textProvider: "openai",
    imageModel: "gpt-image-2",
    imageQuality: "low",
  });
  // Then
  expect(started).toMatchObject({
    textProvider: "codex",
    codexModel: null,
    imageModel: "gpt-image-2.5-sunburst",
    imageQuality: "xhigh",
    ttsSelection: "manual",
    ttsVoiceId: "tc_69f2e455ea79fd197aa0476f",
  });
  expect(Object.isFrozen(started)).toBe(true);
});

test("rejects incompatible quality, invalid model IDs and secrets when parsing settings", () => {
  // Given
  const settings = getModelSettings(root());
  // When / Then
  expect(
    ModelSettingsSchema.safeParse({ ...settings, imageModel: "gpt-image-2", imageQuality: "max" })
      .success,
  ).toBe(false);
  expect(ModelSettingsSchema.safeParse({ ...settings, textModel: "--model evil" }).success).toBe(
    false,
  );
  expect(ModelSettingsSchema.safeParse({ ...settings, openaiApiKey: "secret" }).success).toBe(
    false,
  );
  expect(
    ModelSettingsSchema.safeParse({
      ...settings,
      imageModel: "custom-image:2026",
      imageQuality: "medium",
    }).success,
  ).toBe(true);
  expect(
    ModelSettingsSchema.safeParse({
      ...settings,
      ttsSelection: "manual",
      ttsVoiceId: null,
    }).success,
  ).toBe(false);
});

test("persists a separate OpenAI script model without changing the common model or frozen snapshot", () => {
  // Given
  const directory = root();
  const selected = {
    ...getModelSettings(directory),
    textProvider: "openai",
    textModel: "gpt-planning-fixture",
    scriptProvider: "openai",
    scriptModel: "gpt-script-fixture",
  } as const;
  // When
  saveModelSettings(directory, selected);
  const started = snapshotModels(directory);
  saveModelSettings(directory, { ...selected, scriptModel: "gpt-script-next" });
  // Then
  expect(getModelSettings(directory)).toMatchObject({
    textModel: "gpt-planning-fixture",
    scriptProvider: "openai",
    scriptModel: "gpt-script-next",
  });
  expect(started).toMatchObject({
    textModel: "gpt-planning-fixture",
    scriptProvider: "openai",
    scriptModel: "gpt-script-fixture",
  });
  expect(Object.isFrozen(started)).toBe(true);
});

test("keeps legacy snapshots byte-for-byte equivalent when script overrides are absent", () => {
  // Given
  const legacy = snapshotModels(root());
  const original = JSON.stringify(legacy);
  // When
  const parsed = ExecutionModelsSchema.parse(legacy);
  // Then
  expect(JSON.stringify(parsed)).toBe(original);
  expect(Object.hasOwn(parsed, "scriptProvider")).toBe(false);
  expect(Object.hasOwn(parsed, "scriptModel")).toBe(false);
});

test.each([
  ["openai", "claude-opus-5-5"],
  ["anthropic", "gpt-script-fixture"],
])("rejects a known foreign model family when %s is selected", (scriptProvider, scriptModel) => {
  // Given
  const selected = { ...getModelSettings(root()), scriptProvider, scriptModel };
  // When
  const parsed = ModelSettingsSchema.safeParse(selected);
  // Then
  expect(parsed.success).toBe(false);
});

test.each([
  ["openai", "gpt-common-fixture", "gpt-common-fixture"],
  ["openai", "claude-opus-5-5", "gpt-5-mini"],
  ["anthropic", "gpt-common-fixture", "claude-opus-5-5"],
] as const)("selects a compatible default for %s from %s", (provider, common, model) => {
  // Given / When
  const selected = defaultScriptModel(provider, common);
  // Then
  expect(selected).toBe(model);
  expect(
    ModelSettingsSchema.safeParse({
      ...getModelSettings(root()),
      scriptProvider: provider,
      scriptModel: selected,
    }).success,
  ).toBe(true);
});

test("preserves previously captured identifiers when reading legacy frozen models", () => {
  // Given
  const legacy = {
    ...snapshotModels(root()),
    scriptProvider: "anthropic",
    scriptModel: "gpt-legacy-alias",
  } as const;
  // When
  const parsed = ExecutionModelsSchema.parse(legacy);
  // Then
  expect(parsed).toEqual(legacy);
});
