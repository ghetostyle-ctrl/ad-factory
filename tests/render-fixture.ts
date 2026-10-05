import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderProfile } from "../server/render/theme";
import {
  type FlatScript,
  type StillId,
  type VideoScript,
  videoScriptFromFlat,
} from "../shared/video-script";
import { fixtureVoiceover } from "./video-script-fixture";

// 렌더 테스트 공용 픽스처: ffmpeg lavfi 로 아주 작은 미디어를 만들고(유료 호출 0),
// 소스 6종(정지 이미지 포함)·효과 8종·Veo 클립 A~D 를 전부 쓰는 대본을 제공한다.
export const renderProfile: RenderProfile = { width: 108, height: 192, fps: 10 };

function ffmpeg(args: readonly string[]): void {
  const output = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (output.exitCode !== 0)
    throw new Error(`fixture ffmpeg failed: ${output.stderr.toString().slice(-500)}`);
}
const size = `${renderProfile.width}x${renderProfile.height}`;

// 108x192 무음 클립(기본 8초, Veo 클립 대역)
export function tinyClip(path: string, sec = 8, color = "blue"): string {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:r=${renderProfile.fps}`,
    "-t",
    String(sec),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}
// 가로(192x108) 클립: Flow 업로드 검증("세로가 아님") 테스트용
export function wideClip(path: string, sec = 8): string {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=192x108:r=${renderProfile.fps}`,
    "-t",
    String(sec),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}
// 정사각 스틸(대표 이미지·카드 대역, 블러 패딩 경로를 타게 1:1)
export function tinyStill(path: string, color = "orange"): string {
  ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=96x96:r=1`, "-frames:v", "1", path]);
  return path;
}
// 내레이션 대역: 44.1kHz mono 사인파 wav
export function toneWav(path: string, sec: number, hz = 440): string {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${hz}:sample_rate=44100`,
    "-t",
    String(sec),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    path,
  ]);
  return path;
}
// BGM 대역: 스테레오 핑크 노이즈 wav
export function noiseBgm(path: string, sec: number): string {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=pink:sample_rate=44100:amplitude=0.3",
    "-t",
    String(sec),
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    path,
  ]);
  return path;
}
// 촬영본 대역: 오디오(220Hz) 포함 3초 mp4
export function projectClip(path: string, sec = 3, color = "green"): string {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:r=${renderProfile.fps}`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=44100",
    "-t",
    String(sec),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);
  return path;
}

// 순수 JS 로 만든 PCM16 mono 사인파 WAV(HTTP 픽스처가 Typecast 응답으로 돌려준다; ffmpeg 호출 없음)
export function sineWav(durationMs: number, hz = 440, sampleRate = 44100): Uint8Array {
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++)
    view.setInt16(
      44 + index * 2,
      Math.round(Math.sin((2 * Math.PI * hz * index) / sampleRate) * 0.3 * 32767),
      true,
    );
  return new Uint8Array(buffer);
}

type Plan = {
  readonly source: FlatScript["cuts"][number]["source"];
  readonly effect: FlatScript["cuts"][number]["effect"];
  readonly veoClip?: "A" | "B" | "C" | "D";
  readonly stillId?: StillId;
  readonly graphicKind?: FlatScript["cuts"][number]["graphicKind"];
  readonly graphicLines?: readonly string[];
  readonly onScreenText?: string;
  readonly screenComposition?: string;
};
// 컷 0~23(36초 기준). 효과 8종 전부, 소스 6종 전부, 클립 A~D 각각 8초 이하(Veo 15초=42%),
// 정지 이미지 S1(4초)·S2(3초) 각각 4초 이하, 모션그래픽 7초(19%).
const plan: readonly Plan[] = [
  { source: "veo_clip", effect: "hard_cut", veoClip: "A", onScreenText: "이런 분 주목" },
  { source: "veo_clip", effect: "zoom_punch", veoClip: "A" },
  {
    source: "project_clip",
    effect: "whip_pan",
    screenComposition: "촬영본 Opening scene 손 클로즈업",
  },
  {
    source: "motion_graphic",
    effect: "text_pop",
    graphicKind: "number",
    graphicLines: ["600mg", "하루 한 번"],
    onScreenText: "600mg\n하루 한 번",
  },
  { source: "approved_image", effect: "split_screen" },
  { source: "card_slide", effect: "speed_ramp" },
  { source: "veo_clip", effect: "shake", veoClip: "B" },
  { source: "veo_clip", effect: "freeze_frame", veoClip: "B" },
  {
    source: "motion_graphic",
    effect: "hard_cut",
    graphicKind: "checklist",
    graphicLines: ["무설탕", "국내 생산", "1일 1포"],
  },
  { source: "card_slide", effect: "zoom_punch" },
  { source: "veo_clip", effect: "text_pop", veoClip: "C", onScreenText: "핵심은 이것" },
  { source: "veo_clip", effect: "hard_cut", veoClip: "C" },
  {
    source: "still_image",
    effect: "whip_pan",
    stillId: "S1",
    screenComposition: "주방 조리대 와이드",
  },
  {
    source: "motion_graphic",
    // 직전 컷에 기대는 효과를 가진 모션그래픽도 graphics 단계 segment 를 그대로 찾아야 한다.
    effect: "split_screen",
    graphicKind: "compare",
    graphicLines: ["기존", "우리"],
  },
  { source: "veo_clip", effect: "zoom_punch", veoClip: "D" },
  { source: "veo_clip", effect: "hard_cut", veoClip: "D" },
  {
    source: "still_image",
    effect: "text_pop",
    stillId: "S1",
    onScreenText: "지금 확인",
    screenComposition: "주방 조리대 왼쪽 클로즈업",
  },
  {
    source: "motion_graphic",
    effect: "hard_cut",
    graphicKind: "question",
    graphicLines: ["왜 매번 실패할까?"],
  },
  { source: "veo_clip", effect: "shake", veoClip: "A" },
  { source: "still_image", effect: "hard_cut", stillId: "S2", screenComposition: "아침 창가" },
  {
    source: "motion_graphic",
    effect: "zoom_punch",
    graphicKind: "callout",
    graphicLines: ["오늘만", "무료 배송"],
  },
  { source: "veo_clip", effect: "hard_cut", veoClip: "B" },
  {
    source: "still_image",
    effect: "text_pop",
    stillId: "S2",
    onScreenText: "링크는 아래",
    screenComposition: "아침 창가 오른쪽 빛",
  },
  { source: "approved_image", effect: "hard_cut" },
];
// 24컷을 넘는 긴 영상은 대표 이미지 컷과 정지 이미지 컷(두 컷마다 새 이미지 S3..)을 효과를 번갈아 가며 덧붙인다.
const fillerEffects = ["hard_cut", "zoom_punch", "hard_cut", "text_pop"] as const;
function fillerAt(k: number): Plan {
  const effect = fillerEffects[k % fillerEffects.length] ?? "hard_cut";
  if (k % 2 === 0) return { source: "approved_image", effect };
  const stillId = `S${3 + Math.floor((k - 1) / 4)}` as StillId;
  return {
    source: "still_image",
    effect,
    stillId,
    screenComposition: `정지 이미지 ${stillId} 장면`,
  };
}

// longVideoScript 를 넓힌 렌더용 대본. durationSec 30~60(기본 36). 컷은 2초·1초 교대.
export function renderScript(number: number, hypothesisId: string, durationSec = 36): VideoScript {
  const lengths: number[] = [];
  let left = durationSec;
  while (left > 0) {
    const length = Math.min(lengths.length % 2 === 0 ? 2 : 1, left);
    lengths.push(length);
    left -= length;
  }
  let start = 0;
  let rehooked = false;
  const cuts = lengths.map((length, index) => {
    const at = start / durationSec;
    const purpose =
      index === lengths.length - 1
        ? "cta"
        : at < 0.1
          ? "hook"
          : at < 0.25
            ? "pain"
            : at < 0.35
              ? "story"
              : !rehooked
                ? "rehook"
                : at < 0.6
                  ? "mechanism"
                  : "proof";
    if (purpose === "rehook") rehooked = true;
    const item =
      index === lengths.length - 1
        ? { source: "approved_image" as const, effect: "hard_cut" as const }
        : (plan[index] ?? fillerAt(index - plan.length));
    if (!item) throw new RangeError("fixture plan is empty");
    const cut: FlatScript["cuts"][number] = {
      startSec: start,
      endSec: start + length,
      purpose,
      screenComposition: item.screenComposition ?? `장면 ${index + 1}`,
      onScreenText: item.onScreenText ?? "",
      source: item.source,
      effect: item.effect,
      veoClip: item.veoClip ?? "",
      stillId: item.stillId ?? "",
      graphicKind: item.graphicKind ?? "",
      graphicLines: [...(item.graphicLines ?? [])],
    };
    start += length;
    return cut;
  });
  // 컷이 실제로 쓰는 정지 이미지만 선언한다(선언만 하고 쓰지 않으면 대본 검사가 거부한다).
  const stillIds = [...new Set(cuts.map((cut) => cut.stillId).filter((id) => id !== ""))];
  // 음성 트랙은 컷에 묶는다(같은 목적의 컷 2개씩, 자막 숫자는 문장이 말한다). 문장은 서로 다르다.
  return videoScriptFromFlat({
    number,
    hypothesisId,
    title: `렌더 영상 ${number} 대본`,
    durationSec,
    openLoop: "왜 매번 작심삼일일까?",
    payoffSec: Math.ceil(durationSec * 0.7),
    cuts,
    voiceover: fixtureVoiceover(cuts),
    styleAnchor: "Same woman in her 30s, navy blouse, bright kitchen, warm morning light.",
    veoClips: (["A", "B", "C", "D"] as const).map((id) => ({
      id,
      startImagePrompt: `Start frame ${id}: the woman at the kitchen table, portrait.`,
      prompt: `Clip ${id}: portrait product scene, no people talking.`,
    })),
    stills: stillIds.map((id) => ({
      id,
      prompt: `Still ${id}: photographic portrait still of the kitchen, soft morning light, no text.`,
    })),
    flowPrompt: `Flow shot ${number}`,
    editInstructions: "자막은 말보다 조금 먼저 띄운다.",
  });
}

export async function renderTemp(prefix = "studio-render-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
export async function removeTemp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
