import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CAPTION_TONES, type CaptionTone } from "../../shared/caption-direction";
import { sha256Hex } from "../../shared/sha256";
import { StudioError } from "../errors";
import { BUNDLED_FONT_DIR, type FontSet } from "./fonts";

const MetricsSchema = z.object({
  file: z.string(),
  family: z.string(),
  sha256: z.string(),
  unitsPerEm: z.number().positive(),
  ascent: z.number().nonnegative(),
  descent: z.number().nonnegative(),
  advances: z.record(z.string(), z.number().nonnegative()),
});
export type FontMetrics = z.infer<typeof MetricsSchema>;
const dir = join(BUNDLED_FONT_DIR, "captions");
let metrics: readonly FontMetrics[] | undefined;
function catalog(): readonly FontMetrics[] {
  if (metrics) return metrics;
  const path = join(dir, "metrics.json");
  if (!existsSync(path))
    throw new StudioError(
      "caption_font_missing",
      "자막 글꼴 자료가 없습니다. 최신 배포본의 assets/fonts를 확인하세요.",
    );
  const parsed = z.array(MetricsSchema).parse(JSON.parse(readFileSync(path, "utf8")));
  for (const font of parsed) {
    const path = join(dir, font.file);
    if (!existsSync(path) || sha256Hex(readFileSync(path)) !== font.sha256)
      throw new StudioError(
        "caption_font_missing",
        `자막 글꼴 ${font.file}이 없거나 원본과 다릅니다. 최신 배포본으로 복원하세요.`,
      );
  }
  metrics = parsed;
  return parsed;
}
export function captionFont(tone: CaptionTone, fallback: FontSet): FontSet {
  const style = CAPTION_TONES[tone];
  if (!style.file) return fallback;
  const measured = catalog().find((font) => font.file === style.file);
  if (!measured)
    throw new StudioError("caption_font_missing", `자막 글꼴 ${style.file}의 측정값이 없습니다.`);
  return {
    dir,
    family: measured.family,
    bold: measured.file,
    medium: measured.file,
    metrics: measured,
  };
}
export function captionFontSupports(font: FontSet, text: string): boolean {
  return (
    !font.metrics ||
    [...text].every(
      (char) =>
        char.trim() === "" || font.metrics?.advances[String(char.codePointAt(0))] !== undefined,
    )
  );
}
export function captionFontScale(font: FontSet): number {
  return font.metrics
    ? (font.metrics.ascent + font.metrics.descent) / font.metrics.unitsPerEm
    : font.family === "Pretendard"
      ? 2444 / 2048
      : 1;
}
export async function copyCaptionFonts(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const font of catalog()) await copyFile(join(dir, font.file), join(target, font.file));
}

export function assertCaptionFonts(): void {
  catalog();
}
