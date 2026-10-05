import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../../shared/sha256";
import { StudioError } from "../errors";
import type { FontSet } from "./fonts";

// 공용 ffmpeg/ffprobe 실행기. 인자는 배열(shell:false)로만 넘기고, 긴 필터 그래프는 파일로 쓴다(Windows 32k 한도).
export type FfmpegRunOptions = {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly cwd?: string;
};
export type FfmpegRunner = (
  args: readonly string[],
  options: FfmpegRunOptions,
) => Promise<{ stderrTail: string }>;
export type FfmpegCapabilities = {
  readonly version: string;
  readonly filters: ReadonlySet<string>;
  readonly encoders: ReadonlySet<string>;
};
const STDERR_TAIL = 2048;

// 테스트가 실행 중 가짜 경로로 바꿀 수 있도록 호출 시점에 읽는다.
export const ffmpegBinary = () => process.env["FFMPEG_PATH"] || "ffmpeg";
export const ffprobeBinary = () => process.env["FFPROBE_PATH"] || "ffprobe";

function unavailable(tool: string): StudioError {
  return new StudioError(
    "render_unavailable",
    `${tool} 를 실행할 수 없습니다. ffmpeg 8.x(libass·libx264 포함)를 설치하거나 FFMPEG_PATH/FFPROBE_PATH 를 확인하세요.`,
    503,
  );
}

type SpawnOptions = FfmpegRunOptions & {
  readonly captureStdout: boolean;
  readonly label: string;
};
type SpawnResult = { stdout: string; stderrTail: string; code: number | null };
// 프로세스 1회 실행. 시간 초과·취소·실행 불가는 던지고, 종료 코드는 그대로 돌려준다.
function spawnOnce(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const abort = () => child.kill();
    options.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 4_000_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.once("error", () => {
      cleanup();
      reject(unavailable(options.label));
    });
    child.once("close", (code) => {
      cleanup();
      if (options.signal.aborted) reject(new DOMException("Cancelled", "AbortError"));
      else if (timedOut)
        reject(
          new StudioError(
            "ffmpeg_timeout",
            `${options.label} 가 ${Math.round(options.timeoutMs / 1000)}초 안에 끝나지 않아 중단했습니다.`,
          ),
        );
      else resolve({ stdout, stderrTail: stderr, code });
    });
    if (options.signal.aborted) abort();
  });
}
// 종료 코드가 null 이면 우리가 죽인 것이 아닌데도 프로세스가 신호로 끝난 것이다(CPU 부하 때 간헐적으로 관측).
// ffmpeg/ffprobe 는 같은 인자로 다시 실행해도 안전하므로(-y 로 덮어쓰기, 읽기 전용 조회) 한 번만 다시 시도한다.
async function spawnTool(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<{ stdout: string; stderrTail: string }> {
  let result = await spawnOnce(command, args, options);
  if (result.code === null) result = await spawnOnce(command, args, options);
  if (result.code !== 0)
    throw new StudioError(
      "ffmpeg_failed",
      `${options.label} 실행 실패(exit ${result.code ?? "?"})${result.stderrTail.trim() ? `: ${result.stderrTail.trim()}` : ""}`,
    );
  return { stdout: result.stdout, stderrTail: result.stderrTail };
}

export const runFfmpeg: FfmpegRunner = async (args, options) => {
  const result = await spawnTool(
    ffmpegBinary(),
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args],
    { ...options, captureStdout: false, label: "ffmpeg" },
  );
  return { stderrTail: result.stderrTail };
};
// info 로그 레벨 실행(ebur128·astats 처럼 결과를 stderr 로 내는 필터용). 진행 통계는 끈다.
export const runFfmpegInfo: FfmpegRunner = async (args, options) => {
  const result = await spawnTool(
    ffmpegBinary(),
    ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", ...args],
    { ...options, captureStdout: false, label: "ffmpeg" },
  );
  return { stderrTail: result.stderrTail };
};

// ffprobe -v error -of json <args> → 파싱한 JSON(검증은 호출자가 zod 로)
export async function runFfprobeJson(
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<unknown> {
  const result = await spawnTool(ffprobeBinary(), ["-v", "error", "-of", "json", ...args], {
    signal,
    timeoutMs,
    captureStdout: true,
    label: "ffprobe",
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new StudioError("ffprobe_output", "ffprobe 출력을 읽을 수 없습니다.");
  }
}

// -filters / -encoders / -version 을 프로세스당 1회 읽어 캐시. 바이너리 경로가 바뀌면 다시 읽는다.
const capabilityCache = new Map<string, Promise<FfmpegCapabilities>>();
let readyBinary: string | null = null;
function parseNames(output: string, pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}
export function ffmpegCapabilities(signal?: AbortSignal): Promise<FfmpegCapabilities> {
  const binary = ffmpegBinary();
  const cached = capabilityCache.get(binary);
  if (cached) return cached;
  const probe = (async () => {
    const run = (args: string[]) =>
      spawnTool(binary, ["-hide_banner", ...args], {
        signal: signal ?? new AbortController().signal,
        timeoutMs: 20_000,
        captureStdout: true,
        label: "ffmpeg",
      });
    const [version, filters, encoders] = await Promise.all([
      run(["-version"]),
      run(["-filters"]),
      run(["-encoders"]),
    ]);
    const versionMatch = /ffmpeg version (\S+)/.exec(version.stdout);
    const result: FfmpegCapabilities = {
      version: versionMatch?.[1] ?? "unknown",
      // 필터 목록 줄: " .. ass  V->V  Render ASS subtitles" (플래그 열은 빌드마다 2~3자라 '->' 로 식별)
      filters: parseNames(filters.stdout, /^\s*[A-Z.|]{2,4}\s+([a-z0-9_]+)\s+\S*->\S*/),
      // 인코더 목록 줄: " V....D libx264  libx264 H.264 ..." (플래그 6자 뒤 이름)
      encoders: parseNames(encoders.stdout, /^\s*[A-Z.]{6}\s+([a-z0-9_]+)\s+/),
    };
    readyBinary = binary;
    return result;
  })();
  capabilityCache.set(binary, probe);
  // 실패는 캐시하지 않는다: 설치·경로를 고친 뒤 다음 호출에서 다시 검사한다.
  probe.catch(() => {
    capabilityCache.delete(binary);
    if (readyBinary === binary) readyBinary = null;
  });
  return probe;
}
// 현재 바이너리로 capabilities 가 한 번이라도 성공했는지(동기, configStatus 용)
export function ffmpegReady(): boolean {
  return readyBinary === ffmpegBinary();
}

// 필터 안 경로: 역슬래시→슬래시, 드라이브 콜론 `\:`, 작은따옴표로 감싼다(8.1 win64 실측: 인용 없는 C\: 는 깨짐).
// ffmpeg 는 그래프 문자열(av_get_token) → 필터 옵션 key=value → 값, 이렇게 두 번 다시 파싱한다.
// 경로 안의 `'` 를 셸 관용구 `'\''` 로 쓰면 두 번째 파싱에서 따옴표가 닫히지 않아 뒤의 `:fontsdir=` 까지 삼키므로,
// 두 단계 모두 통과하는 `\'\''` 로 쓴다(앞 인용이 역슬래시를 글자로 둔 채 닫히고, 이스케이프된 `'` 뒤에 인용이 다시 열린다).
// -vf 와 -/filter_complex 양쪽 모두 실제 ass 필터로 확인했다(tests/render-ffmpeg.test.ts).
export function ffPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/'/g, "\\'\\''").replace(/:/g, "\\:");
  return `'${normalized}'`;
}

// libass fontsdir 는 폴더 안 모든 파일을 폰트로 읽으려 해서 라이선스 텍스트가 있으면 컷마다 경고가 난다.
// 그래서 실제로 쓰는 폰트 파일만 담은 전용 폴더(parent/fonts)를 두고 그 경로를 fontsdir 로 쓴다.
// 맑은 고딕 대체 경로(C:/Windows/Fonts 전체)를 통째로 읽는 비용도 함께 피한다. 이미 있고 크기가 같으면 복사하지 않는다.
export async function fontOnlyDir(font: FontSet, parent: string): Promise<string> {
  const dir = join(parent, "fonts");
  await mkdir(dir, { recursive: true });
  for (const name of new Set([font.bold, font.medium])) {
    const source = join(font.dir, name);
    const target = join(dir, name);
    const wanted = (await stat(source)).size;
    const present = await stat(target).then(
      (info) => info.size,
      () => -1,
    );
    if (present === wanted) continue;
    // 동시에 같은 폴더를 준비하는 다른 컷과 부딪히지 않게 임시 이름으로 복사한 뒤 옮긴다.
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await copyFile(source, temp);
    try {
      await rename(temp, target);
    } catch {
      // 다른 프로세스가 먼저 만들어 libass 가 읽는 중이면 옮기지 못한다. 크기가 같으면 그대로 쓴다.
      await rm(temp, { force: true });
    }
  }
  return dir.replace(/\\/g, "/");
}

// 긴 filter_complex 를 파일로 쓴다(UTF-8/LF). 호출: ["-/filter_complex", 반환 경로]
export async function writeFilterGraph(dir: string, graph: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const content = graph.replace(/\r\n/g, "\n");
  const path = join(dir, `graph-${sha256Hex(content).slice(0, 12)}.txt`);
  await Bun.write(path, content);
  return path;
}

// 지정 초의 프레임을 PNG 로 추출(비전 검토용, 긴 변 640). 범위 밖 시각은 건너뛴다.
export async function extractFrames(
  video: string,
  seconds: readonly number[],
  outDir: string,
  signal: AbortSignal,
  run: FfmpegRunner = runFfmpeg,
): Promise<Uint8Array[]> {
  await mkdir(outDir, { recursive: true });
  const frames: Uint8Array[] = [];
  for (const [index, at] of seconds.entries()) {
    const out = join(outDir, `frame-${index}-${String(at).replace(/[^0-9]/g, "_")}.png`);
    await run(["-ss", String(at), "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", out], {
      signal,
      timeoutMs: 60_000,
    });
    const file = Bun.file(out);
    if (await file.exists()) frames.push(new Uint8Array(await file.arrayBuffer()));
  }
  return frames;
}
