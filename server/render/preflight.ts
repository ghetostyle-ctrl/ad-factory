import { clipModeOf } from "../../shared/flow-mode";
import type { Job } from "../../shared/schema";
import { sha256Hex } from "../../shared/sha256";
import type { VideoScript } from "../../shared/video-script";
import { MissingConnectionError, StudioError } from "../errors";
import type { MusicLibrary } from "../music-library";
import { credentials, type RenderEncoder, renderEncoder } from "../provider-environment";
import { hasArtifact, renderNames, scriptOf } from "../render-state-helpers";
import { getSubscription, type SubscriptionProvider } from "../tts-provider";
import { verifyVideoScript } from "../video-scripts";
import { type FfmpegCapabilities, ffmpegCapabilities } from "./ffmpeg";
import { type FontSet, resolveFont } from "./fonts";

// 영상 루프마다 유료 호출 전에 환경·키·크레딧을 검사한다(산출물 캐시 없음, 0원).
// 환경 부재 → StudioError('render_unavailable', 503) → attention(환경 수정 후 수동 재개).
// 키 부재 → MissingConnectionError → blocked(/api/connections 뒤 자동 재개).
export const REQUIRED_FILTERS = [
  "ass",
  "zoompan",
  "tpad",
  "sidechaincompress",
  "loudnorm",
  "amix",
  "adelay",
  "gblur",
  "drawbox",
  "dblur",
  "rgbashift",
  "hstack",
  "alimiter",
  "ebur128",
] as const;
// 필요 글자 수의 1.5배(재합성 여유)가 남아 있어야 시작한다
export const TYPECAST_CREDIT_MARGIN = 1.5;
export type PreflightDeps = {
  readonly capabilities: (signal?: AbortSignal) => Promise<FfmpegCapabilities>;
  readonly resolveFont: () => FontSet | null;
  readonly music: MusicLibrary;
  readonly subscription: SubscriptionProvider;
  readonly credentials: () => {
    readonly openai: string;
    readonly gemini: string;
    readonly typecast: string;
  };
  readonly encoder: RenderEncoder;
};
// 내레이션이 확정(voice 기록 + 타임라인 저장)됐으면 voice 단계는 Typecast 를 부르지 않고 바로 끝난다.
export function voiceSynthesized(job: Job, number: number): boolean {
  const render = job.renders.find((item) => item.number === number);
  return Boolean(render?.voice) && hasArtifact(job, renderNames.timeline(number));
}
// 아직 Typecast 에 맡겨야 하는 글자 수. 합성 도중 저장된 첫 시도 문장(같은 문장)은 재사용되므로 뺀다.
export function remainingVoiceChars(job: Job, number: number, script: VideoScript): number {
  if (voiceSynthesized(job, number)) return 0;
  const render = job.renders.find((item) => item.number === number);
  return script.voiceover.reduce((sum, line, index) => {
    const saved = render?.voiceLines.find((item) => item.index === index && item.attempt === 1);
    const reusable =
      saved && saved.textDigest === sha256Hex(line.text) && hasArtifact(job, saved.name);
    return reusable ? sum : sum + [...line.text].length;
  }, 0);
}
export type PreflightResult = { warnings: string[]; concurrencyLimit: number };
export function defaultPreflightDeps(music: MusicLibrary): PreflightDeps {
  return {
    capabilities: ffmpegCapabilities,
    resolveFont,
    music,
    subscription: getSubscription,
    credentials: () => credentials,
    encoder: renderEncoder,
  };
}
export async function renderPreflight(
  job: Job,
  number: number,
  deps: PreflightDeps,
  signal?: AbortSignal,
): Promise<PreflightResult> {
  const warnings: string[] = [];
  const capabilities = await deps.capabilities(signal);
  const missingFilters = REQUIRED_FILTERS.filter((name) => !capabilities.filters.has(name));
  const missingEncoders = [deps.encoder, "aac"].filter((name) => !capabilities.encoders.has(name));
  if (missingFilters.length > 0 || missingEncoders.length > 0)
    throw new StudioError(
      "render_unavailable",
      `ffmpeg 에 필요한 구성 요소가 없습니다: ${[...missingFilters.map((name) => `필터 ${name}`), ...missingEncoders.map((name) => `인코더 ${name}`)].join(", ")}. ffmpeg 8.x full 빌드(libass·libx264)를 설치하세요.`,
      503,
    );
  if (!deps.resolveFont())
    throw new StudioError(
      "render_unavailable",
      "자막용 한글 폰트를 찾을 수 없습니다. 저장소 assets/fonts 의 Pretendard 또는 FONT_DIR 을 확인하세요.",
      503,
    );
  const script = scriptOf(job, number);
  verifyVideoScript(script, number, script.hypothesisId);
  const policy = job.automation?.policy;
  const bgmPolicy = policy?.mode === "creative" ? policy.bgm : undefined;
  if (bgmPolicy?.mode !== "none" && deps.music.list().length === 0)
    warnings.push("BGM 라이브러리가 비어 있어 BGM 없이 완성합니다(assets/bgm/manifest.json 참고).");
  const keys = deps.credentials();
  // 내레이션이 이미 합성된 영상은 Typecast 를 더 부르지 않으므로 키·크레딧을 요구하지 않는다.
  const needsVoice = script.voiceover.length > 0 && !voiceSynthesized(job, number);
  const neededChars = remainingVoiceChars(job, number, script);
  if (needsVoice && !keys.typecast)
    throw new MissingConnectionError(
      "내레이션 합성에는 Typecast API 키가 필요합니다. 연결 설정에서 키를 입력하면 재개할 수 있습니다.",
    );
  // 시작 이미지(Veo)와 정지 이미지(AI 사진풍 컷)는 둘 다 OpenAI 이미지 생성·비전 검토를 쓴다.
  const needsImages = script.veoClips.length > 0 || script.stills.length > 0;
  if (needsImages && !keys.openai)
    throw new MissingConnectionError(
      `${[script.veoClips.length > 0 ? "Veo 시작 이미지" : "", script.stills.length > 0 ? "정지 이미지" : ""].filter(Boolean).join("·")} 생성·검토에는 OpenAI API 키가 필요합니다. 연결 설정에서 키를 입력하면 재개할 수 있습니다.`,
    );
  // Flow 모드는 Veo API 를 부르지 않으므로(클립은 사용자가 Flow 웹에서 만들어 업로드) Gemini 키가 필요 없다.
  if (script.veoClips.length > 0 && clipModeOf(job) === "api" && !keys.gemini)
    throw new MissingConnectionError(
      "Veo 영상 제작에는 Gemini API 키가 필요합니다. 연결 설정에서 입력해 주세요.",
    );
  let concurrencyLimit = 2;
  if (needsVoice) {
    const subscription = await deps.subscription();
    concurrencyLimit = subscription.concurrencyLimit;
    const needed = Math.ceil(neededChars * TYPECAST_CREDIT_MARGIN);
    const remaining = subscription.planCredits - subscription.usedCredits;
    if (needed > remaining)
      throw new StudioError(
        "typecast_credit",
        `Typecast 잔여 크레딧(${remaining})이 영상 ${number} 내레이션에 필요한 양(${needed}, 재합성 여유 포함)보다 적습니다. 충전 후 재개하세요.`,
      );
    if (subscription.plan.toLowerCase() === "free")
      warnings.push(
        "Typecast Free 플랜은 비상업·출처 표기 조건이라 광고 소재에는 Lite 이상 플랜이 필요합니다.",
      );
  }
  return { warnings, concurrencyLimit };
}
