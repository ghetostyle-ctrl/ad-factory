import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flowExportMarkdown,
  flowExportName,
  flowReady,
  pendingFlowClips,
} from "../shared/flow-mode";
import type { ModelResult } from "../shared/models";
import { type ImageReview, ImageReviewSchema } from "../shared/planning";
import type { ClipId, ClipState } from "../shared/render-state";
import type { Job } from "../shared/schema";
import { type VeoClip, type VideoScript, videoPolicyOf } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError, StudioError, WaitingError } from "./errors";
import { clipPromptFor, flowExportFor } from "./flow-instructions";
import { type ClipFrameReviewTask, Intelligence } from "./intelligence";
import { extractFrames } from "./render/ffmpeg";
import {
  hasArtifact,
  renderNames,
  renderStateOf,
  saveArtifactOnce,
  scriptOf,
} from "./render-state-helpers";
import type { JobStore } from "./store";
import {
  awaitVideoOperation,
  createVideoOperation,
  type VideoAwaitTask,
  type VideoCreateTask,
  type VideoModel,
} from "./video-provider";

// phase 'clips': Veo image-to-video 를 2패스로 돈다. create 패스(요청 직전 pendingSince → POST → 핸들 저장),
// await 패스(핸들 있는 클립만 폴링·다운로드·검증·저장). 가장 비싼 단계라 voice·startImages 뒤에 온다.
export type VideoCreate = (task: VideoCreateTask) => Promise<{ name: string; startedAt: string }>;
export type VideoAwait = (task: VideoAwaitTask) => Promise<ModelResult<Uint8Array>>;
export type VideoProvider = { readonly create: VideoCreate; readonly await: VideoAwait };
export type ClipFrameReviewer = (task: ClipFrameReviewTask) => Promise<ModelResult<ImageReview>>;
export type FrameExtractor = (
  video: string,
  seconds: readonly number[],
  outDir: string,
  signal: AbortSignal,
) => Promise<Uint8Array[]>;
// Veo URI 보존 기간(2일)을 넘긴 핸들은 폐기·재생성한다.
export const VEO_HANDLE_TTL_MS = 48 * 60 * 60 * 1000;
// attempts 는 "과금이 확실한 생성"만 센다(한도 2회).
//  - create 가 핸들을 돌려준 때에만 +1 한다. HTTP 오류·키 부재처럼 요청이 거절된 경우는 세지 않고 pendingSince 도 해제한다.
//    중단(abort)·타임아웃·응답 해석 실패는 과금 여부를 알 수 없어 pendingSince 를 남겨 사용자가 확인한 뒤에만 재생성한다(시도로는 세지 않음).
//  - await 가 Veo 측 오류(veo_failed: 안전 필터 등, 영상 없음)로 끝나면 영상이 만들어지지 않은 것으로 보고 +1 을 되돌린다(공급자 청구 기준은 미검증).
//  - 영상은 받았지만 규격 검증에 실패(veo_format/veo_size/veo_url)하면 과금된 시도로 세어 둔다.
//  - 48시간이 지나 폐기한 핸들은 영상을 받지 못했으므로 +1 을 되돌린다.
// 어느 경우든 핸들은 즉시 지워 같은 실패를 재폴링하며 영구 정체하지 않게 한다.
export const CLIP_MAX_ATTEMPTS = 2;
const DETERMINISTIC_VEO_FAILURES = ["veo_failed", "veo_format", "veo_size", "veo_url"] as const;
export const CLIP_REVIEW_SECONDS = [0.5, 4, 7.5] as const;
export const DEFAULT_VIDEO_MODEL: VideoModel = "veo-3.1-generate-preview";
// Veo 프롬프트 문장은 instructions/flow.md(server/flow-instructions.ts clipPromptFor)에서 온다.
export { clipPromptFor as clipPrompt };

const defaultClipState = (): ClipState => ({
  name: null,
  digest: null,
  attempts: 0,
  pendingSince: null,
  operation: null,
});

export class ClipProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  readonly reviewFrames: ClipFrameReviewer | null;
  constructor(
    readonly store: JobStore,
    readonly veo: VideoProvider = { create: createVideoOperation, await: awaitVideoOperation },
    reviewFrames?: ClipFrameReviewer | null,
    readonly extract: FrameExtractor = extractFrames,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
    if (reviewFrames === undefined) {
      const intelligence = new Intelligence(store.root);
      this.reviewFrames = intelligence.reviewClipFrames.bind(intelligence);
    } else this.reviewFrames = reviewFrames;
  }
  async run(id: string, number: number, signal: AbortSignal): Promise<void> {
    const job = this.guard.check(id, signal);
    const script = scriptOf(job, number);
    if (script.veoClips.length === 0 && script.infoClips.length === 0) return;
    const policy = job.automation?.policy;
    if (policy?.mode !== "creative") throw new BlockedError("소재 제작 정책이 아닙니다.");
    // Flow 모드: 이 클래스는 Veo API 를 절대 부르지 않는다(공급자 객체도 쓰지 않는다).
    if (policy.clipMode === "flow") return this.runFlow(id, number, script, signal);
    const settings = {
      model: policy.videoModel ?? DEFAULT_VIDEO_MODEL,
      resolution: policy.videoResolution ?? "1080p",
      review: policy.clipReview ?? true,
    } as const;
    const startImages = await this.verifyStartImages(id, number, script);
    // 응답 수신과 핸들 저장 사이에 끊긴 클립은 '불확실': 사용자가 확인(재개)하기 전에는 재요청하지 않는다.
    const uncertain = script.veoClips.filter((clip) => {
      const state = this.clipState(id, number, clip.id);
      return state.pendingSince && !state.operation && !state.name;
    });
    if (uncertain.length > 0)
      throw new StudioError(
        "clip_uncertain",
        `클립 ${uncertain.map((clip) => clip.id).join(", ")} 의 Veo 요청 결과가 불확실합니다(중복 과금 가능성). 공급자 사용량을 확인한 뒤 재개하면 다시 생성합니다.`,
      );
    for (let round = 0; round < CLIP_MAX_ATTEMPTS + 1; round++) {
      if (script.veoClips.every((clip) => this.clipState(id, number, clip.id).name)) break;
      await this.createPass({ id, number, script, startImages, settings, signal });
      const regenerate = await this.awaitPass({
        id,
        number,
        script,
        startImages,
        settings,
        signal,
      });
      if (!regenerate) break;
    }
    const missing = script.veoClips.filter((clip) => !this.clipState(id, number, clip.id).name);
    if (missing.length > 0)
      throw new StudioError(
        "clip_incomplete",
        `클립 ${missing.map((clip) => clip.id).join(", ")} 을 완성하지 못했습니다.`,
      );
    this.store.agent(id, "production", {
      status: "completed",
      action: `영상 ${number} Veo 클립 ${script.veoClips.length}개 저장 완료`,
    });
  }
  // Flow 모드: 시작 이미지·프롬프트를 내보내고(flow-export-<n>.json/.md) 사용자가 Flow 웹에서 만든 클립이
  // 업로드(server/flow-import.ts)될 때까지 기다린다. 클립이 모두 들어와 있으면 곧바로 끝낸다.
  private async runFlow(
    id: string,
    number: number,
    script: VideoScript,
    signal: AbortSignal,
  ): Promise<void> {
    const missing = pendingFlowClips(this.store.get(id), number);
    if (missing.length === 0) {
      this.store.agent(id, "production", {
        status: "completed",
        action: `영상 ${number} Flow 클립 ${script.veoClips.length + script.infoClips.length}개 업로드 확인`,
      });
      return;
    }
    await this.verifyStartImages(id, number, script);
    signal.throwIfAborted();
    this.store.change(id, (draft) => {
      if (draft.automation) draft.automation.phase = "clips";
    });
    // 프롬프트·체크리스트 문장은 지시 파일(flow.md)에서 지금 읽은 글로 조립한다(재시작 없이 반영).
    const data = flowExportFor(this.store.get(id), number);
    await saveArtifactOnce(this.assets, id, {
      name: flowExportName(number, "json"),
      kind: "json",
      agentId: "production",
      content: JSON.stringify(data, null, 2),
    });
    await saveArtifactOnce(this.assets, id, {
      name: flowExportName(number, "md"),
      kind: "text",
      agentId: "production",
      content: flowExportMarkdown(data),
    });
    const message = `클립 ${missing.length}개를 Flow에서 만들어 업로드해 주세요`;
    this.store.agent(id, "production", {
      status: "review",
      action: `영상 ${number} ${message} (${flowExportName(number, "md")} 참고)`,
    });
    throw new WaitingError(message, flowReady);
  }
  // 시작 이미지 파일을 다시 읽어 digest 를 재대조한다(operation 밖: 변조는 사용자 개입이 필요한 blocked).
  private async verifyStartImages(
    id: string,
    number: number,
    script: VideoScript,
  ): Promise<Map<ClipId, Uint8Array>> {
    const job = this.store.get(id);
    const render = job.renders.find((item) => item.number === number);
    const images = new Map<ClipId, Uint8Array>();
    for (const clip of script.veoClips) {
      const state = render?.startImages[clip.id];
      if (!state?.name || !hasArtifact(job, state.name))
        throw new BlockedError(
          `클립 ${clip.id} 의 시작 이미지가 없어 Veo 요청을 보낼 수 없습니다.`,
        );
      const bytes = new Uint8Array(await (await this.assets.read(id, state.name)).arrayBuffer());
      if (contentDigest(bytes) !== state.digest)
        throw new BlockedError(
          `클립 ${clip.id} 의 시작 이미지가 변경되었습니다. 영상 제작을 중단합니다.`,
        );
      images.set(clip.id, bytes);
    }
    return images;
  }
  private clipState(id: string, number: number, clipId: ClipId): ClipState {
    return (
      this.store.get(id).renders.find((item) => item.number === number)?.clips[clipId] ??
      defaultClipState()
    );
  }
  private patch(id: string, number: number, clipId: ClipId, patch: Partial<ClipState>): void {
    this.store.change(id, (draft) => {
      const render = renderStateOf(draft, number);
      render.clips[clipId] = { ...(render.clips[clipId] ?? defaultClipState()), ...patch };
    });
  }
  private async createPass(input: {
    readonly id: string;
    readonly number: number;
    readonly script: VideoScript;
    readonly startImages: Map<ClipId, Uint8Array>;
    readonly settings: { model: VideoModel; resolution: "720p" | "1080p"; review: boolean };
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { id, number, script, signal } = input;
    const todo = script.veoClips.filter((clip) => {
      const state = this.clipState(id, number, clip.id);
      if (state.name) return false;
      if (
        state.operation &&
        Date.now() - Date.parse(state.operation.startedAt) > VEO_HANDLE_TTL_MS
      ) {
        // 이미 내려받아 저장한 파일이 있으면 핸들이 만료됐어도 그 파일로 이어간다(awaitPass 가 재사용).
        if (hasArtifact(this.store.get(id), renderNames.clip(number, clip.id, state.attempts)))
          return false;
        // 48시간이 지난 핸들은 다운로드 주소가 만료됐을 가능성이 커 폐기한다. 영상을 받지 못했으니 시도로 세지 않는다.
        this.patch(id, number, clip.id, {
          operation: null,
          pendingSince: null,
          attempts: Math.max(0, state.attempts - 1),
        });
        return true;
      }
      return !state.operation;
    });
    if (todo.length === 0) return;
    await this.guard.operation(id, {
      phase: "clips",
      signal,
      run: async () => {
        for (const clip of todo) {
          const image = input.startImages.get(clip.id);
          if (!image) throw new BlockedError(`클립 ${clip.id} 시작 이미지가 없습니다.`);
          const state = this.clipState(id, number, clip.id);
          if (state.attempts >= CLIP_MAX_ATTEMPTS)
            throw new StudioError(
              "clip_attempts",
              `클립 ${clip.id} 생성 한도(2회)에 도달했습니다.`,
            );
          this.store.agent(id, "production", {
            status: "running",
            action: `영상 ${number} 클립 ${clip.id} Veo 생성 요청 중 (${state.attempts + 1}/${CLIP_MAX_ATTEMPTS})`,
          });
          this.patch(id, number, clip.id, { pendingSince: new Date().toISOString() });
          try {
            const created = await this.veo.create({
              image,
              // 혼합형 실사 클립은 Flow 번들과 같은 실사 꼬리를 붙인다(H3; API 모드도 같은 프롬프트).
              prompt: clipPromptFor(clip, { liveAction: videoPolicyOf(script) === "hybrid" }),
              model: input.settings.model,
              resolution: input.settings.resolution,
              signal,
            });
            this.patch(id, number, clip.id, {
              attempts: state.attempts + 1,
              pendingSince: null,
              operation: {
                name: created.name,
                startedAt: created.startedAt,
                model: input.settings.model,
              },
            });
          } catch (error) {
            // 키 부재·입력 오류·HTTP 오류 응답(StudioError)은 요청이 나가지 않았거나 공급자가 거절한 것이라 과금이 없다.
            // 그 밖의 오류(중단·타임아웃·네트워크·응답 해석 실패)는 pendingSince 를 남겨 사용자 확인을 거치게 한다.
            if (error instanceof StudioError)
              this.patch(id, number, clip.id, { pendingSince: null });
            throw error;
          }
        }
      },
    });
  }
  // 핸들 있는 클립을 폴링·저장. 검토 불합격(시도 여유 있음)이면 true 를 돌려 create 패스로 되돌아간다.
  private async awaitPass(input: {
    readonly id: string;
    readonly number: number;
    readonly script: VideoScript;
    readonly startImages: Map<ClipId, Uint8Array>;
    readonly settings: { model: VideoModel; resolution: "720p" | "1080p"; review: boolean };
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    const { id, number, script, signal } = input;
    const todo = script.veoClips.filter((clip) => {
      const state = this.clipState(id, number, clip.id);
      return !state.name && state.operation;
    });
    if (todo.length === 0) return false;
    let regenerate = false;
    // 결정적 실패(안전 필터·규격 불일치)는 그 클립의 핸들만 폐기하고 나머지 클립은 계속 받는다. 마지막에 첫 오류를 던진다.
    let failure: StudioError | null = null;
    await this.guard.operation(id, {
      phase: "clips",
      signal,
      run: async () => {
        for (const clip of todo) {
          const state = this.clipState(id, number, clip.id);
          const operation = state.operation;
          if (!operation) continue;
          this.store.agent(id, "production", {
            status: "running",
            action: `영상 ${number} 클립 ${clip.id} Veo 생성 대기 중 (${state.attempts}/${CLIP_MAX_ATTEMPTS})`,
          });
          const name = renderNames.clip(number, clip.id, state.attempts);
          // 저장까지 끝났는데 검토 도중 끊긴 클립은 다시 폴링·다운로드하지 않는다.
          let bytes = hasArtifact(this.store.get(id), name)
            ? await this.readSavedClip(id, name)
            : null;
          if (!bytes) {
            let result: ModelResult<Uint8Array>;
            try {
              result = await this.veo.await({
                operationName: operation.name,
                startedAt: operation.startedAt,
                model: input.settings.model,
                signal,
              });
            } catch (error) {
              if (
                error instanceof StudioError &&
                DETERMINISTIC_VEO_FAILURES.some((code) => code === error.code)
              ) {
                this.discardHandle(id, number, clip.id, error.code !== "veo_failed");
                failure ??= this.discarded(clip.id, error);
                continue;
              }
              throw error;
            }
            signal.throwIfAborted();
            bytes = result.value;
            if (!isMp4(bytes)) {
              this.discardHandle(id, number, clip.id, true);
              failure ??= this.discarded(
                clip.id,
                new StudioError("veo_format", `클립 ${clip.id} 결과가 MP4 파일이 아닙니다.`),
              );
              continue;
            }
            await saveArtifactOnce(this.assets, id, {
              name,
              kind: "video",
              agentId: "production",
              content: bytes,
              model: result.model,
            });
          }
          const accepted = await this.review({
            id,
            number,
            clip,
            attempt: state.attempts,
            bytes,
            startImage: input.startImages.get(clip.id) ?? new Uint8Array(),
            enabled: input.settings.review,
            signal,
          });
          if (accepted || state.attempts >= CLIP_MAX_ATTEMPTS)
            this.patch(id, number, clip.id, {
              name,
              digest: contentDigest(bytes),
              operation: null,
              pendingSince: null,
            });
          else {
            this.patch(id, number, clip.id, { operation: null, pendingSince: null });
            regenerate = true;
          }
        }
      },
    });
    if (failure) throw failure;
    return regenerate;
  }
  // 결정적 실패한 클립의 핸들을 지운다. billed 가 아니면 create 가 올린 시도 횟수도 되돌린다.
  private discardHandle(id: string, number: number, clipId: ClipId, billed: boolean): void {
    const state = this.clipState(id, number, clipId);
    this.patch(id, number, clipId, {
      operation: null,
      pendingSince: null,
      attempts: billed ? state.attempts : Math.max(0, state.attempts - 1),
    });
  }
  private discarded(clipId: ClipId, error: StudioError): StudioError {
    return new StudioError(
      error.code,
      `클립 ${clipId}: ${error.message} 작업 핸들을 폐기했으니 재개하면 새로 생성합니다.`,
    );
  }
  private async readSavedClip(id: string, name: string): Promise<Uint8Array | null> {
    const bytes = await this.assets
      .read(id, name)
      .then(async (file) => new Uint8Array(await file.arrayBuffer()))
      .catch(() => null);
    return bytes && isMp4(bytes) ? bytes : null;
  }
  private async review(input: {
    readonly id: string;
    readonly number: number;
    readonly clip: VeoClip;
    readonly attempt: number;
    readonly bytes: Uint8Array;
    readonly startImage: Uint8Array;
    readonly enabled: boolean;
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    if (!input.enabled || !this.reviewFrames) return true;
    const { id, number, clip } = input;
    // 검토 결과가 이미 저장돼 있으면(저장 뒤 기록 전에 끊긴 경우) 유료 검토를 다시 부르지 않는다.
    const reviewName = renderNames.clipReview(number, clip.id, input.attempt);
    if (hasArtifact(this.store.get(id), reviewName)) {
      const saved = ImageReviewSchema.safeParse(
        await this.assets
          .read(id, reviewName)
          .then((file) => file.json())
          .catch(() => null),
      );
      if (saved.success) return saved.data.status === "pass";
    }
    const directory = await mkdtemp(join(tmpdir(), "clip-review-"));
    try {
      const video = join(directory, "clip.mp4");
      await Bun.write(video, input.bytes);
      const frames = await this.extract(video, [...CLIP_REVIEW_SECONDS], directory, input.signal);
      this.store.agent(id, "production", {
        status: "running",
        action: `영상 ${number} 클립 ${clip.id} 프레임 ${frames.length}장 연속성 검토 중`,
      });
      const review = await this.reviewFrames({
        job: this.store.get(id),
        startImage: input.startImage,
        frames,
        clip,
        signal: input.signal,
      });
      await saveArtifactOnce(this.assets, id, {
        name: reviewName,
        kind: "json",
        agentId: "production",
        content: JSON.stringify(review.value),
        model: review.model,
      });
      return review.value.status === "pass";
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
}
export function clipArtifacts(job: Job, number: number): { clipId: ClipId; name: string }[] {
  const render = job.renders.find((item) => item.number === number);
  if (!render) return [];
  return Object.entries(render.clips).flatMap(([clipId, state]) =>
    state?.name ? [{ clipId: clipId as ClipId, name: state.name }] : [],
  );
}
