import type { VeoClip } from "./video-script";

// Veo(API 모드)와 Google Flow(웹 모드)가 같은 프롬프트를 쓰도록 한 곳에 둔다: 클립 프롬프트 + 고정 접미.
export function clipPrompt(clip: Pick<VeoClip, "prompt">): string {
  return `${clip.prompt}\nStart exactly from the supplied image. Keep the same product, person and setting. Eight seconds, 9:16, no on-screen text, no lip sync, no extra logos.`;
}
