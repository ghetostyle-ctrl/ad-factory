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
  // 출처 ID 종류 불일치는 이제 거부 대신 고치므로(2026-10-06), 고칠 수 없는 구조 오류(없는 고객 질문 ID)를 쓴다.
  const wrong = {
    ...valid,
    hypotheses: valid.hypotheses.map((hypothesis, index) =>
      index === 0 ? { ...hypothesis, customerQuestionId: "question-missing" } : hypothesis,
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

test("persistent invalid customer references stop after four plans without critique", async () => {
  // Given
  const { fixture, wrong } = setup();
  fixture.planReplies.push(wrong, wrong, wrong, wrong);
  // When
  const result = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(result).rejects.toMatchObject({ code: "customer_questions" });
  // 구조 오류 재작성은 최대 3회(생성 4회)까지(2026-10-06).
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "source_creative_plan",
    "source_creative_plan",
    "source_creative_plan",
  ]);
});

// 구조 오류 재작성(최대 3회)과 기획 검토 수정 1회는 따로 센다(2026-10-05 실전 실행에서 구조 재작성이 검토 수정 기회를 써 버렸다).
test("a critique revision does not consume the structural retry", async () => {
  // Given
  const { fixture, valid, wrong } = setup();
  fixture.planReplies.push(valid, wrong);
  fixture.replies.critique = { status: "revise", issues: ["Contradictory claim"] };
  // When
  const result = await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  expect(result.value.limitations).toContain("검토 미해결: Contradictory claim");
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "creative_plan_critique",
    "source_creative_plan",
    "source_creative_plan",
    "creative_plan_critique",
    "source_creative_plan",
    "creative_plan_critique",
  ]);
});

test("a structural retry still leaves two critique revisions, and a third adverse critique is accepted with limitations", async () => {
  // Given
  const { fixture, wrong, valid } = setup();
  fixture.planReplies.push(wrong, valid);
  fixture.replies.critique = { status: "revise", issues: ["Unsupported claim"] };
  // When
  const result = await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  expect(result.value.limitations).toContain("검토 미해결: Unsupported claim");
  expect(names(fixture)).toEqual([
    "reference_structure",
    "source_creative_plan",
    "source_creative_plan",
    "creative_plan_critique",
    "source_creative_plan",
    "creative_plan_critique",
    "source_creative_plan",
    "creative_plan_critique",
  ]);
});
