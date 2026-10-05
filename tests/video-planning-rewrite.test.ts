import { expect, test } from "bun:test";
import { join } from "node:path";
import type { ProductionProviders } from "../server/automation-production";
import { StudioError } from "../server/errors";
import { VideoScriptService } from "../server/script-service";
import { VideoScriptSchema } from "../shared/video-script";
import { planningModel as model, planningPipelineFixture } from "./video-planning-pipeline-fixture";

test("persists a new plan and its edited copy when the user rewrites a script", async () => {
  // Given
  const f = planningPipelineFixture();
  const rewritten = {
    ...f.planning,
    concept: {
      ...f.planning.concept,
      openingScene: "출근 전 식탁에서 가방과 텀블러를 함께 살펴본다.",
    },
    copy: {
      ...f.planning.copy,
      lines: f.planning.copy.lines.map((line, index) =>
        index === 0 ? { ...line, text: "출근 준비 중 가방 옆 텀블러가 눈에 들어오셨나요?" } : line,
      ),
    },
  };
  const feedback = "식탁에서 시작하는 도입으로 다시 써 주세요";
  const providers: Pick<
    ProductionProviders,
    "videoPlanning" | "videoScript" | "reviewVideoScript"
  > = {
    videoPlanning: async (task) => {
      expect(task.userFeedback).toBe(feedback);
      return { value: rewritten, model };
    },
    videoScript: async (_job, _hypothesis, _number, _signal, _feedback, _connection, planning) => {
      expect(planning).toEqual(rewritten);
      return { value: { ...f.script, planning: f.planning }, model };
    },
    reviewVideoScript: async (task) => {
      expect(task.script.planning).toEqual(rewritten);
      return { value: { status: "pass", summary: "검토 통과", issues: [] }, model };
    },
  };
  try {
    // When
    const job = await new VideoScriptService(f.store, providers).rewrite(
      f.job.id,
      1,
      feedback,
      f.input.signal,
    );
    // Then
    expect(job.videoScripts[0]?.planning).toEqual(rewritten);
    expect(f.store.get(f.job.id).videoScripts[0]?.planning).toEqual(rewritten);
    const artifact = VideoScriptSchema.parse(
      await Bun.file(join(f.store.root, "artifacts", f.job.id, "video-script-1.json")).json(),
    );
    expect(artifact.planning).toEqual(rewritten);
  } finally {
    await f.close();
  }
});

test.each(["planning", "writing"] as const)(
  "preserves the stored plan and artifact when rewrite %s fails",
  async (failure) => {
    // Given
    const f = planningPipelineFixture();
    let writes = 0;
    const providers: Pick<
      ProductionProviders,
      "videoPlanning" | "videoScript" | "reviewVideoScript"
    > = {
      videoPlanning: async () => {
        if (failure === "planning") throw new StudioError("video_copy_review", "카피 검토 오류");
        return {
          value: { ...f.planning, concept: { ...f.planning.concept, idea: "새 영상 기획" } },
          model,
        };
      },
      videoScript: async () => {
        writes++;
        throw new StudioError("video_copy_review", "대본 작성 오류");
      },
      reviewVideoScript: async () => ({
        value: { status: "pass", summary: "검토 통과", issues: [] },
        model,
      }),
    };
    const service = new VideoScriptService(f.store, providers);
    await service.saveEdited(f.job.id, 1);
    const path = join(f.store.root, "artifacts", f.job.id, "video-script-1.json");
    const before = await Bun.file(path).text();
    try {
      // When
      const result = service.rewrite(f.job.id, 1, "도입을 바꿔 주세요", f.input.signal);
      // Then
      await expect(result).rejects.toMatchObject({ code: "video_copy_review" });
      expect(writes).toBe(failure === "planning" ? 0 : 1);
      expect(f.store.get(f.job.id).videoScripts[0]?.planning).toEqual(f.planning);
      expect(await Bun.file(path).text()).toBe(before);
    } finally {
      await f.close();
    }
  },
);
