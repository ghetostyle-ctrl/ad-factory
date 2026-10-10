import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FlowImageRequestSchema, flowImagesOf } from "../shared/flow-images";
import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import { pendingScriptApprovals } from "../shared/script-approval";
import { contentDigest } from "./automation-guard";
import { StudioError, WaitingError } from "./errors";
import { saveFlowImageFile } from "./flow-image-files";
import { generateImageResult, type ImageOptions } from "./image-provider";
import { imageInput } from "./provider-image-input";
import type { JobStore } from "./store";

export class FlowImageProduction {
  constructor(readonly store: JobStore) {}
  private directory(jobId: string, requestId: string): string {
    this.store.get(jobId);
    return join(this.store.root, "image-inputs", jobId, requestId);
  }
  async image(input: {
    readonly job: Job;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly options?: ImageOptions;
  }): Promise<ModelResult<Uint8Array>> {
    const { job, prompt, signal, options } = input;
    signal.throwIfAborted();
    if (!job.executionModels) throw new StudioError("models", "실행 모델이 없습니다.");
    if (job.executionModels.imageProvider !== "flow")
      return generateImageResult({ prompt, signal, models: job.executionModels, ...options });
    if (job.automation?.policy.mode !== "creative")
      throw new StudioError("flow_image_mode", "Flow 이미지는 소재 자동 제작 작업에서 사용하세요.");
    if (pendingScriptApprovals(job).length)
      throw new StudioError("script_approval", "대본을 먼저 확인하고 승인하세요.");
    const target = options?.target;
    if (!target) throw new StudioError("flow_image_target", "이미지 용도가 지정되지 않았습니다.");
    const references = options?.referenceImages ?? [];
    const aspect = options?.size === "1024x1536" ? "portrait" : "square";
    const id = contentDigest(
      JSON.stringify({
        jobId: job.id,
        target,
        prompt,
        aspect,
        references: references.map(contentDigest),
      }),
    );
    let request = flowImagesOf(this.store.get(job.id)).find((item) => item.id === id);
    const directory = this.directory(job.id, id);
    if (!request) {
      await mkdir(directory, { recursive: true });
      for (const [index, bytes] of references.entries()) {
        imageInput(bytes);
        await Bun.write(join(directory, `reference-${index + 1}`), bytes);
      }
      request = FlowImageRequestSchema.parse({
        id,
        target: target.key,
        label: target.label,
        prompt,
        aspect,
        referenceCount: references.length,
        digest: null,
        createdAt: new Date().toISOString(),
      });
      const created = request;
      this.store.change(job.id, (draft) => {
        draft.flowImageRequests ??= [];
        draft.flowImageRequests.push(created);
      });
    }
    if (!request.digest)
      throw new WaitingError(
        `${request.label} · Flow에서 이미지를 만든 뒤 확인하고 업로드해 주세요.`,
        (current) => flowImagesOf(current).some((item) => item.id === id && item.digest !== null),
      );
    const bytes = new Uint8Array(await Bun.file(join(directory, "image.png")).arrayBuffer());
    if (contentDigest(bytes) !== request.digest)
      throw new StudioError(
        "flow_image_digest",
        "업로드 이미지가 변경되었습니다. 제작을 중단합니다.",
      );
    return {
      value: bytes,
      model: { provider: "flow", requestedModel: null, effectiveModel: null, quality: null },
    };
  }
  async upload(input: {
    readonly jobId: string;
    readonly requestId: string;
    readonly bytes: Uint8Array;
    readonly confirmed: boolean;
    readonly signal: AbortSignal;
  }): Promise<Job> {
    if (!input.confirmed)
      throw new StudioError("flow_image_confirmation", "이미지를 확인한 뒤 업로드해 주세요.", 400);
    const check = () => {
      const job = this.store.get(input.jobId);
      const request = flowImagesOf(job).find((item) => item.id === input.requestId);
      if (!request)
        throw new StudioError(
          "flow_image_request",
          "이 작업의 이미지 요청을 찾을 수 없습니다.",
          404,
        );
      if (
        job.executionModels?.imageProvider !== "flow" ||
        job.automation?.status !== "waiting" ||
        !["image", "stills", "startImages"].includes(job.automation.phase)
      )
        throw new StudioError(
          "flow_image_state",
          "이미지 업로드 대기 상태에서만 올릴 수 있습니다. 중지한 작업은 먼저 재개하세요.",
        );
      if (request.digest)
        throw new StudioError("flow_image_immutable", "이미 업로드한 이미지는 덮어쓸 수 없습니다.");
      if (pendingScriptApprovals(job).length)
        throw new StudioError("script_approval", "대본을 먼저 확인하고 승인하세요.");
      return request;
    };
    const request = check();
    const bytes = await saveFlowImageFile({
      directory: this.directory(input.jobId, input.requestId),
      bytes: input.bytes,
      aspect: request.aspect,
      signal: input.signal,
    });
    check();
    return this.store.change(input.jobId, (draft) => {
      const item = draft.flowImageRequests?.find((candidate) => candidate.id === input.requestId);
      if (!item) throw new StudioError("flow_image_request", "이미지 요청이 변경되었습니다.");
      item.digest = contentDigest(bytes);
      this.store.event(
        draft,
        "production",
        "info",
        `${item.label} · 사용자가 확인한 Flow 이미지 업로드 완료`,
      );
    });
  }
  async read(jobId: string, requestId: string, reference?: number): Promise<Response> {
    const request = flowImagesOf(this.store.get(jobId)).find((item) => item.id === requestId);
    if (!request)
      throw new StudioError("flow_image_request", "이미지 요청을 찾을 수 없습니다.", 404);
    if (
      reference !== undefined &&
      (!Number.isInteger(reference) || reference < 1 || reference > request.referenceCount)
    )
      throw new StudioError("flow_image_reference", "참조 이미지를 찾을 수 없습니다.", 404);
    if (reference === undefined && !request.digest)
      throw new StudioError("flow_image_pending", "아직 이미지가 업로드되지 않았습니다.", 404);
    const path = join(
      this.directory(jobId, requestId),
      reference === undefined ? "image.png" : `reference-${reference}`,
    );
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const { mimeType, extension } = imageInput(bytes);
    return new Response(bytes, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${reference === undefined ? "image" : `reference-${reference}`}.${extension}"`,
      },
    });
  }
}
