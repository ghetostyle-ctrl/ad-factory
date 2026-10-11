import { expect, spyOn, test } from "bun:test";
import ky from "ky";
import { z } from "zod";
import { SourcePlanner } from "../server/source-planning";
import { planningFixture, sourceStrategy } from "./source-planning-fixture";

const budgetSchema = z.object({ max_output_tokens: z.number() });

test("common planning receives 100000 tokens and thirty minutes while critique keeps its smaller budget", async () => {
  // Given: use the real planner and transport with a local completed response.
  const fixture = planningFixture();
  const requests = spyOn(ky, "post");
  const deadlines = spyOn(AbortSignal, "timeout");
  try {
    // When
    const planned = await fixture.planner.plan(
      fixture.job(),
      sourceStrategy,
      new AbortController().signal,
    );
    // Then
    expect(planned.value.hypotheses).toHaveLength(3);
    expect(requests.mock.calls).toHaveLength(2);
    expect(budgetSchema.parse(requests.mock.calls[0]?.[1]?.json).max_output_tokens).toBe(100_000);
    expect(budgetSchema.parse(requests.mock.calls[1]?.[1]?.json).max_output_tokens).toBe(14_000);
    expect(requests.mock.calls.map(([, options]) => options?.retry)).toEqual([0, 0]);
    expect(deadlines.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_800_000, 600_000,
    ]);
  } finally {
    requests.mockRestore();
    deadlines.mockRestore();
    fixture.close();
  }
});

test("a ten-image ten-video job sends the larger planning limit but never accepts or retries incomplete output", async () => {
  // Given: an incomplete provider response still must stop this job.
  const fixture = planningFixture();
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      });
    },
  });
  try {
    const base = fixture.job();
    const job = {
      ...base,
      automation: {
        policy: { mode: "creative", imageCount: 10, videoCount: 10 },
        status: "attention",
        phase: "creative",
        nextRunAt: null,
        nextAnalysisAt: null,
        lastError: null,
        authorizedAt: new Date().toISOString(),
        scopeDigest: "fixture",
        imageAttempts: 0,
        operation: "creative",
        videoOperation: null,
        stoppedAt: null,
        approvedImageId: null,
        approvedImageDigest: null,
        approvedCreativeDigest: null,
        approvedPlanDigest: null,
        lastAnalysisDigest: null,
      },
    } as const;
    const planner = new SourcePlanner(fixture.store, {
      apiKey: "local-fixture-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1/`,
    });
    // When
    const planned = planner.plan(job, sourceStrategy, new AbortController().signal);
    // Then
    await expect(planned).rejects.toMatchObject({ code: "response_incomplete" });
    expect(requests).toHaveLength(1);
    expect(budgetSchema.parse(requests[0]).max_output_tokens).toBe(100_000);
    expect(fixture.store.get(job.id).creativePlan).toBeNull();
  } finally {
    server.stop(true);
    fixture.close();
  }
});
