import { extname } from "node:path";
import { timelineDigest } from "../shared/render-timeline";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { contentDigest, scopeDigest } from "./automation-guard";
import { publicError, StudioError } from "./errors";
import { MusicLibrary } from "./music-library";
import { ProjectStore } from "./project-store";
import { RenderProduction } from "./render-production";
import { renderNames, renderStateOf, saveArtifactOnce } from "./render-state-helpers";
import type { JobStore } from "./store";
import { VoiceProduction } from "./voice-production";

type LocalRenderer = Pick<RenderProduction, "validateSavedInputs" | "run">;

export class VideoReassembly {
  readonly assets: Artifacts;
  constructor(
    readonly store: JobStore,
    readonly renderer: LocalRenderer = new RenderProduction(
      store,
      new ProjectStore(store.db),
      store.root,
      new MusicLibrary(),
    ),
  ) {
    this.assets = new Artifacts(store);
  }
  async run(id: string, number: number, signal: AbortSignal): Promise<Job> {
    signal.throwIfAborted();
    const original = this.store.get(id);
    const automation = original.automation;
    if (
      original.status === "running" ||
      automation?.status === "running" ||
      automation?.status === "queued"
    )
      throw new StudioError("reassemble_busy", "실행 중인 작업은 재조립할 수 없습니다.");
    if (original.staged)
      throw new StudioError("reassemble_staged", "광고 게시가 준비된 작업은 재조립할 수 없습니다.");
    const render = original.renders.find((item) => item.number === number);
    if (
      automation?.policy.mode !== "creative" ||
      automation.status !== "completed" ||
      original.status !== "completed" ||
      automation.operation ||
      !render?.final
    )
      throw new StudioError(
        "reassemble_unfinished",
        "완성된 소재 제작 영상만 저장된 입력으로 재조립할 수 있습니다.",
      );
    if (automation.scopeDigest !== scopeDigest(original, automation.policy))
      throw new StudioError("scope_changed", "승인한 제작 범위가 변경되어 재조립할 수 없습니다.");
    await this.renderer.validateSavedInputs(id, number);
    const timeline = await new VoiceProduction(this.store).prepareSavedTimeline(id, number, signal);
    const names = [
      renderNames.final(number),
      renderNames.report(number),
      renderNames.captions(number),
      ...(timeline ? [renderNames.timeline(number)] : []),
    ];
    const outputs = await Promise.all(
      names.map(async (name) => {
        const artifact = original.artifacts.find((item) => item.name === name);
        if (!artifact)
          throw new StudioError("reassemble_missing", `이전 결과물 ${name}이 없습니다.`);
        return {
          artifact,
          bytes: new Uint8Array(await (await this.assets.read(id, name)).arrayBuffer()),
        };
      }),
    );
    const final = outputs.find((item) => item.artifact.name === renderNames.final(number));
    if (!final || contentDigest(final.bytes) !== render.final.digest)
      throw new StudioError("reassemble_changed", "완성 영상 파일이 제작 기록과 다릅니다.");
    signal.throwIfAborted();
    const version = crypto.randomUUID();
    for (const { artifact, bytes } of outputs) {
      const extension = extname(artifact.name);
      await this.assets.save(id, {
        name: `${artifact.name.slice(0, -extension.length)}-before-reassembly-${version}${extension}`,
        kind: artifact.kind,
        agentId: artifact.agentId,
        content: bytes,
        ...(artifact.model ? { model: artifact.model } : {}),
      });
    }
    this.store.change(id, (draft) => {
      if (!draft.automation)
        throw new StudioError("reassemble_missing", "자동 제작 기록이 없습니다.");
      draft.automation.status = "running";
      draft.automation.phase = "graphics";
      draft.automation.nextRunAt = null;
      draft.automation.operation = null;
      draft.status = "running";
      this.store.event(
        draft,
        "production",
        "info",
        `영상 ${number} 기존 입력으로 재조립 시작 · 이전 결과물 백업 완료 · 생성 API 호출 없음`,
      );
    });
    try {
      if (timeline) {
        await saveArtifactOnce(this.assets, id, {
          name: renderNames.timeline(number),
          kind: "json",
          agentId: "production",
          content: JSON.stringify(timeline),
        });
        this.store.change(id, (draft) => {
          const state = renderStateOf(draft, number);
          if (!state.voice)
            throw new StudioError("reassemble_missing", "저장된 내레이션 기록이 없습니다.");
          state.voice = { ...state.voice, timelineDigest: timelineDigest(timeline) };
        });
      }
      await this.renderer.run(id, number, signal, { replaceFinal: true });
      return this.store.change(id, (draft) => {
        draft.automation = automation;
        draft.status = original.status;
        draft.result = original.result;
        this.store.event(
          draft,
          "production",
          "success",
          `영상 ${number} 저장된 입력으로 재조립 완료 · 이전 결과물은 백업으로 보존했습니다.`,
        );
      });
    } catch (error) {
      try {
        for (const { artifact, bytes } of outputs)
          await saveArtifactOnce(this.assets, id, {
            name: artifact.name,
            kind: artifact.kind,
            agentId: artifact.agentId,
            content: bytes,
            ...(artifact.model ? { model: artifact.model } : {}),
          });
      } finally {
        this.store.change(id, (draft) => {
          draft.automation = automation;
          draft.status = original.status;
          draft.result = original.result;
          draft.agents = original.agents;
          const state = renderStateOf(draft, number);
          state.final = render.final;
          state.voice = render.voice;
          this.store.event(
            draft,
            "production",
            "error",
            `영상 ${number} 재조립 실패 · 이전 완료 상태를 유지합니다. ${publicError(error)}`,
          );
        });
      }
      throw error;
    }
  }
}
