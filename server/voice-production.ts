import { z } from "zod";
import { type ExecutionModels, ttsVoicePresets } from "../shared/models";
import { type VoiceLineRecord, VoiceLineRecordSchema } from "../shared/render-state";
import {
  buildTimeline,
  type RenderTimeline,
  TIMELINE_DEFAULTS,
  timelineDigest,
  type VoiceMeasurement,
} from "../shared/render-timeline";
import type { Job } from "../shared/schema";
import {
  scriptApprovalMessage,
  scriptApprovalReady,
  scriptApproved,
  scriptNeedsApproval,
} from "../shared/script-approval";
import { sha256Hex } from "../shared/sha256";
import type { VideoScript } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import { AutomationGuard } from "./automation-guard";
import { BlockedError, StudioError, WaitingError } from "./errors";
import {
  approvedSources,
  hasArtifact,
  renderNames,
  renderStateOf,
  saveArtifactOnce,
  scriptDigest,
  scriptOf,
} from "./render-state-helpers";
import type { JobStore } from "./store";
import { generateVoiceResult, type VoiceProvider } from "./tts-provider";

export type { VoiceLineRecord };
// phase 'voice': Typecast 문장별 합성 → 실측 길이로 타임라인 확정. 가장 싼 유료 단계라 Veo 보다 먼저 돈다.
// 문장 기록 스키마는 renders 상태(문장별 중간 저장)와 공유하므로 shared/render-state 에 두고 다시 내보낸다.
export { VoiceLineRecordSchema };
export const VoiceManifestSchema = z.object({
  number: z.number().int().min(1).max(10),
  scriptDigest: z.string(),
  voiceId: z.string(),
  selection: z.enum(["auto", "manual"]),
  lines: z.array(VoiceLineRecordSchema),
});
export type VoiceManifest = z.infer<typeof VoiceManifestSchema>;

// manual → ttsVoiceId, auto → 프리셋 첫 번째(Seojin) 고정. AI 판단 없음.
export function resolveVoice(models: ExecutionModels): {
  voiceId: string;
  selection: "auto" | "manual";
  name: string;
} {
  const first = ttsVoicePresets[0];
  if (models.ttsSelection === "manual" && models.ttsVoiceId) {
    const preset = ttsVoicePresets.find((item) => item.id === models.ttsVoiceId);
    return { voiceId: models.ttsVoiceId, selection: "manual", name: preset?.name ?? "직접 지정" };
  }
  return { voiceId: first.id, selection: "auto", name: first.name };
}
// 429 백오프(0.5/1/2초) 3회
const RATE_BACKOFF_MS = [500, 1000, 2000] as const;

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class VoiceProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  constructor(
    readonly store: JobStore,
    readonly synthesize: VoiceProvider = generateVoiceResult,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
  }
  async run(
    id: string,
    number: number,
    signal: AbortSignal,
    options: { readonly concurrencyLimit?: number } = {},
  ): Promise<void> {
    const job = this.guard.check(id, signal);
    const script = scriptOf(job, number);
    const digest = scriptDigest(script);
    const state = job.renders.find((item) => item.number === number);
    if (state?.voice && hasArtifact(job, renderNames.timeline(number))) {
      if (state.scriptDigest && state.scriptDigest !== digest)
        throw new StudioError(
          "script_changed",
          `영상 ${number} 대본이 내레이션 합성 이후 바뀌었습니다. 작업을 초기화한 뒤 다시 시작하세요.`,
        );
      return;
    }
    // 첫 유료 단계: 승인이 필요한 대본(기본 정책, 또는 auto 라도 AI 검토 강제 수용)은 승인 없이 합성을 시작하지 않는다(대기, 실패 아님).
    if (scriptNeedsApproval(job, number) && !scriptApproved(job, number)) {
      this.store.change(id, (draft) => {
        if (draft.automation) draft.automation.phase = "script";
      });
      throw new WaitingError(scriptApprovalMessage(1), scriptApprovalReady);
    }
    const models = job.executionModels;
    if (!models) throw new BlockedError("실행 모델 스냅샷이 없어 보이스를 정할 수 없습니다.");
    const voice = resolveVoice(models);
    await this.guard.operation(id, {
      phase: "voice",
      signal,
      run: async () => {
        const manifest = await this.loadOrSynthesize({
          id,
          number,
          script,
          digest,
          voice,
          models,
          signal,
          concurrency: Math.max(1, Math.min(options.concurrencyLimit ?? 2, 3)),
        });
        const timeline = this.timelineFrom(this.store.get(id), script, manifest);
        const timelineName = renderNames.timeline(number);
        if (!hasArtifact(this.store.get(id), timelineName))
          await saveArtifactOnce(this.assets, id, {
            name: timelineName,
            kind: "json",
            agentId: "production",
            content: JSON.stringify(timeline),
          });
        this.store.change(id, (draft) => {
          const render = renderStateOf(draft, number, digest);
          render.scriptDigest = digest;
          render.voice = {
            manifestName: renderNames.voiceManifest(number),
            voiceId: manifest.voiceId,
            timelineDigest: timelineDigest(timeline),
          };
          // 확정됐으니 중간 기록은 필요 없다(매니페스트가 같은 내용을 가진다).
          render.voiceLines = [];
        });
        this.store.agent(id, "production", {
          status: "completed",
          action: `영상 ${number} 내레이션 ${manifest.lines.length}문장 합성·타임라인 확정(${(timeline.durationMs / 1000).toFixed(1)}초${timeline.extendedMs ? ` · ${timeline.extendedMs}ms 연장` : ""})`,
        });
      },
    });
  }
  // voice-<n>.json 이 있으면 재요청 0회. 없으면 문장별 합성 → 창 초과 문장만 템포 재합성(attempt 2) → 저장.
  private async loadOrSynthesize(input: {
    readonly id: string;
    readonly number: number;
    readonly script: VideoScript;
    readonly digest: string;
    readonly voice: ReturnType<typeof resolveVoice>;
    readonly models: ExecutionModels;
    readonly signal: AbortSignal;
    readonly concurrency: number;
  }): Promise<VoiceManifest> {
    const { id, number, script } = input;
    const manifestName = renderNames.voiceManifest(number);
    if (hasArtifact(this.store.get(id), manifestName)) {
      const manifest = VoiceManifestSchema.parse(
        await (await this.assets.read(id, manifestName)).json(),
      );
      if (manifest.scriptDigest !== input.digest)
        throw new StudioError(
          "script_changed",
          `영상 ${number} 대본이 내레이션 합성 이후 바뀌었습니다. 작업을 초기화한 뒤 다시 시작하세요.`,
        );
      return manifest;
    }
    const lines = script.voiceover;
    const total = lines.length;
    const semaphore = new Semaphore(input.concurrency);
    let done = 0;
    // 한 문장이 실패하면 대기 중인 문장은 더 요청하지 않는다(Promise.all 은 나머지를 취소하지 않으므로 직접 멈춘다).
    let failed: { readonly error: unknown } | null = null;
    const synthesizeLine = async (index: number, tempo: number, attempt: 1 | 2) => {
      const line = lines[index];
      if (!line) throw new RangeError(`문장 ${index + 1} 이 없습니다.`);
      // 이전 실행이 저장해 둔 문장(wav·textDigest·tempo 일치)은 Typecast 를 다시 부르지 않고 재사용한다.
      const reused = await this.reusableLine({ ...input, index, tempo, attempt });
      if (reused) {
        done++;
        return reused;
      }
      return semaphore.run(async () => {
        if (failed) throw failed.error;
        try {
          return await synthesizeAndRecord(index, tempo, attempt, line.text);
        } catch (error) {
          failed ??= { error };
          throw error;
        }
      });
    };
    const synthesizeAndRecord = async (
      index: number,
      tempo: number,
      attempt: 1 | 2,
      lineText: string,
    ): Promise<VoiceLineRecord> => {
      this.store.agent(id, "production", {
        status: "running",
        action: `영상 ${number} 나레이션 ${Math.min(done + 1, total)}/${total} 합성 중 · 보이스 ${input.voice.name}${attempt === 2 ? ` · 템포 ${tempo} 재합성` : ""}`,
      });
      const result = await this.synthesizeWithBackoff({
        text: lineText,
        ...(lines[index - 1] ? { previousText: lines[index - 1]?.text ?? "" } : {}),
        ...(lines[index + 1] ? { nextText: lines[index + 1]?.text ?? "" } : {}),
        voiceId: input.voice.voiceId,
        tempo,
        signal: input.signal,
        models: input.models,
      });
      const name = renderNames.voice(number, index, attempt);
      await saveArtifactOnce(this.assets, id, {
        name,
        kind: "audio",
        agentId: "production",
        content: result.value.audio,
        model: result.model,
      });
      done++;
      const record: VoiceLineRecord = {
        index,
        text: lineText,
        textDigest: sha256Hex(lineText),
        name,
        digest: sha256Hex(result.value.audio),
        durationMs: result.value.durationMs,
        tempo,
        attempt,
        words: result.value.words,
      };
      // 문장마다 바로 기록한다: 중간에 끊겨도 손실은 진행 중이던 문장뿐이다.
      this.store.change(id, (draft) => {
        const render = renderStateOf(draft, number, input.digest);
        render.voiceLines = render.voiceLines.filter(
          (item) => !(item.index === index && item.attempt === attempt),
        );
        render.voiceLines.push({ ...record, voiceId: input.voice.voiceId });
      });
      return record;
    };
    const baseTempo = input.models.ttsTempo;
    const records = await Promise.all(lines.map((_, index) => synthesizeLine(index, baseTempo, 1)));
    // 창 초과 문장만 템포를 올려 1회 재합성. 앞 문장 연장으로 밀린 문장이 또 걸릴 수 있어 두 바퀴까지 본다.
    for (let round = 0; round < 2; round++) {
      const built = buildTimeline(script, records.map(measurement));
      if (!("overflow" in built)) break;
      done = 0;
      const resynthesized = await Promise.all(
        built.overflow.map((item) => synthesizeLine(item.index, item.requiredTempo, 2)),
      );
      for (const record of resynthesized) records[record.index] = record;
    }
    const manifest: VoiceManifest = {
      number,
      scriptDigest: input.digest,
      voiceId: input.voice.voiceId,
      selection: input.voice.selection,
      lines: records,
    };
    await saveArtifactOnce(this.assets, id, {
      name: manifestName,
      kind: "json",
      agentId: "production",
      content: JSON.stringify(manifest),
    });
    return manifest;
  }
  // 저장된 문장 기록이 현재 대본 문장·템포·보이스와 일치하고 wav 파일의 해시도 같을 때만 돌려준다.
  private async reusableLine(input: {
    readonly id: string;
    readonly number: number;
    readonly script: VideoScript;
    readonly voice: ReturnType<typeof resolveVoice>;
    readonly index: number;
    readonly tempo: number;
    readonly attempt: 1 | 2;
  }): Promise<VoiceLineRecord | null> {
    const { id, number, index, attempt } = input;
    const line = input.script.voiceover[index];
    const job = this.store.get(id);
    const saved = job.renders
      .find((item) => item.number === number)
      ?.voiceLines.find((item) => item.index === index && item.attempt === attempt);
    if (!line || !saved) return null;
    if (
      saved.voiceId !== input.voice.voiceId ||
      saved.text !== line.text ||
      saved.textDigest !== sha256Hex(line.text) ||
      Math.abs(saved.tempo - input.tempo) > 1e-9 ||
      saved.name !== renderNames.voice(number, index, attempt) ||
      !hasArtifact(job, saved.name)
    )
      return null;
    const bytes = await this.assets
      .read(id, saved.name)
      .then(async (file) => new Uint8Array(await file.arrayBuffer()))
      .catch(() => null);
    if (!bytes || sha256Hex(bytes) !== saved.digest) return null;
    const { voiceId: _voiceId, ...record } = saved;
    return record;
  }
  private async synthesizeWithBackoff(task: Parameters<VoiceProvider>[0]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.synthesize(task);
      } catch (error) {
        const wait = RATE_BACKOFF_MS[attempt];
        if (!(error instanceof StudioError) || error.code !== "typecast_rate" || !wait) throw error;
        await Bun.sleep(wait);
        task.signal.throwIfAborted();
      }
    }
  }
  private timelineFrom(job: Job, script: VideoScript, manifest: VoiceManifest): RenderTimeline {
    const sources = approvedSources(job, script.hypothesisId);
    const result = buildTimeline(script, manifest.lines.map(measurement), {
      ...TIMELINE_DEFAULTS,
      sources: {
        ...(sources.approvedImage ? { approvedImage: sources.approvedImage.name } : {}),
        cards: sources.cards,
        projectAssets: sources.projectAssets,
      },
    });
    if ("timeline" in result) return result.timeline;
    const index = "overflow" in result ? (result.overflow[0]?.index ?? 0) : result.index;
    throw new StudioError(
      "voice_overflow",
      `영상 ${script.number} 문장 ${index + 1}의 내레이션이 템포 ${TIMELINE_DEFAULTS.maxTempo}·연장 ${TIMELINE_DEFAULTS.maxExtendMs / 1000}초 안에 들어가지 않습니다. 작업을 초기화하고 대본을 다시 생성하세요.`,
    );
  }
}
function measurement(record: VoiceLineRecord): VoiceMeasurement {
  return {
    index: record.index,
    durationMs: record.durationMs,
    tempo: record.tempo,
    attempt: record.attempt,
    artifactName: record.name,
    words: record.words,
  };
}
