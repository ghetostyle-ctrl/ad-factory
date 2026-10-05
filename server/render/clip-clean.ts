import { z } from "zod";
import type { FfmpegRunner } from "./ffmpeg";

// Flow(웹) 다운로드 클립 정리: 시작 이미지가 9:16이 아니면 Veo가 위아래 검은 띠를 굽고,
// Pro 요금제 다운로드는 오른쪽 아래에 "Veo" 워터마크가 보인다. 조립 전에 그 부분을 잘라 쓴다.
export const WATERMARK_TRIM_RATIO = 0.07;
// 검은 띠가 이만큼(원본 높이 대비) 이상이면 워터마크는 띠 안에 있어 따로 자르지 않는다.
const BAR_COVERS_WATERMARK_RATIO = 0.04;

export const ClipCropSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(2),
  h: z.number().int().min(2),
});
export type ClipCrop = z.infer<typeof ClipCropSchema>;

const even = (value: number) => Math.floor(value / 2) * 2;
const evenSize = (value: number) => Math.max(2, even(value));

// cropdetect 로그의 모든 crop=W:H:X:Y 줄에서 값별 중앙값을 읽는다(프레임마다 흔들리는 값을 누르기 위해).
export function parseCropdetect(
  log: string,
): { w: number; h: number; x: number; y: number } | null {
  const rows = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  }));
  if (rows.length === 0) return null;
  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return {
    w: median(rows.map((row) => row.w)),
    h: median(rows.map((row) => row.h)),
    x: median(rows.map((row) => row.x)),
    y: median(rows.map((row) => row.y)),
  };
}

// 검은 띠 제거 영역 + (띠가 워터마크를 덮지 못하면) 아래쪽 워터마크 구간 제거.
export function cleanCrop(
  source: { width: number; height: number },
  detected: { w: number; h: number; x: number; y: number } | null,
  options: { watermark: boolean },
): ClipCrop {
  const box = detected ?? { x: 0, y: 0, w: source.width, h: source.height };
  const bottomBar = source.height - (box.y + box.h);
  let height = box.h;
  if (options.watermark && bottomBar < source.height * BAR_COVERS_WATERMARK_RATIO)
    height -= Math.round(source.height * WATERMARK_TRIM_RATIO);
  return {
    x: Math.min(even(box.x), source.width - 2),
    y: Math.min(even(box.y), source.height - 2),
    w: evenSize(Math.min(box.w, source.width - box.x)),
    h: evenSize(Math.min(height, source.height - box.y)),
  };
}

export function cropFilter(crop: ClipCrop): string {
  return `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
}

// 클립 2~6초 구간을 훑어 검은 띠를 찾는다. Flow 클립의 띠는 순수 검정이 아니라 밝기 25~27 이라 limit 40 이 필요하다(24는 못 찾고 64는 어두운 옷을 깎는다).
export async function detectBars(
  clipPath: string,
  signal: AbortSignal,
  run: FfmpegRunner,
): Promise<{ w: number; h: number; x: number; y: number } | null> {
  const result = await run(
    [
      "-ss",
      "2",
      "-t",
      "4",
      "-i",
      clipPath,
      "-vf",
      "cropdetect=limit=40:round=2:reset=1",
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 60_000 },
  );
  return parseCropdetect(result.stderrTail);
}
