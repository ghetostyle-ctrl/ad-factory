import type { VideoScript } from "../shared/video-script";

// 30~60초 규칙을 지키는 대본: 3초 위주 컷, 초당 5자 내레이션, 후킹으로 시작·행동 유도로 끝.
export function longVideoScript(
  number: number,
  hypothesisId: string,
  durationSec: number,
): VideoScript {
  const lengths: number[] = [];
  let left = durationSec;
  while (left > 0) {
    const length = left === 4 ? 4 : Math.min(3, left);
    lengths.push(length);
    left -= length;
  }
  const flow = ["hook", "pain", "story", "mechanism", "proof"] as const;
  let start = 0;
  const cuts = lengths.map((length, index) => {
    const purpose =
      index === lengths.length - 1 ? "cta" : (flow[Math.min(index, flow.length - 1)] ?? "proof");
    const cut = {
      startSec: start,
      endSec: start + length,
      purpose,
      screenComposition: `장면 ${index + 1}`,
      onScreenText: index === 0 ? "이런 분 주목" : "",
      narration: "가".repeat(length * 5),
      source: index === 1 ? ("veo_clip" as const) : ("approved_image" as const),
      veoPrompt: index === 1 ? "Portrait product scene, no people talking." : "",
    } satisfies VideoScript["cuts"][number];
    start += length;
    return cut;
  });
  return {
    number,
    hypothesisId,
    title: `영상 ${number} 대본`,
    durationSec,
    cuts,
    flowPrompt: `Flow shot ${number}`,
    editInstructions: "자막은 말보다 조금 먼저 띄운다.",
  } satisfies VideoScript;
}
