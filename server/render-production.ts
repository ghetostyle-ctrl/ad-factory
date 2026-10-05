import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FLOW_CLIP_TOLERANCE_MS } from "../shared/flow-mode";
import { ClipIdSchema } from "../shared/render-state";
import {
  type RenderTimeline,
  RenderTimelineSchema,
  type TimelineCut,
  timelineDigest,
} from "../shared/render-timeline";
import type { Job } from "../shared/schema";
import { sha256Hex } from "../shared/sha256";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError, StudioError } from "./errors";
import type { MusicLibrary } from "./music-library";
import { ProductionAssets } from "./production-assets";
import type { ProjectStore } from "./project-store";
import { type RenderEncoder, renderEncoder } from "./provider-environment";
import { captionsAss } from "./render/ass";
import { assembleVideo, ffmpegModelId, type RenderReport } from "./render/assembler";
import { type ClipCrop, cleanCrop, cropFilter, detectBars } from "./render/clip-clean";
import { clipNeedMsFromTimeline } from "./render/clip-need";
import {
  type FfmpegRunner,
  ffmpegCapabilities,
  runFfmpeg,
  runFfmpegInfo,
  runFfprobeJson,
} from "./render/ffmpeg";
import { fontDigest, resolveFont } from "./render/fonts";
import { graphicBackgrounds, type RenderCutInput } from "./render/graphic-background";
import { renderGraphicCut, SEGMENT_TIMEOUT_MS } from "./render/motion-graphics";
import {
  aiStillSegmentArgs,
  lastFrameArgs,
  projectAudioExtractArgs,
  projectSegmentArgs,
  type SegmentExtras,
  segmentDigest,
  stillSegmentArgs,
  veoSegmentArgs,
} from "./render/segments";
import {
  artworkTopRatio,
  DEFAULT_PROFILE,
  type RenderProfile,
  THEME_VERSION,
} from "./render/theme";
import {
  approvedSources,
  hasArtifact,
  renderNames,
  renderStateOf,
  saveArtifactOnce,
  scriptOf,
} from "./render-state-helpers";
import type { JobStore } from "./store";
import { VoiceManifestSchema } from "./voice-production";

// phase 'graphics'(모션그래픽 세그먼트, 0원) → 'assemble'(세그먼트·자막·오디오 믹스 → video-final-<n>.mp4).
// 세그먼트는 data/render/<jobId>/video-<n>/seg-<i>-<digest8>.mp4 에 캐시(artifacts 미등록).
const RecoveredReportSchema = z.object({
  measuredDurationMs: z.number().int().nonnegative(),
  bgm: z.object({ id: z.string() }).nullable().optional(),
});
export type RenderProductionOptions = {
  readonly encoder?: RenderEncoder;
  readonly preset?: string;
  readonly durationBounds?: readonly [number, number];
};
export class RenderProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  readonly productionAssets: ProductionAssets;
  constructor(
    readonly store: JobStore,
    readonly library: ProjectStore,
    readonly root: string,
    readonly music: MusicLibrary,
    readonly profile: RenderProfile = DEFAULT_PROFILE,
    readonly ffmpeg: FfmpegRunner = runFfmpeg,
    readonly options: RenderProductionOptions = {},
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
    this.productionAssets = new ProductionAssets(library, root);
  }
  scratchDir(id: string, number: number): string {
    return join(this.root, "render", id, `video-${number}`);
  }
  async run(id: string, number: number, signal: AbortSignal): Promise<void> {
    const job = this.guard.check(id, signal);
    const font = resolveFont();
    // 완성본이 저장됐으면 다시 만들지 않는다. 다만 저장과 renders.final 기록 사이에 끊겼다면 기록을 복원한다.
    if (hasArtifact(job, renderNames.final(number))) {
      await this.reconcileFinal(job, number, font, signal);
      return;
    }
    if (!font)
      throw new StudioError(
        "render_unavailable",
        "자막용 한글 폰트를 찾을 수 없습니다. assets/fonts 또는 FONT_DIR 을 확인하세요.",
        503,
      );
    const timeline = await this.loadTimeline(job, number);
    const inputs = await this.resolveInputs(job, number, timeline);
    const scratch = this.scratchDir(id, number);
    await mkdir(scratch, { recursive: true });
    const fonts = fontDigest(font);
    const artworkTop = artworkTopRatio(timeline);
    const approvedPath = inputs.approved?.path ?? null;
    const graphicCuts = inputs.cuts.filter((item) => item.cut.sourceRef.kind === "graphic");
    if (graphicCuts.length > 0)
      await this.guard.operation(id, {
        phase: "graphics",
        signal,
        run: async () => {
          for (const [position, item] of graphicCuts.entries()) {
            const { cut } = item;
            const digest = segmentDigest({
              cut,
              sourceDigest: item.sourceDigest,
              themeVersion: THEME_VERSION,
              fontDigest: fonts,
              profile: this.profile,
            });
            const out = this.segmentPath(scratch, cut.index, digest);
            if (await this.cached(out, digest)) continue;
            this.store.agent(id, "production", {
              status: "running",
              action: `영상 ${number} 모션그래픽 ${position + 1}/${graphicCuts.length} 렌더 중 (${cut.graphicKind})`,
            });
            await renderGraphicCut({
              cut,
              background: item.sourcePath,
              font,
              profile: this.profile,
              out,
              signal,
              run: this.ffmpeg,
            });
            await this.markCached(out, digest);
          }
        },
      });
    await this.guard.operation(id, {
      phase: "assemble",
      signal,
      run: async () => {
        const segments: string[] = [];
        const projectAudio: { path: string; startMs: number }[] = [];
        let previous: { path: string; digest: string } | null = null;
        for (const item of inputs.cuts) {
          const { cut } = item;
          // 모션그래픽 세그먼트는 graphics 단계가 직전 컷과 무관하게 만든다(효과가 whip_pan·split_screen 이어도 digest 가 같아야 찾는다).
          const dependsOnPrevious =
            cut.sourceRef.kind !== "graphic" &&
            cut.sourceRef.kind !== "image" &&
            cut.sourceRef.kind !== "card" &&
            (cut.effect === "whip_pan" || cut.effect === "split_screen");
          const digest = segmentDigest({
            cut,
            sourceDigest: item.sourceDigest,
            themeVersion: THEME_VERSION,
            fontDigest: fonts,
            profile: this.profile,
            ...(cut.sourceRef.kind === "image" || cut.sourceRef.kind === "card"
              ? { artworkTop }
              : {}),
            ...(dependsOnPrevious && previous ? { prevDigest: previous.digest } : {}),
          });
          const out = this.segmentPath(scratch, cut.index, digest);
          if (!(await this.cached(out, digest))) {
            this.store.agent(id, "production", {
              status: "running",
              action: `영상 ${number} 컷 ${cut.index + 1}/${inputs.cuts.length} 세그먼트 렌더 중 (${cut.source} · ${cut.effect})`,
            });
            await this.renderSegment({
              item,
              out,
              previous,
              approvedPath,
              artworkTop,
              scratch,
              signal,
            });
            await this.markCached(out, digest);
          }
          if (
            cut.sourceRef.kind === "project" &&
            cut.sourceRef.audio === "keep" &&
            item.sourcePath
          ) {
            const wav = join(scratch, `proj-${cut.index}-${digest.slice(0, 8)}.wav`);
            if (!existsSync(wav))
              await this.ffmpeg(projectAudioExtractArgs(cut, item.sourcePath, wav), {
                signal,
                timeoutMs: SEGMENT_TIMEOUT_MS,
              });
            projectAudio.push({ path: wav, startMs: cut.startMs });
          }
          segments.push(out);
          previous = { path: out, digest };
        }
        const captions = join(scratch, renderNames.captions(number));
        const captionsText = captionsAss(timeline, this.profile, font);
        await Bun.write(captions, captionsText);
        const policy = this.store.get(id).automation?.policy;
        const picked = this.music.pick({
          policy: policy?.mode === "creative" ? policy.bgm : undefined,
          decisionRole: inputs.decisionRole,
          jobId: id,
          number,
        });
        const warnings = picked.warning ? [picked.warning] : [];
        const bgm = picked.track
          ? {
              path: picked.track.path,
              id: picked.track.id,
              sha256: sha256Hex(new Uint8Array(await Bun.file(picked.track.path).arrayBuffer())),
              license: [picked.track.license.name, picked.track.license.attribution]
                .filter(Boolean)
                .join(" · "),
            }
          : null;
        this.store.agent(id, "production", {
          status: "running",
          action: `영상 ${number} 최종 조립 중 · 세그먼트 ${segments.length}개 · 내레이션 ${inputs.voices.length}문장 · ${bgm ? `BGM ${bgm.id}` : "BGM 없음"}`,
        });
        const out = join(scratch, renderNames.final(number));
        const report = await assembleVideo({
          timeline,
          segments,
          projectAudio,
          voices: inputs.voices,
          bgm,
          captionsAss: captions,
          font,
          profile: this.profile,
          scratch,
          out,
          encoder: this.options.encoder ?? renderEncoder,
          signal,
          run: this.ffmpeg,
          inputDigests: inputs.digests,
          warnings,
          ...(this.options.durationBounds ? { durationBounds: this.options.durationBounds } : {}),
          ...(this.options.preset ? { preset: this.options.preset } : {}),
        });
        await this.saveOutputs({ id, number, out, captionsText, report, signal });
      },
    });
  }
  private async saveOutputs(input: {
    readonly id: string;
    readonly number: number;
    readonly out: string;
    readonly captionsText: string;
    readonly report: RenderReport;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { id, number, report } = input;
    const bytes = new Uint8Array(await Bun.file(input.out).arrayBuffer());
    const version = await ffmpegCapabilities(input.signal)
      .then((capabilities) => capabilities.version)
      .catch(() => "unknown");
    const model = {
      provider: "ffmpeg",
      requestedModel: ffmpegModelId(version),
      effectiveModel: ffmpegModelId(version),
      quality: null,
    } as const;
    const finalName = renderNames.final(number);
    // 완성본(video-final)을 맨 마지막에 등록한다: 파이프라인은 이 산출물이 있으면 영상을 끝난 것으로 보므로
    // 자막·리포트가 먼저 저장돼 있어야 중간에 끊겨도 조각난 결과가 남지 않는다.
    await saveArtifactOnce(this.assets, id, {
      name: renderNames.captions(number),
      kind: "text",
      agentId: "production",
      content: input.captionsText,
      model,
    });
    await saveArtifactOnce(this.assets, id, {
      name: renderNames.report(number),
      kind: "json",
      agentId: "production",
      content: JSON.stringify(report),
      model,
    });
    await saveArtifactOnce(this.assets, id, {
      name: finalName,
      kind: "video",
      agentId: "production",
      content: bytes,
      model,
    });
    this.store.change(id, (draft) => {
      renderStateOf(draft, number).final = {
        name: finalName,
        digest: contentDigest(bytes),
        durationMs: report.measuredDurationMs,
        bgmTrackId: report.bgm?.id ?? null,
      };
      for (const warning of report.warnings)
        this.store.event(draft, "production", "warning", `영상 ${number}: ${warning}`);
    });
    this.store.agent(id, "production", {
      status: "completed",
      action: `영상 ${number} 완성 · ${(report.measuredDurationMs / 1000).toFixed(1)}초 · ${report.integratedLufs.toFixed(1)} LUFS · ${report.bgm ? `BGM ${report.bgm.id}` : "BGM 없음"}`,
    });
  }
  // video-final 은 있는데 renders[n].final 이 비어 있으면(저장 직후 끊김) 산출물에서 기록을 복원한다.
  private async reconcileFinal(
    job: Job,
    number: number,
    font: ReturnType<typeof resolveFont>,
    signal: AbortSignal,
  ): Promise<void> {
    const id = job.id;
    const finalName = renderNames.final(number);
    const current = job.renders.find((item) => item.number === number)?.final;
    const reportName = renderNames.report(number);
    const captionsName = renderNames.captions(number);
    const hasReport = hasArtifact(job, reportName);
    if (current?.name === finalName && hasReport && hasArtifact(job, captionsName)) return;
    signal.throwIfAborted();
    const warnings: string[] = [];
    const timeline = await this.loadTimeline(job, number);
    const bytes = new Uint8Array(await (await this.assets.read(id, finalName)).arrayBuffer());
    const report = hasReport
      ? RecoveredReportSchema.safeParse(
          await (await this.assets.read(id, reportName)).json().catch(() => null),
        )
      : null;
    if (!report?.success)
      warnings.push(
        `렌더 리포트(${reportName})를 읽을 수 없어 길이를 타임라인 값(${timeline.durationMs}ms)으로 복원했습니다.`,
      );
    if (!hasArtifact(job, captionsName)) {
      if (font)
        await saveArtifactOnce(this.assets, id, {
          name: captionsName,
          kind: "text",
          agentId: "production",
          content: captionsAss(timeline, this.profile, font),
        });
      else warnings.push("자막 폰트를 찾지 못해 자막 파일(captions)을 복원하지 못했습니다.");
    }
    this.store.change(id, (draft) => {
      const render = renderStateOf(draft, number);
      if (render.final?.name !== finalName)
        render.final = {
          name: finalName,
          digest: contentDigest(bytes),
          durationMs: report?.success ? report.data.measuredDurationMs : timeline.durationMs,
          bgmTrackId: report?.success ? (report.data.bgm?.id ?? null) : null,
        };
      this.store.event(
        draft,
        "production",
        "warning",
        `영상 ${number} 완성본이 저장돼 있어 제작 기록을 복원했습니다.`,
      );
      for (const warning of warnings)
        this.store.event(draft, "production", "warning", `영상 ${number}: ${warning}`);
    });
  }
  private async loadTimeline(job: Job, number: number): Promise<RenderTimeline> {
    const name = renderNames.timeline(number);
    const render = job.renders.find((item) => item.number === number);
    if (!render?.voice || !hasArtifact(job, name))
      throw new BlockedError(`영상 ${number} 의 타임라인이 없어 조립할 수 없습니다.`);
    const timeline = RenderTimelineSchema.parse(
      await (await this.assets.read(job.id, name)).json(),
    );
    if (timelineDigest(timeline) !== render.voice.timelineDigest)
      throw new BlockedError(`영상 ${number} 타임라인 파일이 변경되었습니다. 조립을 중단합니다.`);
    return timeline;
  }
  // 모든 입력 파일을 다시 읽어 renders 기록과 재대조한다(operation 밖: 불일치는 blocked).
  private async resolveInputs(job: Job, number: number, timeline: RenderTimeline) {
    const script = scriptOf(job, number);
    const sources = approvedSources(job, script.hypothesisId);
    const render = job.renders.find((item) => item.number === number);
    const digests: Record<string, string> = {};
    const fileDigests = new Map<string, string>();
    const digestOf = async (name: string) => {
      const known = fileDigests.get(name);
      if (known) return known;
      const bytes = new Uint8Array(await (await this.assets.read(job.id, name)).arrayBuffer());
      const digest = contentDigest(bytes);
      fileDigests.set(name, digest);
      digests[name] = digest;
      return digest;
    };
    const approved = sources.approvedImage
      ? {
          path: this.assets.path(job.id, sources.approvedImage.name),
          digest: await digestOf(sources.approvedImage.name),
        }
      : null;
    // 검토를 통과한 대표 이미지의 기록 digest 와 다르면 교체된 파일이므로 조립하지 않는다.
    if (
      approved &&
      sources.approvedImage?.digest &&
      approved.digest !== sources.approvedImage.digest
    )
      throw new BlockedError("검토를 통과한 대표 이미지 파일이 변경되었습니다. 조립을 중단합니다.");
    const projectId = job.productionSourceSnapshot?.projectId ?? null;
    const cuts: RenderCutInput[] = [];
    for (const cut of timeline.cuts) {
      switch (cut.sourceRef.kind) {
        case "veo": {
          const state = render?.clips[cut.sourceRef.clipId];
          if (!state?.name || !state.digest || !hasArtifact(job, state.name))
            throw new BlockedError(
              `컷 ${cut.index + 1}: 클립 ${cut.sourceRef.clipId} 파일이 없습니다.`,
            );
          const digest = await digestOf(state.name);
          if (digest !== state.digest)
            throw new BlockedError(
              `클립 ${cut.sourceRef.clipId} 파일이 변경되었습니다. 조립을 중단합니다.`,
            );
          const fromFlow =
            job.artifacts.find((asset) => asset.name === state.name)?.model?.provider === "flow";
          cuts.push({
            cut,
            sourcePath: this.assets.path(job.id, state.name),
            // 정리 규칙이 바뀌면 세그먼트 캐시가 무효화되도록 digest 에 규칙 이름을 붙인다.
            sourceDigest: fromFlow ? `${digest}:clean1` : digest,
            ...(fromFlow ? { cleanClip: true } : {}),
          });
          break;
        }
        case "still": {
          // 정지 이미지는 내레이션 합성 뒤에 만들어지므로 타임라인에는 이름이 없고, 기록(renders.stills)에서 찾는다.
          const state = render?.stills[cut.sourceRef.stillId];
          const name = state?.name || cut.sourceRef.artifactName;
          if (!state?.digest || !name || !hasArtifact(job, name))
            throw new BlockedError(
              `컷 ${cut.index + 1}: 정지 이미지 ${cut.sourceRef.stillId} 파일이 없습니다.`,
            );
          const digest = await digestOf(name);
          if (digest !== state.digest)
            throw new BlockedError(
              `정지 이미지 ${cut.sourceRef.stillId} 파일이 변경되었습니다. 조립을 중단합니다.`,
            );
          cuts.push({ cut, sourcePath: this.assets.path(job.id, name), sourceDigest: digest });
          break;
        }
        case "image":
        case "card": {
          const name = cut.sourceRef.artifactName || sources.approvedImage?.name;
          if (!name || !hasArtifact(job, name))
            throw new BlockedError(`컷 ${cut.index + 1}: 화면에 쓸 이미지 산출물이 없습니다.`);
          cuts.push({
            cut,
            sourcePath: this.assets.path(job.id, name),
            sourceDigest: await digestOf(name),
          });
          break;
        }
        case "project": {
          if (!projectId)
            throw new BlockedError(`컷 ${cut.index + 1}: 촬영본 프로젝트가 없습니다.`);
          const stored = this.productionAssets.file(projectId, cut.sourceRef.assetId);
          if (!existsSync(stored.path))
            throw new BlockedError(
              `컷 ${cut.index + 1}: 촬영본 파일이 없습니다(${stored.asset.title}).`,
            );
          digests[`project:${stored.asset.id}`] = stored.asset.sha256;
          cuts.push({ cut, sourcePath: stored.path, sourceDigest: stored.asset.sha256 });
          break;
        }
        case "graphic":
          cuts.push({ cut, sourcePath: null, sourceDigest: approved?.digest ?? "none" });
          break;
        default:
          return cut.sourceRef satisfies never;
      }
    }
    await this.checkFlowClipLengths(job, number, timeline);
    const voices: { path: string; startMs: number }[] = [];
    const recorded = await this.voiceDigests(job, number);
    for (const line of timeline.voice) {
      if (!line.artifactName || !hasArtifact(job, line.artifactName))
        throw new BlockedError(`문장 ${line.index + 1} 의 내레이션 파일이 없습니다.`);
      const actual = await digestOf(line.artifactName);
      if (recorded.get(line.artifactName) !== actual)
        throw new BlockedError(
          `문장 ${line.index + 1} 의 내레이션 파일이 합성 기록과 다릅니다. 조립을 중단합니다.`,
        );
      voices.push({ path: this.assets.path(job.id, line.artifactName), startMs: line.startMs });
    }
    return {
      cuts: graphicBackgrounds(cuts),
      voices,
      approved,
      digests,
      decisionRole: sources.decisionRole,
    };
  }
  // Flow 클립은 길이가 제각각이라, 확정된 타임라인의 컷이 읽는 구간보다 짧으면 영상 트랙이 말없이 일찍 끝난다.
  // 업로드 때 대본 값으로 거른 뒤 타임라인이 늘어난 경우까지 여기서 잡는다(API 클립은 항상 8초라 검사하지 않는다).
  private async checkFlowClipLengths(
    job: Job,
    number: number,
    timeline: RenderTimeline,
  ): Promise<void> {
    const render = job.renders.find((item) => item.number === number);
    for (const [clipId, state] of Object.entries(render?.clips ?? {})) {
      if (!state?.name) continue;
      const artifact = job.artifacts.find((asset) => asset.name === state.name);
      if (artifact?.model?.provider !== "flow") continue;
      const needMs = clipNeedMsFromTimeline(timeline.cuts, ClipIdSchema.parse(clipId));
      if (needMs <= 0) continue;
      const probed = await runFfprobeJson(
        ["-show_entries", "format=duration", this.assets.path(job.id, state.name)],
        new AbortController().signal,
      );
      const parsed = z.object({ format: z.object({ duration: z.string() }) }).safeParse(probed);
      const sec = Number(parsed.success ? parsed.data.format.duration : NaN);
      if (!Number.isFinite(sec) || sec * 1000 + FLOW_CLIP_TOLERANCE_MS < needMs)
        throw new StudioError(
          "flow_short",
          `클립 ${clipId} 은 컷이 ${(needMs / 1000).toFixed(1)}초 지점까지 읽는데 파일이 ${
            Number.isFinite(sec) ? `${sec.toFixed(1)}초` : "길이를 알 수 없는 파일"
          }입니다. 영상이 말없이 잘리므로 조립하지 않습니다. 더 긴(8초) 클립을 다시 올린 뒤 이어서 실행하세요.`,
          409,
        );
    }
  }
  // 내레이션 매니페스트에 기록된 wav 해시(파일 이름 → digest). 매니페스트가 없으면 조립하지 않는다.
  private async voiceDigests(job: Job, number: number): Promise<Map<string, string>> {
    const name = job.renders.find((item) => item.number === number)?.voice?.manifestName;
    if (!name || !hasArtifact(job, name))
      throw new BlockedError(`영상 ${number} 의 내레이션 합성 기록이 없어 조립할 수 없습니다.`);
    const manifest = VoiceManifestSchema.parse(await (await this.assets.read(job.id, name)).json());
    return new Map(manifest.lines.map((line) => [line.name, line.digest]));
  }
  private segmentPath(scratch: string, index: number, digest: string): string {
    return join(scratch, `seg-${String(index).padStart(3, "0")}-${digest.slice(0, 8)}.mp4`);
  }
  private async cached(path: string, digest: string): Promise<boolean> {
    if (!existsSync(path) || !existsSync(`${path}.json`)) return false;
    try {
      const sidecar = JSON.parse(await Bun.file(`${path}.json`).text()) as { digest?: unknown };
      return sidecar.digest === digest;
    } catch {
      return false;
    }
  }
  private async markCached(path: string, digest: string): Promise<void> {
    await Bun.write(`${path}.json`, JSON.stringify({ digest, at: new Date().toISOString() }));
  }
  // Flow 클립별 정리 영역(검은 띠 + 워터마크)은 한 번만 계산한다.
  private readonly cleanCrops = new Map<string, Promise<ClipCrop | null>>();
  private cleanCropFor(path: string, signal: AbortSignal): Promise<ClipCrop | null> {
    let found = this.cleanCrops.get(path);
    if (!found) {
      found = (async () => {
        const probed = await runFfprobeJson(
          ["-select_streams", "v:0", "-show_entries", "stream=width,height", path],
          signal,
        );
        const parsed = z
          .object({ streams: z.array(z.object({ width: z.number(), height: z.number() })).min(1) })
          .safeParse(probed);
        if (!parsed.success) return null;
        const size = parsed.data.streams[0];
        if (!size) return null;
        const bars = await detectBars(path, signal, runFfmpegInfo);
        return cleanCrop(size, bars, { watermark: true });
      })();
      this.cleanCrops.set(path, found);
    }
    return found;
  }
  private async renderSegment(input: {
    readonly item: RenderCutInput;
    readonly out: string;
    readonly previous: { path: string; digest: string } | null;
    readonly approvedPath: string | null;
    readonly artworkTop: number;
    readonly scratch: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { cut, sourcePath } = input.item;
    const extras: { -readonly [K in keyof SegmentExtras]: SegmentExtras[K] } = {
      artworkTop: input.artworkTop,
    };
    const usesFrameEffects = cut.sourceRef.kind !== "image" && cut.sourceRef.kind !== "card";
    if (usesFrameEffects && cut.effect === "whip_pan" && input.previous) {
      const frame = join(input.scratch, `prev-${cut.index}.png`);
      await this.ffmpeg(lastFrameArgs(input.previous.path, frame, this.profile.fps), {
        signal: input.signal,
        timeoutMs: SEGMENT_TIMEOUT_MS,
      });
      extras.prevFrame = frame;
    }
    if (usesFrameEffects && cut.effect === "split_screen") {
      if (input.previous) extras.prevSegment = input.previous.path;
      else if (input.approvedPath) extras.still = input.approvedPath;
    }
    const run = async (args: string[]) => {
      await this.ffmpeg(args, { signal: input.signal, timeoutMs: SEGMENT_TIMEOUT_MS });
    };
    switch (cut.sourceRef.kind) {
      case "veo":
        if (!sourcePath) throw new BlockedError("클립 경로가 없습니다.");
        if (input.item.cleanClip) {
          const crop = await this.cleanCropFor(sourcePath, input.signal);
          if (crop) extras.clipCrop = cropFilter(crop);
        }
        return run(veoSegmentArgs(cut, sourcePath, this.profile, input.out, extras));
      case "still":
        if (!sourcePath) throw new BlockedError("정지 이미지 경로가 없습니다.");
        return run(aiStillSegmentArgs(cut, sourcePath, this.profile, input.out, extras));
      case "image":
      case "card":
        if (!sourcePath) throw new BlockedError("이미지 경로가 없습니다.");
        return run(
          stillSegmentArgs(
            cut,
            sourcePath,
            this.profile,
            input.out,
            cut.index % 2 === 0 ? "in" : "out",
            extras,
          ),
        );
      case "project":
        if (!sourcePath) throw new BlockedError("촬영본 경로가 없습니다.");
        return run(projectSegmentArgs(cut, sourcePath, this.profile, input.out, extras));
      case "graphic":
        throw new StudioError(
          "render_graphic",
          `컷 ${cut.index + 1} 모션그래픽 세그먼트가 없습니다.`,
        );
      default:
        return cut.sourceRef satisfies never;
    }
  }
}
export function cutLabel(cut: TimelineCut): string {
  return `${cut.index + 1}:${cut.source}`;
}
