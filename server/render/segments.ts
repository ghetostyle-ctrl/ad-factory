import type { z } from "zod";
import type { TimelineCut } from "../../shared/render-timeline";
import { sha256Hex } from "../../shared/sha256";
import type { CutEffectSchema } from "../../shared/video-script";
import { type RenderProfile, THEME } from "./theme";

// 컷 1개 = ffmpeg 프로세스 1개 = 무음 세그먼트. 여기서는 인자 배열만 만든다(문자열 테스트 가능, 실행은 호출자).
type CutEffect = z.infer<typeof CutEffectSchema>;
export type SegmentExtras = {
  readonly artworkTop?: number;
  // whip_pan: 직전 세그먼트 마지막 프레임 PNG. split_screen: 직전 세그먼트 mp4(없으면 still 또는 자기 반전).
  readonly prevFrame?: string;
  readonly prevSegment?: string;
  readonly still?: string;
  // Flow 클립의 검은 띠·워터마크를 잘라낼 영역(조립 전 정리). veo 컷에서만 쓴다.
  readonly clipCrop?: string;
  // zoom_punch 의 펀치인 시점(컷 시작 기준 ms, R8). 세그먼트 빌더가 타임라인 컷의 punchMs 를 채운다. 없으면 0(컷 시작).
  readonly punchMs?: number;
};
export const FREEZE_TAIL_MS = 600;
export const SPEED_RAMP_READ_FACTOR = 1.05;
const sec = (ms: number) => (ms / 1000).toFixed(3);
// 1080 기준 px 를 프로파일 비례로
const px = (profile: RenderProfile, base: number) =>
  Math.max(1, Math.round((base * profile.height) / 1920));
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

// 모든 소스를 같은 규격으로: 채우기 스케일→크롭→fps→SAR 1
export function normalizeChain(profile: RenderProfile): string {
  const { width, height, fps } = profile;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1`;
}
export function stillChain(
  profile: RenderProfile,
  _zoom: "in" | "out",
  artworkTop: number = THEME.artwork.top,
): string {
  const { width, height, fps } = profile;
  const artworkWidth = even(width * (1 - THEME.safe.side * 2));
  const artworkHeight = even(height * (THEME.artwork.bottom - artworkTop));
  const artworkCenter = Math.round((height * (artworkTop + THEME.artwork.bottom)) / 2);
  return [
    "split[bg][fg]",
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${Math.max(2, px(profile, 24))},eq=brightness=-0.15[b]`,
    `[fg]scale=${artworkWidth}:${artworkHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2[f]`,
    `[b][f]overlay=(W-w)/2:${artworkCenter}-h/2,fps=${fps},setsar=1`,
  ].join(";");
}
// AI 정지 이미지(still_image) 컷의 크롭 창 표: 같은 이미지를 여러 컷이 쓸 때 컷 순서(offsetIndex)대로 돌려 쓴다.
// x·y 는 9:16 창이 이미지 안에서 움직일 수 있는 범위의 비율(0=왼쪽/위, 1=오른쪽/아래), zoom 은 기본 창을 줄이는 배율이다.
// 연속한 컷은 항상 다른 창·반대 줌 방향이라 같은 이미지를 재사용해도 반복처럼 보이지 않는다.
export const STILL_WINDOWS = [
  { name: "center", x: 0.5, y: 0.5, zoom: 1 },
  { name: "left-third", x: 0, y: 0.45, zoom: 1.4 },
  { name: "right-third", x: 1, y: 0.45, zoom: 1.4 },
  { name: "top", x: 0.5, y: 0, zoom: 1.3 },
  { name: "bottom", x: 0.5, y: 1, zoom: 1.3 },
] as const;
export function stillWindow(offsetIndex: number): (typeof STILL_WINDOWS)[number] {
  const index =
    ((offsetIndex % STILL_WINDOWS.length) + STILL_WINDOWS.length) % STILL_WINDOWS.length;
  return STILL_WINDOWS[index] ?? STILL_WINDOWS[0];
}
// 짝수 번째 컷은 줌인, 홀수 번째는 줌아웃.
export function stillZoom(offsetIndex: number): "in" | "out" {
  return offsetIndex % 2 === 0 ? "in" : "out";
}
// AI 정지 이미지: 이미지 안의 9:16 창을 잘라(블러 패딩 없이 화면을 가득 채움) 켄번즈를 건다.
// 켄번즈 속도는 fps 와 무관하게 2초에 15%이다.
export function stillWindowChain(profile: RenderProfile, offsetIndex: number): string {
  const { width, height, fps } = profile;
  const window = stillWindow(offsetIndex);
  const zoom = stillZoom(offsetIndex);
  const step = (0.15 / (fps * 2)).toFixed(5);
  // 필터 식 안의 쉼표는 \, 로 이스케이프한다.
  const comma = "\\,";
  const z = zoom === "in" ? `min(1+${step}*on${comma}1.15)` : `max(1.15-${step}*on${comma}1)`;
  const zoomDiv = window.zoom.toFixed(2);
  return [
    `crop=w='min(iw${comma}ih*9/16)/${zoomDiv}':h='min(iw*16/9${comma}ih)/${zoomDiv}':x='(iw-ow)*${window.x}':y='(ih-oh)*${window.y}'`,
    `scale=${width * 2}:${height * 2}`,
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
    "setsar=1",
  ].join(",");
}
export function segmentEncodeArgs(profile: RenderProfile): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-g",
    String(profile.fps),
    "-keyint_min",
    String(profile.fps),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(profile.fps),
    "-video_track_timescale",
    "30000",
    "-an",
  ];
}
// 효과 → 정규화 뒤에 붙는 필터와 추가 입력. 입력 0 은 소스, 추가 입력은 1부터.
export function effectFilters(
  effect: CutEffect,
  durMs: number,
  profile: RenderProfile,
  extras: SegmentExtras = {},
): { chain: string; inputs: string[] } {
  const { width: W, height: H, fps: F } = profile;
  switch (effect) {
    case "hard_cut":
    case "text_pop":
    case "freeze_frame":
      return { chain: "", inputs: [] };
    case "zoom_punch": {
      // 펀치인 프레임 P(R8): 콜아웃이 있는 컷은 첫 콜아웃 시각까지 1.0 으로 기다렸다가 1.18 로 튀고 3프레임 뒤부터 풀린다.
      const P = Math.max(0, Math.round(((extras.punchMs ?? 0) * F) / 1000));
      return {
        chain: `,scale=${W * 2}:${H * 2},zoompan=z='if(lt(in\\,${P})\\,1\\,if(lt(in\\,${P + 3})\\,1.18\\,max(1\\,1.18-0.02*(in-${P}-3))))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${F}`,
        inputs: [],
      };
    }
    case "whip_pan": {
      const blur = `dblur=angle=0:radius=${px(profile, 24)}:enable='lt(t\\,0.15)'`;
      if (extras.prevFrame)
        return {
          chain: `[cur];[1:v]${normalizeChain(profile)}[prev];[cur][prev]overlay=x='-${W}*min(1\\,t/0.15)':y=0:enable='lt(t\\,0.15)',${blur}`,
          inputs: ["-loop", "1", "-framerate", String(F), "-t", "0.3", "-i", extras.prevFrame],
        };
      return {
        chain: `,scale=${even(W * 1.1)}:${even(H * 1.1)},crop=${W}:${H}:x='${Math.round(W * 0.1)}*max(0\\,1-t/0.15)':y=${Math.round(H * 0.05)},${blur}`,
        inputs: [],
      };
    }
    case "split_screen": {
      const half = even(W / 2);
      const offset = Math.round(W / 4);
      const divider = `drawbox=x=${half - 2}:y=0:w=4:h=${H}:color=white:t=fill`;
      const other = extras.prevSegment ?? extras.still;
      if (other) {
        const isVideo = Boolean(extras.prevSegment);
        return {
          chain: `,crop=${half}:${H}:${offset}:0[l];[1:v]${normalizeChain(profile)},crop=${half}:${H}:${offset}:0[r];[l][r]hstack=inputs=2,${divider}`,
          inputs: isVideo
            ? ["-stream_loop", "-1", "-t", sec(durMs), "-i", other]
            : ["-loop", "1", "-framerate", String(F), "-t", sec(durMs), "-i", other],
        };
      }
      return {
        chain: `,split[a][b];[a]crop=${half}:${H}:${offset}:0[l];[b]crop=${half}:${H}:${offset}:0,hflip[r];[l][r]hstack=inputs=2,${divider}`,
        inputs: [],
      };
    }
    case "speed_ramp": {
      const half = sec(durMs / 2);
      return {
        chain: `,split=2[a][b];[a]trim=0:${half},setpts=(PTS-STARTPTS)*1.6[s];[b]trim=${half}:${sec(durMs * SPEED_RAMP_READ_FACTOR)},setpts=(PTS-STARTPTS)*0.5[f];[s][f]concat=n=2:v=1:a=0,fps=${F}`,
        inputs: [],
      };
    }
    case "shake":
      return {
        chain: `,scale=${even(W * 1.06)}:${even(H * 1.06)},crop=${W}:${H}:x='(iw-${W})/2+${px(profile, 22)}*sin(t*61)':y='(ih-${H})/2+${px(profile, 16)}*cos(t*47)',rgbashift=rh=-${px(profile, 6)}:bh=${px(profile, 6)}:enable='lt(t\\,0.4)'`,
        inputs: [],
      };
    default:
      return effect satisfies never;
  }
}
// zoom_punch 펀치인 시점은 타임라인 컷(punchMs)에서 온다. 호출자가 extras 로 직접 주면 그 값이 우선한다.
function withPunch(cut: Pick<TimelineCut, "punchMs">, extras: SegmentExtras): SegmentExtras {
  return extras.punchMs === undefined && cut.punchMs ? { ...extras, punchMs: cut.punchMs } : extras;
}
// 소스에서 읽을 길이와 뒤에 붙일 정지 길이(ms). 8초 초과분(padMs)과 freeze_frame 꼬리를 합친다.
export function readPlan(
  cut: Pick<TimelineCut, "startMs" | "endMs" | "effect">,
  padMs = 0,
): { readMs: number; tailMs: number } {
  const durMs = cut.endMs - cut.startMs;
  let tailMs = padMs;
  let readMs = durMs - padMs;
  if (cut.effect === "freeze_frame" && readMs > FREEZE_TAIL_MS + 200) {
    readMs -= FREEZE_TAIL_MS;
    tailMs += FREEZE_TAIL_MS;
  }
  if (cut.effect === "speed_ramp") readMs = Math.round(readMs * SPEED_RAMP_READ_FACTOR);
  return { readMs: Math.max(100, readMs), tailMs };
}
function tail(durMs: number, tailMs: number): string {
  const pad = tailMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${sec(tailMs)}` : "";
  // setsar=1: shake·whip_pan 의 1.06/1.1배 확대 스케일은 9:16 이 아니라 SAR 를 4581:4576 처럼 바꾼다. 마지막에 1:1 로 되돌린다.
  return `${pad},trim=duration=${sec(durMs)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[out]`;
}
function assemble(input: {
  readonly inputs: string[];
  readonly graph: string;
  readonly durMs: number;
  readonly profile: RenderProfile;
  readonly out: string;
}): string[] {
  return [
    ...input.inputs,
    "-filter_complex",
    input.graph,
    "-map",
    "[out]",
    ...segmentEncodeArgs(input.profile),
    "-t",
    sec(input.durMs),
    input.out,
  ];
}
// veo_clip 컷: 클립의 offsetMs 부터 읽고 8초를 넘는 부분은 마지막 프레임 복제
export function veoSegmentArgs(
  cut: TimelineCut,
  clipPath: string,
  profile: RenderProfile,
  out: string,
  extras: SegmentExtras = {},
): string[] {
  const durMs = cut.endMs - cut.startMs;
  const ref = cut.sourceRef.kind === "veo" ? cut.sourceRef : { offsetMs: 0, padMs: 0 };
  const plan = readPlan(cut, ref.padMs);
  const effect = effectFilters(cut.effect, durMs, profile, withPunch(cut, extras));
  return assemble({
    inputs: ["-ss", sec(ref.offsetMs), "-t", sec(plan.readMs), "-i", clipPath, ...effect.inputs],
    graph: `[0:v]${extras.clipCrop ? `${extras.clipCrop},` : ""}${normalizeChain(profile)}${effect.chain}${tail(durMs, plan.tailMs)}`,
    durMs,
    profile,
    out,
  });
}
// approved_image / card_slide 는 글자가 포함된 완성 이미지이므로 전체 구도를 보존한다.
export function stillSegmentArgs(
  cut: TimelineCut,
  imagePath: string,
  profile: RenderProfile,
  out: string,
  zoom: "in" | "out",
  extras: SegmentExtras = {},
): string[] {
  const durMs = cut.endMs - cut.startMs;
  return assemble({
    inputs: ["-loop", "1", "-framerate", String(profile.fps), "-t", sec(durMs), "-i", imagePath],
    graph: `[0:v]${stillChain(profile, zoom, extras.artworkTop)}${tail(durMs, 0)}`,
    durMs,
    profile,
    out,
  });
}
// still_image 컷: 정지 이미지를 컷 순서별 크롭 창과 줌 방향으로 보여 준다.
export function aiStillSegmentArgs(
  cut: TimelineCut,
  imagePath: string,
  profile: RenderProfile,
  out: string,
  extras: SegmentExtras = {},
): string[] {
  const durMs = cut.endMs - cut.startMs;
  const offsetIndex = cut.sourceRef.kind === "still" ? cut.sourceRef.offsetIndex : 0;
  const plan = readPlan(cut);
  const effect = effectFilters(cut.effect, durMs, profile, withPunch(cut, extras));
  return assemble({
    inputs: [
      "-loop",
      "1",
      "-framerate",
      String(profile.fps),
      "-t",
      sec(plan.readMs),
      "-i",
      imagePath,
      ...effect.inputs,
    ],
    graph: `[0:v]${stillWindowChain(profile, offsetIndex)}${effect.chain}${tail(durMs, plan.tailMs)}`,
    durMs,
    profile,
    out,
  });
}
// project_clip 컷: 촬영본의 startMs(설정 시작 + 누적) 부터 읽는다. 세그먼트는 항상 무음.
export function projectSegmentArgs(
  cut: TimelineCut,
  assetPath: string,
  profile: RenderProfile,
  out: string,
  extras: SegmentExtras = {},
): string[] {
  const durMs = cut.endMs - cut.startMs;
  const startMs = cut.sourceRef.kind === "project" ? cut.sourceRef.startMs : 0;
  const plan = readPlan(cut);
  const effect = effectFilters(cut.effect, durMs, profile, withPunch(cut, extras));
  return assemble({
    inputs: ["-ss", sec(startMs), "-t", sec(plan.readMs), "-i", assetPath, ...effect.inputs],
    graph: `[0:v]${normalizeChain(profile)}${effect.chain}${tail(durMs, plan.tailMs)}`,
    durMs,
    profile,
    out,
  });
}
// project_clip keep 오디오: 컷 구간만 48kHz 스테레오 wav 로 추출(최종 믹스 입력)
export function projectAudioExtractArgs(
  cut: TimelineCut,
  assetPath: string,
  out: string,
): string[] {
  const durMs = cut.endMs - cut.startMs;
  const startMs = cut.sourceRef.kind === "project" ? cut.sourceRef.startMs : 0;
  return [
    "-ss",
    sec(startMs),
    "-t",
    sec(durMs),
    "-i",
    assetPath,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    out,
  ];
}
// 직전 세그먼트의 마지막 프레임 PNG(whip_pan 입력). 끝에서 1.5프레임 앞을 찾아 마지막 프레임을 받는다.
export function lastFrameArgs(segmentPath: string, out: string, fps = 30): string[] {
  return [
    "-sseof",
    `-${(1.5 / fps).toFixed(3)}`,
    "-i",
    segmentPath,
    "-frames:v",
    "1",
    "-update",
    "1",
    out,
  ];
}
// 세그먼트 캐시 키. cut 에는 펀치인 시점(punchMs)·구간(phase)도 들어 있어 콜아웃 시각이 바뀌면 다시 렌더한다.
export function segmentDigest(input: {
  readonly cut: TimelineCut;
  readonly sourceDigest: string;
  readonly themeVersion: number;
  readonly fontDigest: string;
  readonly profile: RenderProfile;
  readonly prevDigest?: string;
  readonly artworkTop?: number;
}): string {
  return sha256Hex(JSON.stringify(input));
}
