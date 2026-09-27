import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError } from "./errors";
import type { JobStore } from "./store";
import { generateVideoResult, type VideoTask } from "./video-provider";

export type VideoProvider = (task: VideoTask) => Promise<ModelResult<Uint8Array>>;

export class VideoProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  constructor(
    readonly store: JobStore,
    readonly generate: VideoProvider = generateVideoResult,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
  }
  async run(id: string, signal: AbortSignal): Promise<void> {
    const policy = this.store.get(id).automation?.policy;
    if (policy?.mode !== "creative" || !policy.videoCount) return;
    for (let index = 0; index < policy.videoCount; index++) {
      const name = `video-auto-${index + 1}.mp4`;
      const job = this.guard.check(id, signal);
      if (job.artifacts.some((asset) => asset.name === name && asset.kind === "video")) {
        if (job.automation?.videoOperation?.index === index + 1)
          this.store.change(id, (draft) => {
            if (draft.automation) draft.automation.videoOperation = null;
          });
        continue;
      }
      if (job.automation?.videoOperation && job.automation.videoOperation.index !== index + 1)
        throw new BlockedError("기록된 Veo 작업 순서가 현재 영상과 일치하지 않습니다.");
      const script = job.videoScripts[index];
      if (!script)
        throw new BlockedError("영상 대본과 컷 설계가 없어 Veo 제작을 시작할 수 없습니다.");
      const source = this.sourceImage(job, script.hypothesisId);
      const image = new Uint8Array(await (await this.assets.read(id, source.name)).arrayBuffer());
      if (contentDigest(image) !== source.digest)
        throw new BlockedError(
          "검토를 통과한 이미지 파일이 변경되었습니다. 영상 제작을 중단합니다.",
        );
      await this.guard.operation(id, {
        phase: "video",
        signal,
        run: async () => {
          this.store.agent(id, "production", {
            status: "running",
            action: `Veo 영상 ${index + 1}/${policy.videoCount} 생성 중 · 8초 세로 클립`,
          });
          const result = await this.generate({
            image,
            model: policy.videoModel ?? "veo-3.1-lite-generate-preview",
            prompt: `${script.flowPrompt}\nPreserve the supplied approved product image. Eight seconds, 9:16. No talking people, no lip sync, no invented product claims, no extra logos or packaging. Text and narration from the approved cut script are added during editing.`,
            ...(job.automation?.videoOperation
              ? {
                  operationName: job.automation.videoOperation.name,
                  startedAt: job.automation.videoOperation.startedAt,
                }
              : {}),
            onOperationName: (operationName) => {
              this.store.change(id, (draft) => {
                if (draft.automation)
                  draft.automation.videoOperation = {
                    index: index + 1,
                    name: operationName,
                    startedAt: new Date().toISOString(),
                  };
              });
            },
            signal,
          });
          signal.throwIfAborted();
          await this.assets.save(id, {
            name,
            kind: "video",
            agentId: "production",
            content: result.value,
            model: result.model,
          });
          this.store.change(id, (draft) => {
            if (draft.automation) draft.automation.videoOperation = null;
          });
          this.store.agent(id, "production", {
            status: "completed",
            action: `Veo 영상 ${index + 1}/${policy.videoCount} 저장 완료`,
          });
        },
      });
    }
  }
  private sourceImage(job: Job, hypothesisId: string) {
    const variant = job.creativeVariants.find(
      (item) => item.id === hypothesisId && item.reviewStatus === "pass",
    );
    const creative = variant?.creative;
    const imageId = variant?.approvedImageId ?? job.automation?.approvedImageId;
    const source = job.artifacts.find((asset) => asset.id === imageId && asset.kind === "image");
    const digest = variant?.approvedImageDigest;
    if (!source || !creative || !digest)
      throw new BlockedError("영상용으로 검토를 통과한 이미지 소재가 없습니다.");
    return { name: source.name, creative, digest };
  }
}
