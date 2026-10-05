import type { Job } from "../shared/schema";
import type { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { BlockedError } from "./errors";

export async function sceneImageReferences(
  assets: Artifacts,
  input: { readonly job: Job; readonly number: number; readonly approved: Uint8Array },
): Promise<readonly Uint8Array[]> {
  const render = input.job.renders.find((item) => item.number === input.number);
  const passed = [
    ...Object.values(render?.stills ?? {}),
    ...Object.values(render?.startImages ?? {}),
  ].filter((state) => state.status === "pass" && state.name && state.digest);
  // Artifact order keeps the first confirmed photographic scene stable across stages and resumes.
  const first = input.job.artifacts.find((asset) =>
    passed.some((state) => state.name === asset.name),
  );
  const anchor = passed.find((state) => state.name === first?.name);
  if (!anchor) return [input.approved];
  const bytes = new Uint8Array(await (await assets.read(input.job.id, anchor.name)).arrayBuffer());
  if (contentDigest(bytes) !== anchor.digest)
    throw new BlockedError("장면 연속성 기준 이미지 파일이 변경되었습니다. 제작을 중단합니다.");
  return [input.approved, bytes];
}

export function sceneImagePrompt(prompt: string, referenceCount: number): string {
  if (referenceCount === 0) return prompt;
  return `${prompt}\nUse reference image 1 for visible product identity, shape, materials and packaging details. Preserve existing product markings; do not invent branding. Do not copy its promotional text, captions, infographic blocks or card layout. Produce the requested photographic scene, not another advertisement card.${referenceCount > 1 ? " Reference image 2 is the established photographic scene: preserve its person, clothing, setting, lighting and product appearance while changing only the action and framing requested for this shot." : " Establish a consistent photographic person, setting and lighting from the supplied style direction."}`;
}
