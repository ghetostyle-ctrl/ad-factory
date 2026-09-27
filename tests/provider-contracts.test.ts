import { expect, test } from "bun:test";
import { codexArguments } from "../server/text-provider";
import { AnalysisReportSchema, ImageReviewSchema } from "../shared/planning";

test("omits model override when Codex CLI default is selected", () => {
  // Given
  const task = {
    schemaPath: "schema.json",
    resultPath: "result.json",
    model: null,
    imagePath: null,
  };
  // When
  const args = codexArguments(task);
  // Then
  expect(args).not.toContain("--model");
  expect(args).not.toContain("--image");
});

test("passes explicit model and local image attachment when Codex overrides are specified", () => {
  // Given
  const task = {
    schemaPath: "schema.json",
    resultPath: "result.json",
    model: "custom-codex-model",
    imagePath: "fixture.png",
  };
  // When
  const args = codexArguments(task);
  // Then
  expect(args[args.indexOf("--model") + 1]).toBe("custom-codex-model");
  expect(args[args.indexOf("--image") + 1]).toBe("fixture.png");
});

test("requires actionable revision instructions when vision requests a revision", () => {
  // Given
  const review = {
    status: "revise",
    summary: "검토",
    issues: ["텍스트 오류"],
    revisionPrompt: null,
  };
  // When
  const parsed = ImageReviewSchema.safeParse(review);
  // Then
  expect(parsed.success).toBe(false);
});

test("rejects fabricated metric fields when an analysis response exceeds the report contract", () => {
  // Given
  const report = {
    summary: "검토",
    observations: ["관측"],
    hypotheses: [],
    recommendations: [],
    limitations: ["한계"],
    predictedRoas: 42,
  };
  // When
  const parsed = AnalysisReportSchema.safeParse(report);
  // Then
  expect(parsed.success).toBe(false);
});
