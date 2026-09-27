import { join } from "node:path";
import type { CreativePlan } from "../shared/creative-plan";
import type { ModelResult } from "../shared/models";
import type { Job } from "../shared/schema";
import {
  type VideoScript,
  VideoScriptSchema,
  videoScriptIsContinuous,
} from "../shared/video-script";
import { dataDir } from "./config";
import { BlockedError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { generateTextResult } from "./text-provider";

export type VideoScriptProvider = (
  job: Job,
  hypothesis: CreativePlan["hypotheses"][number],
  number: number,
  signal: AbortSignal,
) => Promise<ModelResult<VideoScript>>;

export const generateVideoScript: VideoScriptProvider = (job, hypothesis, number, signal) => {
  if (!job.executionModels || !job.sourceSnapshot)
    throw new BlockedError("영상 대본을 작성할 프로젝트 자료와 모델이 없습니다.");
  return generateTextResult({
    name: "video_script",
    schema: VideoScriptSchema,
    directory: join(dataDir, "cli", job.id, `video-${number}`),
    signal,
    models: job.executionModels,
    maxOutputTokens: 3000,
    prompt: `Write one Korean ecommerce video ad script BEFORE any visual generation. Return JSON only. The final duration is exactly eight seconds. Make 2-5 contiguous cuts from second 0 to second 8. For each cut specify its purpose, screen composition, exact visible text, and spoken narration; use an empty string if no text or speech. The first cut must use source approved_image from the linked hypothesis imagePrompt. Include one executable English Google Flow Veo prompt for an eight-second 9:16 source clip and edit instructions for text and narration overlays. The Flow clip must have no talking people or lip sync; narration is added during editing. Do not invent product claims, appearance, testimonials, prices, or performance. Use only cited product facts. Reference ads provide structure, not proof. If reference visuals were not analyzed, do not invent them. Match number and hypothesisId exactly.\nDATA:\n${JSON.stringify({ number, hypothesis, facts: evidencePack(job.sourceSnapshot).facts.map((source) => ({ id: source.id, content: source.content })), productionClips: job.productionSourceSnapshot?.assets.map((asset) => ({ id: asset.id, title: asset.title, settings: asset.settings })) ?? [], references: job.creativePlan?.referenceAnalyses ?? [] })}`,
  });
};

export function verifyVideoScript(script: VideoScript, number: number, hypothesisId: string): void {
  if (
    script.number !== number ||
    script.hypothesisId !== hypothesisId ||
    script.cuts[0]?.source !== "approved_image" ||
    !videoScriptIsContinuous(script)
  )
    throw new BlockedError(
      "영상 대본의 번호·광고안·첫 이미지 또는 컷 시간이 기획과 맞지 않습니다.",
    );
}
