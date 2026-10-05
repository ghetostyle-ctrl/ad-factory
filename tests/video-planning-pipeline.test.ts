import { expect, test } from "bun:test";
import type { ProductionProviders } from "../server/automation-production";
import { StudioError } from "../server/errors";
import { TEST_PROVIDER_BLOCKED } from "../server/render-pipeline";
import { writeVideoScript } from "../server/script-writer";
import { videoHypotheses } from "../server/source-production";
import type { VideoPlanning } from "../shared/video-planning";
import { planningModel as model, planningPipelineFixture } from "./video-planning-pipeline-fixture";

test.each([
  { accepted: "pass", generations: 1 },
  { accepted: "forced", generations: 3 },
  { accepted: "needsFix", generations: 3 },
] as const)(
  "keeps one plan through $accepted script generation",
  async ({ accepted, generations }) => {
    // Given
    const f = planningPipelineFixture();
    let plans = 0;
    const stages: string[] = [];
    const writerPlans: (VideoPlanning | undefined)[] = [];
    const reviewedPlans: (VideoPlanning | undefined)[] = [];
    const providers: Pick<
      ProductionProviders,
      "videoPlanning" | "videoScript" | "reviewVideoScript"
    > = {
      videoPlanning: async (task) => {
        plans++;
        task.onProgress?.("planning");
        task.onProgress?.("copy");
        expect(task).toMatchObject({
          number: 1,
          durationSec: f.script.durationSec,
          hypothesis: f.hypothesis,
          userFeedback: "도입을 바꿔 주세요",
        });
        return { value: f.planning, model };
      },
      videoScript: async (
        _job,
        _hypothesis,
        _number,
        _signal,
        _feedback,
        _connection,
        planning,
      ) => {
        writerPlans.push(planning);
        return {
          value:
            accepted === "needsFix"
              ? {
                  ...f.script,
                  voiceover: f.script.voiceover.map((voice) => ({
                    ...voice,
                    text: "Invalid English",
                  })),
                }
              : f.script,
          model,
        };
      },
      reviewVideoScript: async (task) => {
        reviewedPlans.push(task.script.planning);
        return {
          value: {
            status: accepted === "forced" ? "revise" : "pass",
            summary: "검토 결과",
            issues: [],
          },
          model,
        };
      },
    };
    try {
      // When
      const result = await writeVideoScript({
        ...f.input,
        providers,
        userFeedback: "도입을 바꿔 주세요",
        progress: (_attempt, stage) => stages.push(stage),
      });
      // Then
      expect(plans).toBe(1);
      expect(stages.slice(0, 3)).toEqual(["planning", "copy", "write"]);
      expect(writerPlans).toEqual(Array.from({ length: generations }, () => f.planning));
      expect(reviewedPlans).toEqual(
        Array.from({ length: accepted === "needsFix" ? 0 : generations }, () => f.planning),
      );
      expect(result.review.accepted).toBe(accepted);
      expect(result.script.planning).toEqual(f.planning);
    } finally {
      await f.close();
    }
  },
);

test("preserves the chosen hypothesis order for video planning", async () => {
  // Given
  const f = planningPipelineFixture();
  const creativePlan = f.job.creativePlan;
  if (!creativePlan) throw new TypeError("Planning fixture missing");
  const hypotheses = [...creativePlan.hypotheses].reverse();
  try {
    // When
    const ordered = videoHypotheses({ ...creativePlan, hypotheses });
    // Then
    expect(ordered.map((hypothesis) => hypothesis.id)).toEqual(
      hypotheses.map((hypothesis) => hypothesis.id),
    );
  } finally {
    await f.close();
  }
});

test("skips live planning when a custom script writer has no planner", async () => {
  // Given
  const f = planningPipelineFixture();
  const writerPlans: (VideoPlanning | undefined)[] = [];
  const providers: Pick<ProductionProviders, "videoScript" | "reviewVideoScript"> = {
    videoScript: async (_job, _hypothesis, _number, _signal, _feedback, _connection, planning) => {
      writerPlans.push(planning);
      return { value: f.script, model };
    },
    reviewVideoScript: async () => ({
      value: { status: "pass", summary: "검토 통과", issues: [] },
      model,
    }),
  };
  try {
    // When
    const result = await writeVideoScript({ ...f.input, providers });
    // Then
    expect(writerPlans).toEqual([undefined]);
    expect(result.script.planning).toBeUndefined();
    expect(result.review.accepted).toBe("pass");
  } finally {
    await f.close();
  }
});

test("does not write a script when the injected planner fails", async () => {
  // Given
  const f = planningPipelineFixture();
  let writes = 0;
  const providers: Pick<
    ProductionProviders,
    "videoPlanning" | "videoScript" | "reviewVideoScript"
  > = {
    videoPlanning: async () => {
      throw new StudioError("video_copy_review", "카피 검토 오류");
    },
    videoScript: async () => {
      writes++;
      return { value: f.script, model };
    },
    reviewVideoScript: async () => ({
      value: { status: "pass", summary: "검토 통과", issues: [] },
      model,
    }),
  };
  try {
    // When
    const result = writeVideoScript({ ...f.input, providers });
    // Then
    await expect(result).rejects.toMatchObject({ code: "video_copy_review" });
    expect(writes).toBe(0);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "blocks live writer fallback with injected planning=%s",
  async (injected) => {
    // Given
    const f = planningPipelineFixture();
    let plans = 0;
    const providers: Pick<
      ProductionProviders,
      "videoPlanning" | "videoScript" | "reviewVideoScript"
    > = injected
      ? {
          videoPlanning: async () => {
            plans++;
            return { value: f.planning, model };
          },
          reviewVideoScript: async () => ({
            value: { status: "pass", summary: "검토 통과", issues: [] },
            model,
          }),
        }
      : {};
    try {
      // When
      const result = writeVideoScript({ ...f.input, providers });
      // Then
      await expect(result).rejects.toMatchObject({ code: TEST_PROVIDER_BLOCKED });
      expect(plans).toBe(0);
    } finally {
      await f.close();
    }
  },
);
