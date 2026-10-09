import type { FlowTexts } from "../shared/flow-texts";
import type { Job } from "../shared/schema";
import type { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { BlockedError } from "./errors";
import { flowTexts } from "./flow-instructions";

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

// 참조 이미지 설명 문장(instructions/flow.md SCENE_IMAGE_REFERENCE_1/2/NONE). 참조 2 문장과 '없음' 문장 앞의 공백 한 칸은 코드가 붙인다.
export function sceneImagePrompt(
  prompt: string,
  referenceCount: number,
  texts: Pick<
    FlowTexts,
    "SCENE_IMAGE_REFERENCE_1" | "SCENE_IMAGE_REFERENCE_2" | "SCENE_IMAGE_REFERENCE_NONE"
  > = flowTexts(),
): string {
  if (referenceCount === 0) return prompt;
  const second =
    referenceCount > 1 ? texts.SCENE_IMAGE_REFERENCE_2 : texts.SCENE_IMAGE_REFERENCE_NONE;
  return `${prompt}\n${texts.SCENE_IMAGE_REFERENCE_1} ${second}`;
}
