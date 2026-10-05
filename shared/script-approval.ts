import type { Job } from "./schema";
import { sha256Hex } from "./sha256";
import { scriptDigestJson, type VideoScript } from "./video-script";

// 영상 대본 승인 게이트(사용자 요구 2026-10-04: "영상 소재는 대본 확인을 안 하나?").
// 서버 파이프라인·엔진 깨우기·화면·CLI 가 같은 판단을 쓰도록 순수 함수만 둔다.
export type ScriptApprovalMode = "required" | "auto";

export const scriptReviewName = (number: number, attempt: number) =>
  `video-script-review-${number}-${attempt}.json`;
export const scriptArtifactName = (number: number) => `video-script-${number}.json`;

export function scriptApprovalMode(job: Pick<Job, "automation">): ScriptApprovalMode {
  const policy = job.automation?.policy;
  return policy?.mode === "creative" && policy.scriptApproval === "auto" ? "auto" : "required";
}
export function scriptDigestOf(script: VideoScript): string {
  return sha256Hex(scriptDigestJson(script));
}
export function videoScriptOf(
  job: Pick<Job, "videoScripts">,
  number: number,
): VideoScript | undefined {
  return job.videoScripts.find((item) => item.number === number) ?? job.videoScripts[number - 1];
}
// 승인 기록의 다이제스트가 현재 대본과 같을 때만 승인된 것이다(편집하면 승인이 풀린다).
export function scriptApproved(job: Job, number: number): boolean {
  const script = videoScriptOf(job, number);
  const approval = job.renders.find((item) => item.number === number)?.scriptApproval;
  return Boolean(script && approval && approval.scriptDigest === scriptDigestOf(script));
}
// 사람이 봐야 하는 대본: AI 검토가 생성 한도(3회) 뒤에도 수정을 권한 강제 수용(forced), 또는 3회 생성 뒤에도 hard 규칙을
// 통과하지 못한 초안(needsFix). '자동 진행' 정책이라도 사람이 보지 않은 채 유료 제작으로 넘기지 않는다.
export function scriptReviewUnresolved(job: Pick<Job, "renders">, number: number): boolean {
  const accepted = job.renders.find((item) => item.number === number)?.scriptReview?.accepted;
  return accepted === "forced" || accepted === "needsFix";
}
// 규칙을 통과하지 못한 초안(needsFix)인가: 승인은 hard 위반이 모두 해소된 뒤에만 받는다.
export function scriptNeedsFix(job: Pick<Job, "renders">, number: number): boolean {
  return job.renders.find((item) => item.number === number)?.scriptReview?.accepted === "needsFix";
}
// 이 영상의 대본에 사용자 승인이 필요한가: 기본(required)은 항상, 자동 진행(auto)은 forced·needsFix 대본만.
export function scriptNeedsApproval(job: Job, number: number): boolean {
  return scriptApprovalMode(job) === "required" || scriptReviewUnresolved(job, number);
}
export const scriptNeedsFixBanner = "규칙을 통과하지 못한 초안입니다 — 고치거나 다시 쓰기";
export const scriptNeedsFixMessage = "규칙을 통과하지 못한 초안은 승인할 수 없습니다";
// 내레이션이 이미 합성된 영상(타임라인 확정)은 대본을 더 바꿀 수 없으므로 승인 대상에서 뺀다(예전 작업 호환).
export function narrationSynthesized(job: Job, number: number): boolean {
  const render = job.renders.find((item) => item.number === number);
  return Boolean(render?.voice) && job.artifacts.some((a) => a.name === `timeline-${number}.json`);
}
// 아직 승인이 필요한 영상 번호(대본이 있고, 완성본·합성 내레이션이 없고, 승인이 필요한데 승인 다이제스트가 맞지 않는 것).
// 자동 진행 정책에서는 AI 검토를 통과하지 못한(forced) 대본만 여기에 든다.
export function pendingScriptApprovals(job: Job): number[] {
  const policy = job.automation?.policy;
  if (policy?.mode !== "creative") return [];
  const pending: number[] = [];
  for (let number = 1; number <= (policy.videoCount ?? 0); number++) {
    if (!videoScriptOf(job, number)) continue;
    if (job.artifacts.some((asset) => asset.name === `video-final-${number}.mp4`)) continue;
    if (narrationSynthesized(job, number)) continue;
    if (scriptNeedsApproval(job, number) && !scriptApproved(job, number)) pending.push(number);
  }
  return pending;
}
// 대본이 모두 쓰였고 승인도 끝났는지(WaitingError.ready 와 엔진 깨우기가 쓴다). 대본이 덜 쓰였으면 아직 아니다.
export function scriptApprovalReady(job: Job): boolean {
  const policy = job.automation?.policy;
  if (policy?.mode !== "creative") return true;
  if (job.videoScripts.length < (policy.videoCount ?? 0)) return false;
  return pendingScriptApprovals(job).length === 0;
}
export const scriptApprovalMessage = (count: number) =>
  `영상 대본 ${count}개를 확인하고 승인해 주세요`;
