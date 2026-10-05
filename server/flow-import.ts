import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  clipModeOf,
  FLOW_CLIP_MAX_BYTES,
  FLOW_CLIP_MAX_SEC,
  FLOW_CLIP_MIN_SEC,
  FLOW_CLIP_TOLERANCE_MS,
  FLOW_MAX_ATTEMPTS,
  flowModelId,
  suggestedFlowModel,
  videoScriptFor,
} from "../shared/flow-mode";
import type { ClipId } from "../shared/render-state";
import { RenderTimelineSchema } from "../shared/render-timeline";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { contentDigest } from "./automation-guard";
import { StudioError } from "./errors";
import { clipNeedMsFromScript, clipNeedMsFromTimeline } from "./render/clip-need";
import { runFfprobeJson } from "./render/ffmpeg";
import { hasArtifact, renderNames, renderStateOf, scriptDigest } from "./render-state-helpers";
import type { JobStore } from "./store";

// Google Flow(웹)에서 만든 Veo 클립을 받아 job.renders[n].clips[id] 에 API 클립과 같은 형태로 기록한다.
// 검증: 작업·Flow 모드·선언된 클립 ID → 크기 → 'ftyp' 매직 → ffprobe(세로·4~12초·컷이 읽는 구간 이상). 통과하면 clip-<n>-<id>-<시도>.mp4 로 저장.
const invalid = (code: string, message: string, status: 400 | 409 | 413 = 400) =>
  new StudioError(code, message, status);
const ProbeSchema = z.object({
  format: z.object({ duration: z.string().optional() }).optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        duration: z.string().optional(),
      }),
    )
    .default([]),
});
export type FlowClipProbe = {
  readonly width: number;
  readonly height: number;
  readonly sec: number;
};
export type FlowClipProber = (bytes: Uint8Array) => Promise<FlowClipProbe>;

// 임시 파일로 쓴 뒤 ffprobe 로 실제 해상도·길이를 잰다(파일 안에 영상 스트림이 있어야 한다).
export const probeClipBytes: FlowClipProber = async (bytes) => {
  const directory = await mkdtemp(join(tmpdir(), "flow-clip-"));
  try {
    const path = join(directory, "clip.mp4");
    await Bun.write(path, bytes);
    const raw = await runFfprobeJson(
      [
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,duration",
        path,
      ],
      new AbortController().signal,
    ).catch((error: unknown) => {
      if (error instanceof StudioError && error.status === 503) throw error;
      throw invalid(
        "flow_invalid",
        "영상 파일을 읽을 수 없습니다. 정상적인 MP4 파일인지 확인하세요.",
      );
    });
    const parsed = ProbeSchema.safeParse(raw);
    const video = parsed.success
      ? parsed.data.streams.find((stream) => stream.codec_type === "video")
      : undefined;
    const sec = Number(parsed.success ? (parsed.data.format?.duration ?? video?.duration) : NaN);
    if (!video?.width || !video.height || !Number.isFinite(sec) || sec <= 0)
      throw invalid("flow_invalid", "길이와 화면 크기가 있는 영상 파일만 업로드할 수 있습니다.");
    return { width: video.width, height: video.height, sec };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
}

export type FlowImportResult = {
  readonly job: Job;
  readonly name: string;
  readonly attempt: number;
  readonly replaced: boolean;
};
export class FlowImport {
  readonly assets: Artifacts;
  constructor(
    readonly store: JobStore,
    readonly probe: FlowClipProber = probeClipBytes,
  ) {
    this.assets = new Artifacts(store);
  }
  async import(input: {
    readonly jobId: string;
    readonly number: number;
    readonly clipId: ClipId;
    readonly bytes: Uint8Array;
    // 사용자가 Flow 에서 실제로 쓴 모델 이름(선택). 모르면 비워 둔다.
    readonly model?: string | null | undefined;
  }): Promise<FlowImportResult> {
    const { jobId, number, clipId, bytes } = input;
    const job = this.store.get(jobId);
    const policy = job.automation?.policy;
    if (clipModeOf(job) !== "flow" || policy?.mode !== "creative")
      throw invalid(
        "flow_mode",
        "이 작업은 Google Flow 모드가 아닙니다. 클립 생성 방식을 Flow로 시작한 작업에만 업로드할 수 있습니다.",
        409,
      );
    const script = videoScriptFor(job, number);
    if (number > (policy.videoCount ?? 0) || !script)
      throw invalid("flow_video", `영상 ${number} 의 대본이 없습니다.`, 400);
    if (!script.veoClips.some((clip) => clip.id === clipId))
      throw invalid(
        "flow_clip",
        `영상 ${number} 에 선언된 클립이 아닙니다(선언된 클립: ${script.veoClips.map((clip) => clip.id).join(", ")}).`,
      );
    if (hasArtifact(job, renderNames.final(number)))
      throw invalid(
        "flow_final",
        `영상 ${number} 은 이미 완성되어 클립을 바꿀 수 없습니다. 완성 영상을 다시 만들려면 작업을 초기화하세요.`,
        409,
      );
    if (bytes.length === 0) throw invalid("flow_empty", "빈 파일은 업로드할 수 없습니다.");
    if (bytes.length > FLOW_CLIP_MAX_BYTES)
      throw invalid("flow_size", "클립 파일은 200MB 이하여야 합니다.", 413);
    if (!isMp4(bytes))
      throw invalid(
        "flow_format",
        "MP4 파일이 아닙니다. Flow에서 내려받은 .mp4 파일을 올려 주세요.",
      );
    const measured = await this.probe(bytes);
    if (measured.height <= measured.width)
      throw invalid(
        "flow_orientation",
        `세로 영상(9:16)이 아닙니다(${measured.width}x${measured.height}). Flow에서 화면 비율을 9:16으로 만들었는지 확인하세요.`,
      );
    if (measured.sec < FLOW_CLIP_MIN_SEC || measured.sec > FLOW_CLIP_MAX_SEC)
      throw invalid(
        "flow_duration",
        `클립 길이는 ${FLOW_CLIP_MIN_SEC}~${FLOW_CLIP_MAX_SEC}초여야 합니다(받은 길이 ${measured.sec.toFixed(1)}초).`,
      );
    // 컷이 이 클립에서 읽는 구간보다 짧은 클립은 말없이 잘린 영상을 만들므로 여기서 거른다.
    const needMs = await this.needMs(job, number, clipId);
    if (measured.sec * 1000 + FLOW_CLIP_TOLERANCE_MS < needMs)
      throw invalid(
        "flow_short",
        `클립 ${clipId} 은 컷이 ${(needMs / 1000).toFixed(1)}초 지점까지 읽어 그만큼 길어야 합니다(받은 길이 ${measured.sec.toFixed(1)}초). Flow에서 8초 길이로 다시 만들어 올려 주세요.`,
      );
    // 검증을 기다리는 동안 상태가 바뀌었을 수 있어 다시 읽는다. 교체(이미 클립이 있음)는 조립·그래픽이
    // 그 클립 파일을 읽는 중일 수 있으므로 작업이 실행 중일 때는 받지 않는다.
    const current = this.store.get(jobId);
    const existing = current.renders.find((item) => item.number === number)?.clips[clipId];
    const replaced = Boolean(existing?.name);
    if (replaced && (current.status === "running" || current.automation?.status === "running"))
      throw invalid(
        "flow_busy",
        "작업이 실행 중이라 이미 올린 클립을 바꿀 수 없습니다. 잠시 뒤 다시 시도하세요.",
        409,
      );
    if (hasArtifact(current, renderNames.final(number)))
      throw invalid("flow_final", `영상 ${number} 은 이미 완성되어 클립을 바꿀 수 없습니다.`, 409);
    let attempt = (existing?.attempts ?? 0) + 1;
    while (
      attempt <= FLOW_MAX_ATTEMPTS &&
      hasArtifact(current, renderNames.clip(number, clipId, attempt))
    )
      attempt++;
    if (attempt > FLOW_MAX_ATTEMPTS)
      throw invalid(
        "flow_attempts",
        `클립 ${clipId} 은 ${FLOW_MAX_ATTEMPTS}번까지만 올릴 수 있습니다.`,
        409,
      );
    const name = renderNames.clip(number, clipId, attempt);
    const effective = flowModelId(input.model);
    await this.assets.save(jobId, {
      name,
      kind: "video",
      agentId: "production",
      content: bytes,
      model: {
        provider: "flow",
        requestedModel: flowModelId(suggestedFlowModel(policy.videoModel)),
        effectiveModel: effective,
        quality: null,
      },
    });
    const digest = contentDigest(bytes);
    const result = this.store.change(jobId, (draft) => {
      const render = renderStateOf(draft, number, scriptDigest(script));
      render.clips[clipId] = {
        name,
        digest,
        attempts: attempt,
        pendingSince: null,
        operation: null,
      };
      this.store.event(
        draft,
        "production",
        "info",
        `영상 ${number} 클립 ${clipId} Flow 클립 업로드(${attempt}번째, ${measured.width}x${measured.height}, ${measured.sec.toFixed(1)}초)${replaced ? " · 이전 클립을 교체" : ""}`,
      );
    });
    // 교체한 클립에서 만든 그래픽·조립 캐시는 다시 만들도록 영상별 작업 폴더를 지운다(세그먼트 digest 가 달라 어차피 재사용되지 않는다).
    if (replaced)
      await rm(join(this.store.root, "render", jobId, `video-${number}`), {
        recursive: true,
        force: true,
      });
    return { job: result, name, attempt, replaced };
  }
  // 이 클립에서 컷이 읽는 끝 지점(ms). 내레이션 합성으로 타임라인이 확정됐으면 그 값을, 아니면 대본 값을 쓴다.
  private async needMs(job: Job, number: number, clipId: ClipId): Promise<number> {
    const script = videoScriptFor(job, number);
    const scriptNeed = script ? clipNeedMsFromScript(script, clipId) : 0;
    const name = renderNames.timeline(number);
    if (!job.renders.find((item) => item.number === number)?.voice || !hasArtifact(job, name))
      return scriptNeed;
    try {
      const parsed = RenderTimelineSchema.safeParse(
        await (await this.assets.read(job.id, name)).json(),
      );
      return parsed.success
        ? Math.max(scriptNeed, clipNeedMsFromTimeline(parsed.data.cuts, clipId))
        : scriptNeed;
    } catch {
      return scriptNeed;
    }
  }
}
