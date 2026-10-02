import { afterEach, expect, test } from "bun:test";
import { evidencePack } from "../server/evidence-pack";
import { SourcePlanner } from "../server/source-planning";
import { CreateSourceSchema } from "../shared/sources";
import {
  planningFixture,
  sourceFact,
  sourcePlanResponse,
  sourceReference,
  sourceStrategy,
} from "./source-planning-fixture";

const fixtures: ReturnType<typeof planningFixture>[] = [];
function setup() {
  const fixture = planningFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const signal = () => new AbortController().signal;

test.each(["revise", "pass"] as const)(
  "rejects after one revision when critique reports issues with status %s",
  async (status) => {
    // Given
    const fixture = setup();
    fixture.replies.critique = { status, issues: ["Unsupported additional product claim"] };
    // When
    const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
    // Then
    await expect(planned).rejects.toMatchObject({ code: "plan_rejected" });
    expect(fixture.requests.map((item) => item.text.format.name)).toEqual([
      "source_creative_plan",
      "creative_plan_critique",
      "source_creative_plan",
      "creative_plan_critique",
    ]);
  },
);

test("returns three grounded hypotheses when factual sources and model critique agree", async () => {
  // Given
  const fixture = setup();
  const reference = fixture.library.addSource(fixture.project.id, sourceReference);
  fixture.replies.plan = sourcePlanResponse(fixture.fact.id, [reference.id]);
  const job = fixture.job();
  if (!job.sourceSnapshot) throw new TypeError("Fixture requires a source snapshot");
  // When
  const result = await fixture.planner.plan(job, sourceStrategy, signal());
  // Then
  expect(result.value.hypotheses).toHaveLength(3);
  expect(new Set(result.value.hypotheses.map((item) => item.angle)).size).toBe(3);
  expect(result.value.hypotheses.flatMap((item) => item.claimCitations)).toEqual(
    Array.from({ length: 3 }, () => ({ sourceId: fixture.fact.id, quote: sourceFact.content })),
  );
  expect(result.value.sourceDigest).toBe(job.sourceSnapshot.digest);
  expect(result.value.referenceAnalyses).toEqual([
    { ...fixture.replies.reference, sourceId: reference.id },
  ]);
  expect(result.model).toMatchObject({
    requestedModel: "fixture-text-model",
    effectiveModel: "fixture-observed-model",
  });
});

test("includes completed media cut analysis when planning from references", async () => {
  // Given
  const fixture = setup();
  const reference = fixture.library.addSource(fixture.project.id, sourceReference);
  fixture.store.db.run(`CREATE TABLE project_media (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
    body TEXT NOT NULL, file_path TEXT)`);
  fixture.store.db.run(
    "CREATE TABLE project_media_analysis (asset_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  const assetId = crypto.randomUUID();
  fixture.store.db
    .query(
      "INSERT INTO project_media (id, project_id, source_id, body, file_path) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      assetId,
      fixture.project.id,
      reference.id,
      JSON.stringify({
        id: assetId,
        kind: "video",
        sourceUrl: "https://example.invalid/ad.mp4",
      }),
      "fixture.mp4",
    );
  fixture.store.db.query("INSERT INTO project_media_analysis (asset_id, body) VALUES (?, ?)").run(
    assetId,
    JSON.stringify({
      assetId,
      status: "complete",
      error: null,
      report: {
        kind: "video",
        assetSha256: "a".repeat(64),
        model: "fixture-text-model",
        createdAt: "2026-09-24T00:00:00.000Z",
        durationSec: 3,
        sampling: "컷별 분석",
        cuts: [
          {
            startSec: 0,
            endSec: 1,
            screenComposition: "첫 화면에 질문 자막과 얼굴 클로즈업",
            onScreenText: "이거 아직도 고민하세요?",
            messageText: "초반 문제 제기",
          },
        ],
        transcript: [],
        limitations: ["성과는 알 수 없음"],
      },
    }),
  );
  fixture.replies.plan = sourcePlanResponse(fixture.fact.id, [reference.id]);
  // When
  await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  const planningRequest = fixture.requests.find(
    (item) => item.text.format.name === "source_creative_plan",
  );
  if (!planningRequest) throw new TypeError("Expected a planning request");
  const data = JSON.parse(
    planningRequest.input.split("DATA:\n")[1]?.split("\nREVISION")[0] ?? "{}",
  );
  expect(data.mediaAnalysesByReference).toEqual([
    {
      sourceId: reference.id,
      mediaAnalyses: [
        {
          assetId,
          kind: "video",
          sourceUrl: "https://example.invalid/ad.mp4",
          sampling: "컷별 분석",
          cuts: [
            {
              startSec: 0,
              endSec: 1,
              screenComposition: "첫 화면에 질문 자막과 얼굴 클로즈업",
              onScreenText: "이거 아직도 고민하세요?",
              messageText: "초반 문제 제기",
            },
          ],
          transcript: [],
          limitations: ["성과는 알 수 없음"],
        },
      ],
    },
  ]);
});

test("reuses reference analysis across source IDs and planner instances when digest and model match", async () => {
  // Given
  const fixture = setup();
  const first = fixture.library.addSource(fixture.project.id, sourceReference);
  await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  const duplicate = fixture.library.addSource(fixture.project.id, sourceReference);
  // When
  const result = await new SourcePlanner(fixture.store, fixture.connection).plan(
    fixture.job(),
    sourceStrategy,
    signal(),
  );
  // Then
  expect(duplicate.digest).toBe(first.digest);
  expect(
    fixture.requests.filter((item) => item.text.format.name === "reference_structure"),
  ).toHaveLength(1);
  expect(result.value.referenceAnalyses.map((item) => item.sourceId)).toEqual([
    first.id,
    duplicate.id,
  ]);
});

test.each(["model", "digest"] as const)(
  "reanalyzes a reference when its %s changes",
  async (changed) => {
    // Given
    const fixture = setup();
    const reference = fixture.library.addSource(fixture.project.id, sourceReference);
    await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
    if (changed === "digest")
      fixture.library.updateSource(fixture.project.id, reference.id, {
        ...sourceReference,
        content: "A different supplied sequence.",
      });
    const job = fixture.job();
    if (!job.executionModels) throw new TypeError("Fixture requires execution models");
    const next =
      changed === "model"
        ? { ...job, executionModels: { ...job.executionModels, textModel: "fixture-second-model" } }
        : job;
    // When
    await fixture.planner.plan(next, sourceStrategy, signal());
    // Then
    const requests = fixture.requests.filter(
      (item) => item.text.format.name === "reference_structure",
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((item) => item.model)).toEqual([
      "fixture-text-model",
      changed === "model" ? "fixture-second-model" : "fixture-text-model",
    ]);
  },
);

test("makes no reference-analysis request when a reference only contains a URL", async () => {
  // Given
  const fixture = setup();
  const source = fixture.library.addSource(
    fixture.project.id,
    CreateSourceSchema.parse({
      kind: "reference",
      title: "URL only",
      url: "https://example.invalid/ad",
    }),
  );
  // When
  const result = await fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  expect(fixture.requests.map((item) => item.text.format.name)).toEqual([
    "source_creative_plan",
    "creative_plan_critique",
  ]);
  expect(result.value.referenceAnalyses).toEqual([]);
  expect(result.value.sourceCoverage.excluded.map((item) => item.sourceId)).toContain(source.id);
});

test.each([2, 4])(
  "rejects %d hypotheses when the provider does not return exactly three",
  async (count) => {
    // Given
    const fixture = setup();
    const first = fixture.replies.plan.hypotheses[0];
    if (!first) throw new TypeError("Fixture requires a hypothesis");
    fixture.replies.plan.hypotheses =
      count === 2
        ? fixture.replies.plan.hypotheses.slice(0, 2)
        : [...fixture.replies.plan.hypotheses, first];
    // When
    const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
    // Then
    await expect(planned).rejects.toMatchObject({ code: "diversity" });
    expect(fixture.requests).toHaveLength(1);
  },
);

test.each([
  "id",
  "angle",
  "targetAudience",
  "customerSituation",
  "problem",
  "message",
  "visualMechanism",
  "hook",
] as const)("rejects repeated %s when concepts lose diversity", async (field) => {
  // Given
  const fixture = setup();
  const first = fixture.replies.plan.hypotheses[0];
  if (!first) throw new TypeError("Fixture requires a hypothesis");
  fixture.replies.plan.hypotheses = fixture.replies.plan.hypotheses.map((item) => ({
    ...item,
    [field]: first[field],
  }));
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "diversity" });
});

test("rejects cosmetic whitespace and casing changes when hooks remain equivalent", async () => {
  // Given
  const fixture = setup();
  fixture.replies.plan.hypotheses = fixture.replies.plan.hypotheses.map((item, index) => ({
    ...item,
    hook: index === 0 ? "ＨＥＬＬＯ WORLD" : "hello  world",
  }));
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "diversity" });
});

test("rejects reference influence when the referenced content was never observed", async () => {
  // Given
  const fixture = setup();
  fixture.replies.plan = sourcePlanResponse(fixture.fact.id, [crypto.randomUUID()]);
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "reference" });
});

test("blocks before calling a model when only reviews and references remain", async () => {
  // Given
  const fixture = setup();
  fixture.library.deactivateSource(fixture.project.id, fixture.fact.id);
  fixture.library.addSource(fixture.project.id, { ...sourceFact, kind: "review" });
  fixture.library.addSource(fixture.project.id, sourceReference);
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "blocked" });
  expect(fixture.requests).toEqual([]);
});

test("preserves complete records when character budgets exclude oversized evidence", () => {
  // Given
  const fixture = setup();
  fixture.library.deactivateSource(fixture.project.id, fixture.fact.id);
  const items = [
    { ...sourceFact, content: "a".repeat(20000) },
    { ...sourceFact, content: "b".repeat(4001) },
    { ...sourceFact, content: "c".repeat(4000) },
    { ...sourceReference, content: "d".repeat(8001) },
    { ...sourceReference, content: "e".repeat(8000) },
    { ...sourceFact, kind: "review", content: "f".repeat(6000) },
    { ...sourceFact, kind: "review", content: "g".repeat(2001) },
    { ...sourceFact, kind: "review", content: "h".repeat(2000) },
  ].map((item) => fixture.library.addSource(fixture.project.id, CreateSourceSchema.parse(item)));
  // When
  const pack = evidencePack(fixture.library.snapshot(fixture.project.id));
  // Then
  expect(pack.facts).toEqual(items.filter((_, index) => [0, 2].includes(index)));
  expect(pack.references).toEqual(items.slice(4, 5));
  expect(pack.voices).toEqual(items.filter((_, index) => [5, 7].includes(index)));
  expect(pack.coverage.excluded.map((item) => item.sourceId)).toEqual([
    ...items.filter((_, index) => [1, 3, 6].includes(index)).map((item) => item.id),
  ]);
});

test.each([
  { kind: "product_fact", limit: 8, field: "facts" },
  { kind: "reference", limit: 5, field: "references" },
  { kind: "review", limit: 4, field: "voices" },
] as const)(
  "caps whole $kind records at $limit when more are available",
  ({ kind, limit, field }) => {
    // Given
    const fixture = setup();
    fixture.library.deactivateSource(fixture.project.id, fixture.fact.id);
    const sources = Array.from({ length: limit + 1 }, (_, index) =>
      fixture.library.addSource(fixture.project.id, {
        ...sourceFact,
        kind,
        content: `record-${index}`,
      }),
    );
    // When
    const pack = evidencePack(fixture.library.snapshot(fixture.project.id));
    // Then
    expect(pack[field]).toEqual(sources.slice(0, limit));
    expect(pack.coverage.excluded.map((item) => item.sourceId)).toEqual(
      sources.slice(limit).map((item) => item.id),
    );
  },
);

test("rejects concepts that answer the same customer question with different wording", async () => {
  // Given
  const fixture = setup();
  fixture.replies.plan.hypotheses = fixture.replies.plan.hypotheses.map((item) => ({
    ...item,
    customerQuestionId: "question-0",
  }));
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "diversity" });
  expect(fixture.requests).toHaveLength(1);
});

test.each([
  ["an unknown question", { customerQuestionId: "question-missing" }, null],
  ["an inferred question with sources", null, { basis: "inferred" as const }],
  ["a customer-voice question citing facts", null, { basis: "customer_voice" as const }],
])("rejects %s", async (_name, hypothesisPatch, questionPatch) => {
  // Given
  const fixture = setup();
  if (hypothesisPatch)
    fixture.replies.plan.hypotheses = fixture.replies.plan.hypotheses.map((item, index) =>
      index === 0 ? { ...item, ...hypothesisPatch } : item,
    );
  if (questionPatch)
    fixture.replies.plan.customerQuestions = fixture.replies.plan.customerQuestions.map(
      (item, index) => (index === 0 ? { ...item, ...questionPatch } : item),
    );
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "customer_questions" });
});

test.each([
  [
    "a discount offer on a TOFU concept",
    0,
    { offer: { type: "discount" as const, statement: "50% off" } },
    null,
  ],
  ["a problem-empathy format on a MOFU concept", 1, { format: "problem_empathy" as const }, null],
  [
    "a review-proof concept without customer reviews",
    1,
    {
      format: "review_proof" as const,
      mechanism: { mode: "social_proof" as const, statement: "Reviews" },
    },
    null,
  ],
  [
    "a benefit offer without an offer source",
    2,
    {
      format: "benefit_offer" as const,
      offer: { type: "value_bundle" as const, statement: "1+1" },
    },
    "final_decision" as const,
  ],
  [
    "a set without a MOFU concept",
    1,
    { format: "problem_empathy" as const },
    "need_awareness" as const,
  ],
])("rejects %s", async (_name, index, signalsPatch, role) => {
  // Given
  const fixture = setup();
  fixture.replies.plan.hypotheses = fixture.replies.plan.hypotheses.map((item, at) =>
    at === index || (role === "need_awareness" && at === 2)
      ? {
          ...item,
          decisionRole: role ?? item.decisionRole,
          signals: { ...item.signals, ...signalsPatch },
        }
      : item,
  );
  // When
  const planned = fixture.planner.plan(fixture.job(), sourceStrategy, signal());
  // Then
  await expect(planned).rejects.toMatchObject({ code: "funnel" });
  expect(
    fixture.requests.filter((item) => item.text.format.name === "creative_plan_critique"),
  ).toHaveLength(0);
});

test("records the weekly learning-signal arithmetic when a daily budget exists", async () => {
  // Given
  const fixture = setup();
  const job = fixture.store.change(fixture.job().id, (draft) => {
    draft.dailyBudget = 30000;
    draft.currency = "KRW";
    draft.objective = "sales";
  });
  // When
  const result = await fixture.planner.plan(job, sourceStrategy, signal());
  // Then
  expect(result.value.learningSignal).toEqual({
    optimizationResult: "purchase",
    dailyBudget: 30000,
    weeklyBudget: 210000,
    currency: "KRW",
    weeklyResultsReference: 50,
    maxCostPerResultFor50: 4200,
    conceptCount: 3,
  });
  expect(result.value.customerQuestions).toHaveLength(3);
});
