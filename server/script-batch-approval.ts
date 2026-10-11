import type { z } from "zod";
import type { Job } from "../shared/schema";
import {
  narrationSynthesized,
  pendingScriptApprovals,
  scriptApproved,
  scriptDigestOf,
  scriptNeedsFix,
} from "../shared/script-approval";
import type {
  ScriptApprovalSummary,
  ScriptBatchRequestSchema,
} from "../shared/script-batch-approval";
import { StudioError } from "./errors";
import type { VideoScriptService } from "./script-service";

export function scriptApprovalSummary(
  job: Job,
  service: VideoScriptService,
): ScriptApprovalSummary {
  const total =
    job.automation?.policy.mode === "creative" ? (job.automation.policy.videoCount ?? 0) : 0;
  const pending = pendingScriptApprovals(job);
  return {
    total,
    busy:
      ["running", "queued"].includes(job.status) ||
      ["running", "queued"].includes(job.automation?.status ?? ""),
    items: Array.from({ length: total }, (_, index) => {
      const number = index + 1;
      const script = job.videoScripts.find((item) => item.number === number);
      if (!script) return { number, digest: null, state: "missing", problems: [] };
      const digest = scriptDigestOf(script);
      if (scriptApproved(job, number)) return { number, digest, state: "approved", problems: [] };
      if (
        narrationSynthesized(job, number) ||
        job.artifacts.some((a) => a.name === `video-final-${number}.mp4`)
      )
        return { number, digest, state: "complete", problems: [] };
      if (!pending.includes(number)) return { number, digest, state: "automatic", problems: [] };
      const problems = scriptNeedsFix(job, number) ? service.view(job.id, number).rules.hard : [];
      return { number, digest, state: problems.length ? "blocked" : "pending", problems };
    }),
  };
}

export function approveScriptBatch(
  service: VideoScriptService,
  id: string,
  request: z.infer<typeof ScriptBatchRequestSchema>,
) {
  const job = service.store.get(id);
  const summary = scriptApprovalSummary(job, service);
  if (summary.busy)
    throw new StudioError(
      "script_busy",
      "작업이 실행 중입니다. 대본 작성이 끝난 뒤 승인해 주세요.",
      409,
    );
  for (const expected of request.scripts) {
    const item = summary.items.find((item) => item.number === expected.number);
    if (!item?.digest || item.digest !== expected.digest)
      throw new StudioError(
        "script_stale",
        "대본이 변경됐습니다. 최신 대본을 확인한 뒤 다시 승인해 주세요.",
        409,
      );
  }
  const approved: number[] = [];
  for (const expected of request.scripts) {
    if (summary.items.find((item) => item.number === expected.number)?.state !== "pending")
      continue;
    service.approve(id, expected.number);
    approved.push(expected.number);
  }
  return { approved, summary: scriptApprovalSummary(service.store.get(id), service) };
}
