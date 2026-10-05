import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { measureLoudness, measureRms, parseLoudness } from "../server/audio-probe";
import { buildAudioGraph, MIX } from "../server/render/audio-mix";
import { runFfmpeg, writeFilterGraph } from "../server/render/ffmpeg";
import { noiseBgm, removeTemp, renderTemp, toneWav } from "./render-fixture";

// 말소리(sine 440Hz 2초, 1.0~3.0초) + BGM(핑크 노이즈 6초) + 촬영본 keep(220Hz) 믹스를 실측한다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 오디오 믹스 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
let root = "";
beforeAll(async () => {
  root = await renderTemp("studio-audio-");
});
afterAll(async () => {
  await removeTemp(root);
});
const D = 6000;
async function mix(output: "mix" | "bed", withBgm: boolean, out: string) {
  const voice = toneWav(join(root, "voice.wav"), 2, 440);
  const bgm = noiseBgm(join(root, "bgm.wav"), 6);
  const project = toneWav(join(root, "project.wav"), 1, 220);
  const args = ["-i", voice];
  let index = 0;
  const voices = [{ index: index++, startMs: 1000 }];
  let bgmInput: { index: number } | null = null;
  if (withBgm) {
    args.push("-stream_loop", "-1", "-i", bgm);
    bgmInput = { index: index++ };
  }
  args.push("-i", project);
  const projects = [{ index: index++, startMs: 4500 }];
  args.push("-f", "lavfi", "-t", "6", "-i", "anullsrc=r=48000:cl=stereo");
  const silence = { index: index++ };
  const graph = buildAudioGraph(
    { voice: voices, bgm: bgmInput, project: projects, silence, durationMs: D },
    { output },
  );
  const graphPath = await writeFilterGraph(root, graph);
  await runFfmpeg(
    [...args, "-/filter_complex", graphPath, "-map", "[aout]", "-c:a", "pcm_s16le", "-t", "6", out],
    {
      signal: signal(),
      timeoutMs: 120_000,
    },
  );
  return out;
}

test("graph text places voices with adelay, ducks the bed with the voice key and masters with loudnorm", () => {
  const graph = buildAudioGraph({
    voice: [
      { index: 1, startMs: 1000 },
      { index: 2, startMs: 3500 },
    ],
    bgm: { index: 3 },
    project: [{ index: 4, startMs: 4500 }],
    silence: { index: 5 },
    durationMs: 6000,
  });
  expect(graph).toContain(
    "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=1000:all=1[v0]",
  );
  expect(graph).toContain(
    "[2:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=3500:all=1[v1]",
  );
  expect(graph).toContain(
    "[v0][v1][vs]amix=inputs=3:duration=longest:normalize=0,apad=whole_dur=6.000,atrim=0:6.000,asetpts=PTS-STARTPTS,asplit=2[voice][sc]",
  );
  expect(graph).toContain(
    `volume=${MIX.bgmGainDb}dB,afade=t=in:d=0.800,afade=t=out:st=4.500:d=1.500[bg]`,
  );
  expect(graph).toContain(
    "[4:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=4500:all=1,volume=-6dB[p0]",
  );
  expect(graph).toContain("[bg][p0]amix=inputs=2:duration=first:normalize=0[bed]");
  expect(graph).toContain(
    "[bed][sc]sidechaincompress=threshold=0.01:ratio=20:attack=20:release=500[duck]",
  );
  expect(graph).toContain(
    "[voice][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11[aout]",
  );
  const plain = buildAudioGraph({
    voice: [],
    bgm: null,
    project: [],
    silence: { index: 1 },
    durationMs: 1000,
  });
  expect(plain).toContain("[vs]amix=inputs=1");
  expect(plain).toContain("[voice]alimiter=limit=0.95,loudnorm");
  expect(plain).not.toContain("asplit");
});
test("parseLoudness reads the ebur128 summary", () => {
  const summary =
    "[Parsed_ebur128_0 @ x] Summary:\n\n  Integrated loudness:\n    I:         -14.3 LUFS\n    Threshold: -24.6 LUFS\n\n  Loudness range:\n    LRA:         3.2 LU\n    Threshold: -34.6 LUFS\n\n  True peak:\n    Peak:       -1.6 dBFS\n";
  expect(parseLoudness(summary)).toEqual({ integratedLufs: -14.3, truePeakDb: -1.6, lra: 3.2 });
});
test.skipIf(!hasFfmpeg)(
  "the bed is at least 10 dB quieter under speech than in the gap, and the mix lands in range",
  async () => {
    const bed = await mix("bed", true, join(root, "bed.wav"));
    // 말 구간 1.2~2.8초 vs 공백 구간 3.3~4.3초(페이드·촬영본 전)
    const underSpeech = await measureRms(bed, signal(), { fromMs: 1200, toMs: 2800 });
    const inGap = await measureRms(bed, signal(), { fromMs: 3300, toMs: 4300 });
    expect(inGap - underSpeech).toBeGreaterThanOrEqual(10);
    const full = await mix("mix", true, join(root, "mix.wav"));
    const loudness = await measureLoudness(full, signal());
    expect(loudness.integratedLufs).toBeGreaterThanOrEqual(MIX.verify.minLufs);
    expect(loudness.integratedLufs).toBeLessThanOrEqual(MIX.verify.maxLufs);
    expect(loudness.truePeakDb).toBeLessThanOrEqual(MIX.verify.maxTruePeakDb);
    // 페이드아웃 끝(마지막 0.2초)은 거의 무음
    const tail = await measureRms(full, signal(), { fromMs: 5800, toMs: 6000 });
    expect(tail).toBeLessThanOrEqual(-40);
    const dry = await mix("mix", false, join(root, "dry.wav"));
    const dryLoudness = await measureLoudness(dry, signal());
    expect(dryLoudness.integratedLufs).toBeGreaterThanOrEqual(MIX.verify.minLufs - 1);
    expect(dryLoudness.truePeakDb).toBeLessThanOrEqual(MIX.verify.maxTruePeakDb);
  },
  120_000,
);
