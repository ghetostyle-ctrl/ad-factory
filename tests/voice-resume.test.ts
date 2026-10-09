import { afterEach, beforeEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { StudioError } from "../server/errors";
import type { VoiceProvider } from "../server/tts-provider";
import { VoiceManifestSchema, VoiceProduction } from "../server/voice-production";
import { RenderTimelineSchema } from "../shared/render-timeline";
import { sineWav } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

// 내레이션 합성 재개 안전성: 저장된 문장(wav·textDigest·tempo 일치)은 Typecast 재요청 0회, 산출물 이름 중복 없음.
// Typecast 는 전부 스텁(호출 수 기록)이라 실제 과금 0원.
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});
async function readyForVoice() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  return job.id;
}
const realVoice = (): VoiceProvider => {
  const provider = f.providers.voice;
  if (!provider) throw new Error("fixture voice provider missing");
  return provider;
};
// 앞의 limit 번만 성공하고 그 뒤로는 계속 크레딧 부족으로 실패하는 공급자
function failingAfter(limit: number): { provider: VoiceProvider; calls: () => number } {
  let calls = 0;
  const real = realVoice();
  return {
    provider: async (task) => {
      calls++;
      if (calls > limit) throw new StudioError("typecast_credit", "크레딧 부족(스텁)", 409);
      return real(task);
    },
    calls: () => calls,
  };
}
const duplicates = (names: readonly string[]) =>
  names.filter((name, index) => names.indexOf(name) !== index);
const voiceArtifactNames = (id: string) =>
  f.store
    .get(id)
    .artifacts.map((asset) => asset.name)
    .filter((name) => name.startsWith("voice-"));

test("an interrupted synthesis resumes with only the missing sentences and never duplicates artifacts", async () => {
  const id = await readyForVoice();
  const lines = f.store.get(id).videoScripts[0]?.voiceover.length ?? 0;
  expect(lines).toBeGreaterThan(6);
  const flaky = failingAfter(5);
  await expect(
    new VoiceProduction(f.store, flaky.provider).run(id, 1, signal(), { concurrencyLimit: 1 }),
  ).rejects.toMatchObject({ code: "typecast_credit" });
  // 실패한 뒤에는 대기 중이던 문장을 더 요청하지 않는다
  expect(flaky.calls()).toBe(6);
  expect(f.store.get(id).renders[0]?.voiceLines).toHaveLength(5);
  expect(f.store.get(id).renders[0]?.voice).toBeNull();

  const before = f.counts.voice;
  await new VoiceProduction(f.store, realVoice()).run(id, 1, signal(), { concurrencyLimit: 1 });
  // 저장된 5문장은 재요청 0회: 남은 문장만 합성한다
  expect(f.counts.voice - before).toBe(lines - 5);
  const done = f.store.get(id);
  expect(done.renders[0]?.voice?.manifestName).toBe("voice-1.json");
  expect(done.renders[0]?.voiceLines).toEqual([]);
  expect(duplicates(voiceArtifactNames(id))).toEqual([]);
  const manifest = VoiceManifestSchema.parse(
    await (await f.production.assets.read(id, "voice-1.json")).json(),
  );
  expect(manifest.lines).toHaveLength(lines);
  expect(manifest.lines.map((line) => line.index)).toEqual(
    Array.from({ length: lines }, (_, i) => i),
  );
}, 60_000);

test("a fully synthesized video requests nothing on a later run", async () => {
  const id = await readyForVoice();
  const voice = new VoiceProduction(f.store, realVoice());
  await voice.run(id, 1, signal(), { concurrencyLimit: 2 });
  const calls = f.counts.voice;
  await voice.run(id, 1, signal(), { concurrencyLimit: 2 });
  await new VoiceProduction(f.store, realVoice()).run(id, 1, signal());
  expect(f.counts.voice).toBe(calls);
  expect(duplicates(voiceArtifactNames(id))).toEqual([]);
}, 60_000);

test("a changed tempo or a replaced wav is synthesized again without a second artifact entry", async () => {
  const id = await readyForVoice();
  const lines = f.store.get(id).videoScripts[0]?.voiceover.length ?? 0;
  const flaky = failingAfter(lines - 1);
  await expect(
    new VoiceProduction(f.store, flaky.provider).run(id, 1, signal(), { concurrencyLimit: 1 }),
  ).rejects.toMatchObject({ code: "typecast_credit" });
  expect(f.store.get(id).renders[0]?.voiceLines).toHaveLength(lines - 1);
  // 0번 문장은 템포가 달라졌고, 1번 문장의 wav 는 바뀌었다 → 이 둘과 못 만든 마지막 문장만 다시 합성
  f.store.change(id, (draft) => {
    const first = draft.renders[0]?.voiceLines.find((line) => line.index === 0);
    if (first) first.tempo = first.tempo + 0.1;
  });
  await Bun.write(f.production.assets.path(id, "voice-1-02-1.wav"), "replaced");
  const before = f.counts.voice;
  await new VoiceProduction(f.store, realVoice()).run(id, 1, signal(), { concurrencyLimit: 1 });
  expect(f.counts.voice - before).toBe(3);
  expect(duplicates(voiceArtifactNames(id))).toEqual([]);
  expect(f.store.get(id).renders[0]?.voice).not.toBeNull();
}, 60_000);

test("tempo resynthesis (attempt 2) lines are reused after an interruption in the second round", async () => {
  f.control.durationScale = 1.15;
  const id = await readyForVoice();
  const lines = f.store.get(id).videoScripts[0]?.voiceover.length ?? 0;
  const real = realVoice();
  let slowCalls = 0;
  // 템포 재합성(tempo > 1)부터 실패시킨다: 1차 합성은 모두 저장된다
  const provider: VoiceProvider = async (task) => {
    if (task.tempo > 1) {
      slowCalls++;
      throw new StudioError("typecast_credit", "크레딧 부족(스텁)", 409);
    }
    return real(task);
  };
  await expect(
    new VoiceProduction(f.store, provider).run(id, 1, signal(), { concurrencyLimit: 1 }),
  ).rejects.toMatchObject({ code: "typecast_credit" });
  expect(slowCalls).toBeGreaterThan(0);
  expect(f.store.get(id).renders[0]?.voiceLines).toHaveLength(lines);
  const before = f.counts.voice;
  await new VoiceProduction(f.store, real).run(id, 1, signal(), { concurrencyLimit: 1 });
  const resynthesized = f.counts.voice - before;
  // 1차 문장은 재요청 0회, 템포 재합성이 필요한 문장만 다시 요청한다
  expect(resynthesized).toBeGreaterThan(0);
  expect(resynthesized).toBeLessThanOrEqual(lines);
  expect(duplicates(voiceArtifactNames(id))).toEqual([]);
  const manifest = VoiceManifestSchema.parse(
    await (await f.production.assets.read(id, "voice-1.json")).json(),
  );
  expect(manifest.lines.some((line) => line.attempt === 2)).toBe(true);
  // 이미 저장된 템포 재합성 문장은 한 번 더 이어서 재개해도 0회
  const settled = f.counts.voice;
  await new VoiceProduction(f.store, real).run(id, 1, signal());
  expect(f.counts.voice).toBe(settled);
}, 60_000);

test("a new immersive script keeps the chosen speaking tempo and extends its own scene", async () => {
  // Given
  const id = await readyForVoice();
  f.store.change(id, (draft) => {
    const script = draft.videoScripts[0];
    if (!script) throw new Error("fixture script missing");
    script.planning = { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" };
  });
  const script = f.store.get(id).videoScripts[0];
  if (!script) throw new Error("fixture script missing");
  const firstText = script.voiceover[0]?.text;
  const tempos: number[] = [];
  const provider: VoiceProvider = async (task) => {
    tempos.push(task.tempo);
    const durationMs = task.text === firstText ? 4000 : 300;
    return {
      value: { audio: sineWav(durationMs), durationMs, words: [] },
      model: {
        provider: "typecast",
        requestedModel: "fixture",
        effectiveModel: "fixture",
        quality: null,
      },
    };
  };
  // When
  await new VoiceProduction(f.store, provider).run(id, 1, signal());
  // Then
  expect(tempos).toEqual(script.voiceover.map(() => 1));
  const timeline = RenderTimelineSchema.parse(
    await (await f.production.assets.read(id, "timeline-1.json")).json(),
  );
  const first = script.voiceover[0];
  if (!first) throw new Error("fixture first line missing");
  expect(timeline.cuts[first.toCut]?.endMs ?? 0).toBeGreaterThanOrEqual(4000);
  expect(timeline.visualPolicy).toBe("immersive_explanations_v1");
  expect(timeline.cuts.every((cut) => cut.visualPolicy === timeline.visualPolicy)).toBe(true);
  const manifest = VoiceManifestSchema.parse(
    await (await f.production.assets.read(id, "voice-1.json")).json(),
  );
  expect(manifest.lines.every((line) => line.attempt === 1)).toBe(true);
  // A completed saved timeline remains reusable without synthesis.
  await new VoiceProduction(f.store, provider).run(id, 1, signal());
  expect(tempos).toHaveLength(script.voiceover.length);
}, 60_000);
