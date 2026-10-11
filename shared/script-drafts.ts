import type { Job } from "./schema";

export const SCRIPT_DRAFT_WAIT_PREFIX = "대본 초안 수정 대기";
export function pendingScriptDraft(job: Job) {
  if (
    job.automation?.status !== "waiting" ||
    job.automation.phase !== "script" ||
    !job.result?.startsWith(SCRIPT_DRAFT_WAIT_PREFIX)
  )
    return null;
  const issue = job.artifacts.findLast((a) =>
    /^video-script-issues-[1-9][0-9]*-[1-9][0-9]*[.]json$/.test(a.name),
  );
  if (!issue) return null;
  const match = /^video-script-issues-([0-9]+)-([0-9]+)[.]json$/.exec(issue.name);
  if (!match) return null;
  const number = Number(match[1]),
    attempt = Number(match[2]);
  return {
    number,
    issue,
    response:
      job.artifacts.find(
        (a) => a.name === "video-script-response-" + number + "-" + attempt + ".json",
      ) ?? null,
    previous:
      job.artifacts.findLast((a) => a.name.startsWith("video-script-draft-" + number + "-")) ??
      null,
  };
}
