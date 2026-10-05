import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import {
  planningFixture,
  sourcePlanResponse,
  sourceReference,
  sourceStrategy,
} from "./source-planning-fixture";

const fixtures: ReturnType<typeof planningFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const fixture = planningFixture();
  fixtures.push(fixture);
  const reference = fixture.library.addSource(fixture.project.id, sourceReference);
  const valid = sourcePlanResponse(fixture.fact.id, [reference.id]);
  const wrong = {
    ...valid,
    customerQuestions: valid.customerQuestions.map((question, index) =>
      index === 0 ? { ...question, answeredByReferences: ["unknown-reference"] } : question,
    ),
  };
  return { fixture, reference, valid, wrong };
}
const names = (fixture: ReturnType<typeof planningFixture>) =>
  fixture.requests.map((request) => request.text.format.name);
const signal = () => new AbortController().signal;

test("retries an invalid customer reference once with allowed source categories then critiques only the valid plan", async () => {
  // Given
  const { fixture, reference, valid, wrong } = setup();
  fixture.planReplies.push(wrong, valid);
  // When
  const result = await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  expect(result.value.customerQuestions).toEqual(valid.customerQuestions);
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "source_creative_plan",
    "creative_plan_critique",
  ]);
  const second = fixture.requests.filter(
    (request) => request.text.format.name === "source_creative_plan",
  )[1];
  if (!second) throw new Error("second plan request missing");
  const marker = "REVISION FEEDBACK:";
  const feedback = z
    .array(z.string())
    .parse(JSON.parse(second.input.slice(second.input.lastIndexOf(marker) + marker.length)));
  expect(feedback.length).toBeGreaterThan(1);
  const recovery: unknown = JSON.parse(feedback[1] ?? "null");
  expect(recovery).toMatchObject({
    code: "customer_questions",
    allowedSourceIds: { FACTS: [fixture.fact.id], VOICES: [], REFERENCES: [reference.id] },
    fieldRules: {
      product_fact: "FACTS",
      customer_voice: "VOICES",
      inferred: [],
      answeredByReferences: "REFERENCES",
    },
  });
});

test("persistent invalid customer references stop after two plans without critique", async () => {
  // Given
  const { fixture, wrong } = setup();
  fixture.planReplies.push(wrong, wrong);
  // When
  const result = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(result).rejects.toMatchObject({ code: "customer_questions" });
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "source_creative_plan",
  ]);
});

test("a critique revision already consumes the sole retry before customer-question validation fails", async () => {
  // Given
  const { fixture, valid, wrong } = setup();
  fixture.planReplies.push(valid, wrong);
  fixture.replies.critique = { status: "revise", issues: ["Contradictory claim"] };
  // When
  const result = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(result).rejects.toMatchObject({ code: "customer_questions" });
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "creative_plan_critique",
    "source_creative_plan",
  ]);
});

test("a corrected second plan still fails an adverse critique without a third generation", async () => {
  // Given
  const { fixture, wrong, valid } = setup();
  fixture.planReplies.push(wrong, valid);
  fixture.replies.critique = { status: "revise", issues: ["Unsupported claim"] };
  // When
  const result = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(result).rejects.toMatchObject({ code: "plan_rejected" });
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "source_creative_plan",
    "creative_plan_critique",
  ]);
});
