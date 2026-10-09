import type { FlowTexts } from "../shared/flow-texts";
import type { Job } from "../shared/schema";
import { flowTexts } from "./flow-instructions";

// immersive(입체 설명) 대본이 있는 광고안의 대표 이미지·카드 프롬프트에 영상 시각 체계를 더한다.
// 문장(IMMERSIVE_PALETTE·SOURCE_IMAGE_IMMERSIVE_NOTE)은 instructions/flow.md 의 절이다. texts 를 생략하면 지금 파일을 읽는다.
export function sourceImagePrompt(
  job: Pick<Job, "videoScripts">,
  variantId: string,
  prompt: string,
  texts: Pick<FlowTexts, "IMMERSIVE_PALETTE" | "SOURCE_IMAGE_IMMERSIVE_NOTE"> = flowTexts(),
): string {
  const script = job.videoScripts.find(
    (item) =>
      item.hypothesisId === variantId &&
      item.planning?.visualPolicy === "immersive_explanations_v1",
  );
  if (!script) return prompt;
  return [prompt, texts.IMMERSIVE_PALETTE, texts.SOURCE_IMAGE_IMMERSIVE_NOTE].join("\n");
}
