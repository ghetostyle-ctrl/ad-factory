import { afterEach, beforeEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import {
  renderNames,
  renderStateOf,
  saveArtifactOnce,
  scriptDigest,
} from "../server/render-state-helpers";
import { type VoiceManifest, VoiceProduction } from "../server/voice-production";
import { buildTimeline, RenderTimelineSchema, timelineDigest } from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";
import { VideoScriptSchema } from "../shared/video-script";
import { sineWav } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});

async function savedVoice(immersive = true) {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  const base = f.store.get(job.id).videoScripts[0];
  if (!base) throw new Error("fixture script missing");
  const starts = [0, 6, 14];
  const ends = [6, 14, 44];
  const script = VideoScriptSchema.parse({
    ...base,
    durationSec: 44,
    planning: immersive
      ? { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" }
      : fixtureVideoPlanning(),
    cuts: base.cuts.slice(0, 3).map((cut, index) => ({
      ...cut,
      startSec: starts[index] ?? 0,
      endSec: ends[index] ?? 0,
      source: index < 2 ? "veo_clip" : "motion_graphic",
      veoClip: index === 0 ? "A" : index === 1 ? "I1" : "",
      phase: "",
    })),
    voiceover: base.voiceover.slice(0, 3).map((line, index) => ({
      ...line,
      fromCut: index,
      toCut: index,
      startSec: starts[index] ?? 0,
      endSec: ends[index] ?? 0,
    })),
  });
  const digest = scriptDigest(script);
  const manifest: VoiceManifest = {
    number: 1,
    scriptDigest: digest,
    voiceId: "cached-voice",
    selection: "manual",
    lines: script.voiceover.map((line, index) => {
      const durationMs = [3600, 7700, 20000][index] ?? 0;
      return {
        index,
        text: line.text,
        textDigest: sha256Hex(line.text),
        name: renderNames.voice(1, index, 1),
        digest: sha256Hex(sineWav(durationMs)),
        durationMs,
        tempo: 1,
        attempt: 1,
        words: [],
      };
    }),
  };
  for (const line of manifest.lines)
    await saveArtifactOnce(f.production.assets, job.id, {
      name: line.name,
      kind: "audio",
      agentId: "production",
      content: sineWav(line.durationMs),
    });
  await saveArtifactOnce(f.production.assets, job.id, {
    name: renderNames.voiceManifest(1),
    kind: "json",
    agentId: "production",
    content: JSON.stringify(manifest),
  });
  // Reproduce a schedule saved before silence trimming: every cut keeps its scripted length (44s).
  const built = buildTimeline(
    script,
    manifest.lines.map((line) => ({
      ...line,
      artifactName: line.name,
    })),
  );
  if (!("timeline" in built)) throw new Error("fixture timeline missing");
  await saveArtifactOnce(f.production.assets, job.id, {
    name: renderNames.timeline(1),
    kind: "json",
    agentId: "production",
    content: JSON.stringify(built.timeline),
  });
  f.store.change(job.id, (draft) => {
    draft.videoScripts = [script];
    const render = renderStateOf(draft, 1, digest);
    render.scriptDigest = digest;
    render.voice = {
      manifestName: renderNames.voiceManifest(1),
      voiceId: manifest.voiceId,
      timelineDigest: timelineDigest(built.timeline),
    };
  });
  return { id: job.id, script, manifest, stale: built.timeline };
}

const readTimeline = async (id: string) =>
  RenderTimelineSchema.parse(
    await (await f.production.assets.read(id, renderNames.timeline(1))).json(),
  );
const readText = async (id: string, name: string) =>
  (await f.production.assets.read(id, name)).text();
const noVoiceCalls = () =>
  new VoiceProduction(f.store, async () => {
    throw new Error("cached narration must never call the provider");
  });

test("an unfinished immersive render refreshes its timeline from cached voice without synthesis", async () => {
  // Given
  const { id, stale, manifest } = await savedVoice();
  expect(stale.cuts[0]?.endMs).toBe(6000);
  expect(stale.durationMs).toBe(44000);
  const beforeManifest = await readText(id, renderNames.voiceManifest(1));
  const names = f.store.get(id).artifacts.map((item) => item.name);
  // When
  await noVoiceCalls().run(id, 1, signal());
  // Then: 실사 컷 A 는 말 끝(3.6초) + 0.3초, 8초 통째 설명 컷 I1 은 말(7.7초) + 0.3초 = 8초 그대로(late 단계 표시), 그래픽은 말 끝 + 0.3초.
  const actual = await readTimeline(id);
  expect(actual.cuts[0]?.endMs).toBe(3900);
  expect(actual.cuts[1]?.endMs).toBe(11900);
  expect(actual.cuts[1]?.phase).toBe("late");
  expect(actual.cuts[1]?.sourceRef).toEqual({ kind: "veo", clipId: "I1", offsetMs: 0, padMs: 0 });
  expect(actual.voice[1]?.startMs).toBe(3900);
  expect(actual.durationMs).toBe(32200);
  expect(actual.warnings.some((warning) => warning.includes("8초 통째"))).toBe(true);
  expect(f.store.get(id).renders[0]?.voice?.timelineDigest).toBe(timelineDigest(actual));
  expect(await readText(id, renderNames.voiceManifest(1))).toBe(beforeManifest);
  expect(f.store.get(id).artifacts.map((item) => item.name)).toEqual(names);
  for (const line of manifest.lines)
    expect(
      sha256Hex(
        new Uint8Array(await (await f.production.assets.read(id, line.name)).arrayBuffer()),
      ),
    ).toBe(line.digest);
});

test.each(["legacy", "final state", "final artifact"])(
  "a cached %s render keeps its original timeline",
  async (mode) => {
    // Given
    const { id } = await savedVoice(mode !== "legacy");
    if (mode === "final state")
      f.store.change(id, (draft) => {
        renderStateOf(draft, 1).final = {
          name: renderNames.final(1),
          digest: "finished",
          durationMs: 32200,
          bgmTrackId: null,
        };
      });
    if (mode === "final artifact")
      await saveArtifactOnce(f.production.assets, id, {
        name: renderNames.final(1),
        kind: "video",
        agentId: "production",
        content: "finished",
      });
    const before = await readText(id, renderNames.timeline(1));
    const state = f.store.get(id);
    // When
    await noVoiceCalls().run(id, 1, signal());
    // Then
    expect(await readText(id, renderNames.timeline(1))).toBe(before);
    expect(f.store.get(id)).toEqual(state);
  },
);

test("saved caption key order does not falsely report timeline tampering", async () => {
  const { id, stale } = await savedVoice();
  if (!stale.captions?.length) throw new TypeError("caption fixture missing");
  const stored = {
    ...stale,
    captions: stale.captions.map((caption) =>
      Object.fromEntries(Object.entries(caption).reverse()),
    ),
  };
  const content = JSON.stringify(stored);
  await saveArtifactOnce(f.production.assets, id, {
    name: renderNames.timeline(1),
    kind: "json",
    agentId: "production",
    content,
  });
  f.store.change(id, (draft) => {
    const voice = renderStateOf(draft, 1).voice;
    if (!voice) throw new TypeError("voice fixture missing");
    voice.timelineDigest = sha256Hex(content);
  });
  const manifest = await readText(id, renderNames.voiceManifest(1));
  await noVoiceCalls().run(id, 1, signal());
  expect(f.store.get(id).renders[0]?.voice?.timelineDigest).toBe(
    timelineDigest(await readTimeline(id)),
  );
  expect(await readText(id, renderNames.voiceManifest(1))).toBe(manifest);
});
test("modified timeline values remain blocked before cached narration is reused", async () => {
  const { id, stale } = await savedVoice();
  await saveArtifactOnce(f.production.assets, id, {
    name: renderNames.timeline(1),
    kind: "json",
    agentId: "production",
    content: JSON.stringify({ ...stale, durationMs: stale.durationMs + 1 }),
  });
  await expect(noVoiceCalls().run(id, 1, signal())).rejects.toThrow("타임라인 파일이 변경");
});
