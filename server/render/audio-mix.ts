// 오디오 믹스 상수·그래프. 수치는 서버 상수(scopeDigest 밖)라 코드로만 조정한다.
// 내레이션은 Typecast target_lufs -16 으로 균일, BGM 은 -14dB 선감쇠 + 내레이션 키 사이드체인 덕킹 + 페이드,
// 촬영본 keep 오디오(-6dB)도 같은 bed 에 섞여 함께 덕킹된다. 마지막에 리미터 → loudnorm(동적 모드).
export const MIX = {
  bgmGainDb: -14,
  // lavfi 실측(sine -13.5dBFS 키·핑크 노이즈 bed): 0.03/12 는 약 8dB, 0.01/20 은 약 16dB 덕킹.
  duck: { threshold: 0.01, ratio: 20, attackMs: 20, releaseMs: 500 },
  projectGainDb: -6,
  fadeInMs: 800,
  fadeOutMs: 1500,
  loudnorm: { I: -14, TP: -1.5, LRA: 11 },
  limiter: 0.95,
  // 완성본 검증 범위(통합 라우드니스 LUFS·트루피크 dBTP)
  verify: { minLufs: -16, maxLufs: -12, maxTruePeakDb: -1.0 },
} as const;
const sec = (ms: number) => (ms / 1000).toFixed(3);
const stereo48 = "aformat=sample_rates=48000:channel_layouts=stereo";

export type AudioGraphInput = {
  // ffmpeg 입력 번호와 배치 시각
  readonly voice: readonly { readonly index: number; readonly startMs: number }[];
  readonly bgm: { readonly index: number } | null;
  readonly project: readonly { readonly index: number; readonly startMs: number }[];
  // 무음 베이스(anullsrc) 입력 번호: 문장이 0개여도 길이 D 의 음성 버스를 보장한다
  readonly silence: { readonly index: number };
  readonly durationMs: number;
};
// 최종 패스 filter_complex 의 오디오 부분. output 'bed' 는 테스트용(덕킹된 BGM 버스만 내보낸다).
export function buildAudioGraph(
  input: AudioGraphInput,
  options: { readonly output?: "mix" | "bed" } = {},
): string {
  const D = sec(input.durationMs);
  const parts: string[] = [];
  const voiceLabels: string[] = [];
  input.voice.forEach((item, position) => {
    const label = `[v${position}]`;
    parts.push(`[${item.index}:a]${stereo48},adelay=${Math.round(item.startMs)}:all=1${label}`);
    voiceLabels.push(label);
  });
  parts.push(`[${input.silence.index}:a]${stereo48},atrim=0:${D}[vs]`);
  voiceLabels.push("[vs]");
  const hasBed = input.bgm !== null || input.project.length > 0;
  parts.push(
    `${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0,apad=whole_dur=${D},atrim=0:${D},asetpts=PTS-STARTPTS${hasBed ? ",asplit=2[voice][sc]" : "[voice]"}`,
  );
  const master = `alimiter=limit=${MIX.limiter},loudnorm=I=${MIX.loudnorm.I}:TP=${MIX.loudnorm.TP}:LRA=${MIX.loudnorm.LRA}`;
  if (!hasBed) {
    parts.push(`[voice]${master}[aout]`);
    return parts.join(";\n");
  }
  const bedLabels: string[] = [];
  if (input.bgm) {
    const fadeOutStart = Math.max(0, input.durationMs - MIX.fadeOutMs);
    parts.push(
      `[${input.bgm.index}:a]${stereo48},atrim=0:${D},asetpts=PTS-STARTPTS,volume=${MIX.bgmGainDb}dB,afade=t=in:d=${sec(MIX.fadeInMs)},afade=t=out:st=${sec(fadeOutStart)}:d=${sec(MIX.fadeOutMs)}[bg]`,
    );
    bedLabels.push("[bg]");
  }
  input.project.forEach((item, position) => {
    const label = `[p${position}]`;
    parts.push(
      `[${item.index}:a]${stereo48},adelay=${Math.round(item.startMs)}:all=1,volume=${MIX.projectGainDb}dB${label}`,
    );
    bedLabels.push(label);
  });
  if (bedLabels.length === 1) parts.push(`${bedLabels[0]}anull[bed]`);
  else
    parts.push(
      `${bedLabels.join("")}amix=inputs=${bedLabels.length}:duration=first:normalize=0[bed]`,
    );
  parts.push(
    `[bed][sc]sidechaincompress=threshold=${MIX.duck.threshold}:ratio=${MIX.duck.ratio}:attack=${MIX.duck.attackMs}:release=${MIX.duck.releaseMs}[duck]`,
  );
  if (options.output === "bed") {
    parts.push("[duck]anull[aout]", "[voice]anullsink");
    return parts.join(";\n");
  }
  parts.push(`[voice][duck]amix=inputs=2:duration=first:normalize=0,${master}[aout]`);
  return parts.join(";\n");
}
