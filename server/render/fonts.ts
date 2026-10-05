import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../shared/sha256";

// 자막·모션그래픽 한글 폰트. fontconfig 이름 조회는 쓰지 않고(이 PC ffmpeg 빌드에 fonts.conf 없음·세그폴트 실측)
// 파일 경로(fontsdir)만 쓴다. 순서: env FONT_DIR → 저장소 assets/fonts(Pretendard, OFL) → Windows 맑은 고딕 → 없음.
export type FontSet = {
  readonly dir: string;
  readonly family: string;
  readonly bold: string;
  readonly medium: string;
};
const PRETENDARD = ["Pretendard-Bold.ttf", "Pretendard-Medium.ttf"] as const;
export const BUNDLED_FONT_DIR = resolve(
  fileURLToPath(new URL("../../assets/fonts/", import.meta.url)),
);
const WINDOWS_FONT_DIR = "C:/Windows/Fonts";

const slash = (value: string) => value.replace(/\\/g, "/");
function pretendardIn(dir: string): FontSet | null {
  const [bold, medium] = PRETENDARD;
  if (!existsSync(join(dir, bold)) || !existsSync(join(dir, medium))) return null;
  return { dir: slash(dir), family: "Pretendard", bold, medium };
}
function malgunIn(dir: string): FontSet | null {
  if (!existsSync(join(dir, "malgunbd.ttf"))) return null;
  return {
    dir: slash(dir),
    family: "Malgun Gothic",
    bold: "malgunbd.ttf",
    medium: existsSync(join(dir, "malgun.ttf")) ? "malgun.ttf" : "malgunbd.ttf",
  };
}
export function resolveFont(): FontSet | null {
  const custom = process.env["FONT_DIR"];
  // FONT_DIR 을 지정했으면 그 폴더만 본다(가짜 폴더면 null → preflight 가 render_unavailable 로 멈춘다).
  if (custom) return pretendardIn(resolve(custom)) ?? malgunIn(resolve(custom));
  return (
    pretendardIn(BUNDLED_FONT_DIR) ??
    (process.platform === "win32" ? malgunIn(WINDOWS_FONT_DIR) : null)
  );
}
// 세그먼트 캐시 무효화용. 폰트 파일 바이트 전체를 해시하지 않고 경로·크기·수정시각으로 만든다.
export function fontDigest(font: FontSet | null = resolveFont()): string {
  if (!font) return "none";
  const parts = [font.family];
  for (const file of [font.bold, font.medium]) {
    const path = join(font.dir, file);
    const stat = statSync(path);
    parts.push(`${slash(path)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return sha256Hex(parts.join("|")).slice(0, 16);
}
