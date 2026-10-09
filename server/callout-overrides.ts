import { z } from "zod";
import { CalloutMotionSchema } from "../shared/callout-motion";
import type { CalloutOverridesEdit, CalloutOverridesView } from "../shared/callout-overrides";
import type { RenderTimeline } from "../shared/render-timeline";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { contentDigest, scopeDigest } from "./automation-guard";
import { StudioError } from "./errors";
import { fontDigest, resolveFont } from "./render/fonts";
import type { RenderCutInput } from "./render/graphic-background";
import { type RenderProfile, THEME, THEME_VERSION } from "./render/theme";
import { saveArtifactOnce } from "./render-state-helpers";
import type { JobStore } from "./store";

const SidecarSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string(),
  updatedAt: z.string(),
  callouts: z.array(
    z.strictObject({ index: z.number().int().nonnegative(), motion: CalloutMotionSchema }),
  ),
});
type Sidecar = z.infer<typeof SidecarSchema>;
export type CalloutContext = {
  readonly timeline: RenderTimeline;
  readonly fingerprint: string;
  readonly profile: RenderProfile;
};
type ContextReader = { calloutContext(id: string, number: number): Promise<CalloutContext> };
const sidecarName = (number: number) => `callout-overrides-${number}.json`;

export async function calloutSourceFingerprint(
  timeline: RenderTimeline,
  inputs: readonly RenderCutInput[],
  profile: RenderProfile,
): Promise<string> {
  const sourceHashes = new Map<string, string>();
  const sources = [];
  for (const input of inputs) {
    let bytesDigest = null;
    if (input.sourcePath) {
      bytesDigest =
        sourceHashes.get(input.sourcePath) ??
        contentDigest(new Uint8Array(await Bun.file(input.sourcePath).arrayBuffer()));
      sourceHashes.set(input.sourcePath, bytesDigest);
    }
    sources.push({
      cutIndex: input.cut.index,
      sourceDigest: input.sourceDigest,
      bytesDigest,
      cleanClip: input.cleanClip ?? false,
    });
  }
  const font = resolveFont();
  return contentDigest(
    JSON.stringify({
      version: 1,
      timeline,
      sources,
      profile,
      themeVersion: THEME_VERSION,
      theme: THEME,
      font: font ? fontDigest(font) : null,
      framing: "segment-clean1",
    }),
  );
}

async function readSidecar(assets: Artifacts, job: Job, number: number): Promise<Sidecar | null> {
  if (!job.artifacts.some((item) => item.name === sidecarName(number))) return null;
  return SidecarSchema.parse(await (await assets.read(job.id, sidecarName(number))).json());
}

export async function applyCalloutOverrides(
  assets: Artifacts,
  job: Job,
  number: number,
  context: CalloutContext,
): Promise<RenderTimeline> {
  const saved = await readSidecar(assets, job, number);
  const trusted = saved?.fingerprint === context.fingerprint ? saved.callouts : [];
  if (!context.timeline.callouts) return context.timeline;
  return {
    ...context.timeline,
    callouts: context.timeline.callouts.map((callout, index) => {
      const { motion: _untrusted, ...base } = callout;
      const motion = trusted.find((item) => item.index === index)?.motion;
      return motion?.verification === "verified" && motion.verifiedSource === context.fingerprint
        ? { ...base, motion }
        : base;
    }),
  };
}

export class CalloutOverrides {
  readonly assets: Artifacts;
  constructor(
    readonly store: JobStore,
    readonly renderer: ContextReader,
  ) {
    this.assets = new Artifacts(store);
  }

  private eligible(id: string, number: number) {
    const job = this.store.get(id);
    const automation = job.automation;
    const final = job.renders.find((item) => item.number === number)?.final;
    if (
      job.status !== "completed" ||
      automation?.status !== "completed" ||
      automation.policy.mode !== "creative" ||
      automation.operation ||
      job.staged ||
      !final
    )
      throw new StudioError(
        "callout_unavailable",
        "완료된 소재 제작 영상에서 설명 도형을 조정할 수 있습니다.",
      );
    if (automation.scopeDigest !== scopeDigest(job, automation.policy))
      throw new StudioError(
        "scope_changed",
        "승인한 제작 범위가 변경되어 설명 도형을 조정할 수 없습니다.",
      );
    return { job, final };
  }

  private async ready(id: string, number: number) {
    const { job, final } = this.eligible(id, number);
    const finalFile = await this.assets.read(id, final.name);
    if (contentDigest(new Uint8Array(await finalFile.arrayBuffer())) !== final.digest)
      throw new StudioError("callout_final_changed", "미리보기 영상이 제작 기록과 다릅니다.");
    return { job, final };
  }

  async view(id: string, number: number): Promise<CalloutOverridesView> {
    const { job, final } = await this.ready(id, number);
    const context = await this.renderer.calloutContext(id, number);
    const saved = await readSidecar(this.assets, job, number);
    const timeline = await applyCalloutOverrides(this.assets, job, number, context);
    return {
      number,
      fingerprint: context.fingerprint,
      durationMs: timeline.durationMs,
      finalUrl: `/api/artifacts/${id}/${final.name}?v=${final.digest}`,
      profile: { width: context.profile.width, height: context.profile.height },
      sidecarStatus: saved
        ? saved.fingerprint === context.fingerprint
          ? "current"
          : "stale"
        : "none",
      callouts: (timeline.callouts ?? []).map((callout, index) => {
        const cut = timeline.cuts.find((item) => item.index === callout.cutIndex);
        if (!cut) throw new StudioError("callout_cut", "설명 도형의 장면을 찾을 수 없습니다.");
        const planned = context.timeline.callouts?.[index]?.motion;
        return {
          ...callout,
          index,
          cutStartMs: cut.startMs,
          cutDurationMs: cut.endMs - cut.startMs,
          motion:
            callout.motion ??
            (planned ? { ...planned, verification: "planned", verifiedSource: undefined } : null),
        };
      }),
    };
  }

  async save(
    id: string,
    number: number,
    edit: CalloutOverridesEdit,
  ): Promise<CalloutOverridesView> {
    await this.ready(id, number);
    const context = await this.renderer.calloutContext(id, number);
    if (edit.fingerprint !== context.fingerprint)
      throw new StudioError(
        "callout_stale",
        "원본 또는 화면 구성이 변경되었습니다. 다시 열어 위치를 확인하세요.",
      );
    const callouts = edit.callouts.map((item) => {
      const original = context.timeline.callouts?.[item.index];
      if (!original || !context.timeline.cuts.some((cut) => cut.index === original.cutIndex))
        throw new StudioError("callout_index", "설명 도형 번호가 유효하지 않습니다.", 400);
      return {
        index: item.index,
        motion: {
          targetId: item.targetId,
          keyframes: item.keyframes,
          verification: "verified" as const,
          verifiedSource: context.fingerprint,
        },
      };
    });
    this.eligible(id, number);
    await saveArtifactOnce(this.assets, id, {
      name: sidecarName(number),
      kind: "json",
      agentId: "production",
      content: JSON.stringify({
        version: 1,
        fingerprint: context.fingerprint,
        updatedAt: new Date().toISOString(),
        callouts,
      } satisfies Sidecar),
    });
    return this.view(id, number);
  }
}
