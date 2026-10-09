import type { ProductionAsset } from "../shared/production-assets";
import { emptyRenderState, type RenderState } from "../shared/render-state";
import type { Job } from "../shared/schema";
import { sha256Hex } from "../shared/sha256";
import { scriptDigestJson, type VideoScript } from "../shared/video-script";
import type { Artifacts } from "./artifacts";
import { BlockedError } from "./errors";

// 렌더 단계들이 공용으로 쓰는 작은 도우미. 상태는 job.renders[] 에만 두고 산출물 이름 규칙은 여기서 통일한다.
export const renderNames = {
  voice: (n: number, index: number, attempt: number) =>
    `voice-${n}-${String(index + 1).padStart(2, "0")}-${attempt}.wav`,
  voiceManifest: (n: number) => `voice-${n}.json`,
  timeline: (n: number) => `timeline-${n}.json`,
  startImage: (n: number, clipId: string, attempt: number) => `start-${n}-${clipId}-${attempt}.png`,
  startReview: (n: number, clipId: string, attempt: number) =>
    `start-review-${n}-${clipId}-${attempt}.json`,
  still: (n: number, stillId: string, attempt: number) => `still-${n}-${stillId}-${attempt}.png`,
  stillReview: (n: number, stillId: string, attempt: number) =>
    `still-review-${n}-${stillId}-${attempt}.json`,
  clip: (n: number, clipId: string, attempt: number) => `clip-${n}-${clipId}-${attempt}.mp4`,
  infoImage: (n: number, clipId: string, which: "clean" | "info", attempt: number) =>
    `info-${n}-${clipId}-${which}-${attempt}.png`,
  clipReview: (n: number, clipId: string, attempt: number) =>
    `clip-review-${n}-${clipId}-${attempt}.json`,
  final: (n: number) => `video-final-${n}.mp4`,
  captions: (n: number) => `captions-${n}.ass`,
  report: (n: number) => `render-report-${n}.json`,
} as const;

export function scriptDigest(script: VideoScript): string {
  return sha256Hex(scriptDigestJson(script));
}
// draft.renders 에서 영상 n 의 상태를 찾거나 만든다(store.change 안에서 호출).
export function renderStateOf(draft: Job, number: number, scriptDigestValue?: string): RenderState {
  let state = draft.renders.find((item) => item.number === number);
  if (!state) {
    state = emptyRenderState(number, scriptDigestValue ?? null);
    draft.renders.push(state);
    draft.renders.sort((left, right) => left.number - right.number);
  }
  return state;
}
export function scriptOf(job: Job, number: number): VideoScript {
  const script =
    job.videoScripts.find((item) => item.number === number) ?? job.videoScripts[number - 1];
  if (!script) throw new BlockedError(`영상 ${number} 의 대본이 없어 제작을 시작할 수 없습니다.`);
  return script;
}
export function hasArtifact(job: Job, name: string): boolean {
  return job.artifacts.some((asset) => asset.name === name);
}
// 가설(광고안)의 승인 대표 이미지·카드뉴스 이미지 이름. 강제 통과(digest 없음)도 파일이 있으면 쓴다.
export function approvedSources(
  job: Job,
  hypothesisId: string,
): {
  approvedImage: { name: string; digest: string | null } | null;
  cards: string[];
  projectAssets: ProductionAsset[];
  decisionRole: string | undefined;
} {
  const variant = job.creativeVariants.find((item) => item.id === hypothesisId);
  const imageId = variant?.approvedImageId ?? job.automation?.approvedImageId ?? null;
  const image = job.artifacts.find((asset) => asset.id === imageId && asset.kind === "image");
  const cards = (variant?.cardImageIds ?? [])
    .map((id) => job.artifacts.find((asset) => asset.id === id && asset.kind === "image")?.name)
    .filter((name): name is string => Boolean(name));
  return {
    approvedImage: image
      ? { name: image.name, digest: variant?.approvedImageDigest ?? null }
      : null,
    cards,
    projectAssets: job.productionSourceSnapshot?.assets ?? [],
    decisionRole: job.creativePlan?.hypotheses.find((item) => item.id === hypothesisId)
      ?.decisionRole,
  };
}
// 같은 이름 산출물을 두 번 등록하지 않는다(Artifacts.save 는 이름 중복을 걸러내지 않고 항상 push 한다).
// 이미 등록돼 있으면 파일 내용만 덮어써서 재개 후 목록에 중복 항목이 쌓이는 것을 막는다.
export async function saveArtifactOnce(
  assets: Artifacts,
  jobId: string,
  asset: Parameters<Artifacts["save"]>[1],
): Promise<void> {
  if (hasArtifact(assets.store.get(jobId), asset.name)) {
    await Bun.write(assets.path(jobId, asset.name), asset.content);
    return;
  }
  await assets.save(jobId, asset);
}
