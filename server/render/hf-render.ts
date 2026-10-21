import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import type { HfLabelPlan } from "../../shared/hf-label-plan";
import type { TimelineCut } from "../../shared/render-timeline";
import { sha256Hex } from "../../shared/sha256";
import type { CutMechanism, CutScreen } from "../../shared/video-script";
import { StudioError } from "../errors";
import { type FfmpegRunner, runFfmpeg, runFfprobeJson } from "./ffmpeg";
import { type FontSet, fontDigest } from "./fonts";
import { hfLabelHtml } from "./hf-label-html";
import { layoutHfLabels } from "./hf-label-layout";
import { mechanismHtml, phoneScreenHtml } from "./screens";
import { normalizeChain, segmentEncodeArgs } from "./segments";
import type { RenderProfile } from "./theme";

const require = createRequire(import.meta.url);
// Module lives in server/render: the app root is two directories above it.
const actualCli = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "node_modules/hyperframes/bin/hyperframes.mjs",
);
const Probe = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  format: z.object({ duration: z.string() }),
});
let nodeChecked = false;
export function requireHfRenderer(): void {
  if (!existsSync(actualCli) || !Bun.which("node"))
    throw new StudioError(
      "render_unavailable",
      "HyperFrames가 설치되지 않았습니다. 앱 폴더에서 bun install --frozen-lockfile을 실행하세요.",
      503,
    );
  if (!nodeChecked) {
    const version = spawnSync("node", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const major = Number(/^v([0-9]+)/.exec(version.stdout ?? "")?.[1]);
    if (version.status !== 0 || !Number.isFinite(major) || major < 22)
      throw new StudioError(
        "render_unavailable",
        "HyperFrames 합성에는 Node.js 22 이상이 필요합니다.",
        503,
      );
    nodeChecked = true;
  }
}
export function assertHfReadTime(plan: HfLabelPlan, cuts: readonly TimelineCut[]): void {
  for (const label of plan.labels) {
    const windows = cuts.flatMap((cut) =>
      cut.sourceRef.kind === "veo"
        ? [
            {
              start: cut.sourceRef.offsetMs,
              end: cut.sourceRef.offsetMs + cut.endMs - cut.startMs - cut.sourceRef.padMs,
            },
          ]
        : [],
    );
    const full = Math.max(label.fullSec, label.startSec + AD_EDIT_STYLE.label.growSec) * 1000;
    const visible = windows.reduce(
      (sum, w) =>
        sum + Math.max(0, Math.min(w.end, label.endSec * 1000 - 120) - Math.max(w.start, full)),
      0,
    );
    if (visible < 1000)
      throw new StudioError(
        "hf_label_timing",
        `라벨 ${label.lineIndex + 1}의 완성 문구가 선택한 컷에서 1초 미만 노출됩니다. 원문을 줄이지 말고 컷 구간·라벨 시각을 조정하세요.`,
      );
  }
}
async function executeHf(directory: string, output: string, signal: AbortSignal): Promise<void> {
  requireHfRenderer();
  signal.throwIfAborted();
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(
      "node",
      [
        actualCli,
        "render",
        directory,
        "--output",
        output,
        "--workers",
        "2",
        "--strict",
        "--no-best-effort",
        "--quality",
        "delivery",
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "",
      timedOut = false;
    const append = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-12000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 20 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new StudioError("render_unavailable", `HyperFrames 실행 실패: ${error.message}`, 503));
    });
    child.once("close", (code) => {
      cleanup();
      void writeFile(join(directory, "render.log"), log).then(() => {
        if (signal.aborted) reject(new DOMException("Cancelled", "AbortError"));
        else if (code !== 0 || timedOut)
          reject(
            new StudioError(
              "hf_render",
              `HyperFrames 합성이 완료되지 않았습니다(exit ${code}, 시간 초과 ${timedOut}). ${log.slice(-1800)}`,
            ),
          );
        else resolveDone();
      }, reject);
    });
    if (signal.aborted) stop();
  });
}
export async function renderHfClip(input: {
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly plan: HfLabelPlan;
  readonly infoLines: readonly string[];
  readonly font: FontSet;
  readonly profile: RenderProfile;
  readonly scratch: string;
  readonly signal: AbortSignal;
}): Promise<{ path: string; digest: string }> {
  const labels = layoutHfLabels(input.plan, input.infoLines, input.font);
  const digest = sha256Hex(
    JSON.stringify({
      source: input.sourceDigest,
      plan: input.plan,
      lines: input.infoLines,
      style: AD_EDIT_STYLE,
      font: fontDigest(input.font),
      profile: input.profile,
    }),
  );
  const directory = join(input.scratch, `hf-${digest.slice(0, 16)}`),
    out = join(directory, "labelled.mp4"),
    stamp = join(directory, "complete.json");
  if (existsSync(out) && existsSync(stamp)) {
    const saved = z
      .object({ digest: z.string(), outputDigest: z.string() })
      .parse(JSON.parse(await readFile(stamp, "utf8")));
    if (
      saved.digest === digest &&
      saved.outputDigest === sha256Hex(new Uint8Array(await readFile(out)))
    )
      return { path: out, digest };
  }
  const probe = Probe.parse(
    await runFfprobeJson(
      ["-show_entries", "stream=codec_type,width,height:format=duration", input.sourcePath],
      input.signal,
    ),
  );
  const duration = Number(probe.format.duration),
    video = probe.streams.find((s) => s.codec_type === "video");
  if (!video || !Number.isFinite(duration) || duration <= 0)
    throw new StudioError("hf_source", "라벨 원본 영상 길이·크기를 확인할 수 없습니다.");
  if (input.plan.labels.some((label) => label.endSec > duration + 0.1))
    throw new StudioError(
      "hf_source",
      "라벨 종료 시각보다 원본 영상이 짧습니다. 원본과 라벨 시각을 확인하세요.",
    );
  const assets = join(directory, "assets");
  await mkdir(assets, { recursive: true });
  await Promise.all([
    copyFile(join(input.font.dir, input.font.bold), join(assets, "label-bold.ttf")),
    copyFile(require.resolve("gsap/dist/gsap.min.js"), join(assets, "gsap.min.js")),
  ]);
  await runFfmpeg(
    [
      "-i",
      input.sourcePath,
      "-vf",
      normalizeChain(input.profile),
      ...segmentEncodeArgs(input.profile),
      "-t",
      String(duration),
      join(assets, "source.mp4"),
    ],
    { signal: input.signal, timeoutMs: 120_000 },
  );
  await writeFile(join(directory, "index.html"), hfLabelHtml(labels, duration, input.profile));
  await writeFile(
    join(directory, "label-plan.json"),
    JSON.stringify({ tracking: "planned", labels }, null, 2),
  );
  const partial = join(directory, "rendered.mp4");
  await executeHf(directory, partial, input.signal);
  const rendered = Probe.parse(
    await runFfprobeJson(
      ["-show_entries", "stream=codec_type,width,height:format=duration", partial],
      input.signal,
    ),
  );
  const screen = rendered.streams.find((stream) => stream.codec_type === "video");
  if (
    !screen ||
    screen.width !== input.profile.width ||
    screen.height !== input.profile.height ||
    Math.abs(Number(rendered.format.duration) - duration) > 0.15 ||
    rendered.streams.some((stream) => stream.codec_type === "audio")
  )
    throw new StudioError(
      "hf_render",
      "HyperFrames 결과의 길이·해상도·무음 스트림 검증을 통과하지 못했습니다.",
    );
  await rename(partial, out);
  await writeFile(
    stamp,
    JSON.stringify({ digest, outputDigest: sha256Hex(new Uint8Array(await readFile(out))) }),
  );
  return { path: out, digest };
}

// --- 폰 화면·작용 원리 컷(2026-10-21) ----------------------------------------------------------------------------
// 컷 하나를 HyperFrames 로 1080x1920 컴포지션 길이만큼 렌더한 뒤 ffmpeg 로 세그먼트 규격(프로파일·인코딩)에 맞춘다.
// 작용 원리는 HyperFrames 결과의 위 954px(원리 그래픽) + 12px 검정 띠 + 아래 954px 실사(클립 구간 또는 대표 이미지)를
// ffmpeg vstack 으로 붙인다(HyperFrames 0.8 은 video 의 CSS transform/filter 를 무시하므로 컴포지션 안에 넣지 않는다).
export const SCREEN_RENDER_VERSION = 1;
const MECH_TOP = 954;
const MECH_SEAM = 12;
export type ScreenClipInput = {
  readonly kind: "screen" | "mechanism";
  readonly screen?: CutScreen;
  readonly mechanism?: CutMechanism;
  readonly durationMs: number;
  // 위쪽(작용 원리 배경) 또는 쇼핑·가격 화면의 상품 사진. 없으면 그림 없이 그린다.
  readonly image: { readonly path: string; readonly digest: string } | null;
  // 작용 원리 아래쪽 실사: 영상(offsetMs 부터) 또는 정지 이미지.
  readonly bottom?: {
    readonly path: string;
    readonly digest: string;
    readonly video: boolean;
    readonly offsetMs: number;
    readonly crop?: string;
  } | null;
  readonly font: FontSet;
  readonly profile: RenderProfile;
  readonly scratch: string;
  readonly out: string;
  readonly signal: AbortSignal;
  readonly run?: FfmpegRunner;
};
const evenPx = (value: number) => Math.max(2, Math.round(value / 2) * 2);
export function screenClipHtml(
  input: Pick<
    ScreenClipInput,
    "kind" | "screen" | "mechanism" | "durationMs" | "image" | "profile"
  >,
  imageFile: string,
): string {
  const seconds = input.durationMs / 1000;
  if (input.kind === "screen") {
    if (!input.screen) throw new StudioError("render_screen", "폰 화면 컷에 화면 내용이 없습니다.");
    return phoneScreenHtml(input.screen, imageFile, seconds, input.profile.fps);
  }
  if (!input.mechanism) throw new StudioError("render_screen", "작용 원리 컷에 내용이 없습니다.");
  return mechanismHtml(input.mechanism, imageFile, seconds, input.profile.fps);
}
// 작용 원리 합치기 필터: 위 = HyperFrames 결과의 위쪽, 가운데 = 검정 띠, 아래 = 실사(가득 채워 자르고 모자라면 마지막 프레임 유지).
export function mechanismStackFilter(profile: RenderProfile, durMs: number, crop?: string): string {
  const { width: W, height: H, fps: F } = profile;
  const top = evenPx((MECH_TOP * H) / 1920);
  const seam = evenPx((MECH_SEAM * H) / 1920);
  const bottom = H - top - seam;
  const d = (durMs / 1000).toFixed(3);
  return [
    `[0:v]scale=${W}:${H},crop=${W}:${top}:0:0,fps=${F},setsar=1[top]`,
    `color=c=black:s=${W}x${seam}:r=${F}:d=${d}[seam]`,
    `[1:v]${crop ? `${crop},` : ""}scale=${W}:${bottom}:force_original_aspect_ratio=increase,crop=${W}:${bottom},fps=${F},setsar=1,eq=saturation=0.8:contrast=1.06,tpad=stop_mode=clone:stop_duration=${d}[bottom]`,
    `[top][seam][bottom]vstack=inputs=3,trim=duration=${d},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[out]`,
  ].join(";");
}
export async function renderScreenClip(input: ScreenClipInput): Promise<void> {
  const run = input.run ?? runFfmpeg;
  const digest = sha256Hex(
    JSON.stringify({
      version: SCREEN_RENDER_VERSION,
      kind: input.kind,
      screen: input.screen ?? null,
      mechanism: input.mechanism ?? null,
      durationMs: input.durationMs,
      image: input.image?.digest ?? null,
      font: fontDigest(input.font),
      profile: input.profile,
    }),
  );
  const directory = join(input.scratch, `screen-${digest.slice(0, 16)}`);
  const rendered = join(directory, "rendered.mp4");
  const assets = join(directory, "assets");
  if (!existsSync(rendered)) {
    await mkdir(assets, { recursive: true });
    const imageFile = input.image ? `img${extname(input.image.path).toLowerCase() || ".png"}` : "";
    await Promise.all([
      copyFile(join(input.font.dir, input.font.medium), join(assets, "screen-medium.ttf")),
      copyFile(join(input.font.dir, input.font.bold), join(assets, "screen-bold.ttf")),
      copyFile(require.resolve("gsap/dist/gsap.min.js"), join(assets, "gsap.min.js")),
      ...(input.image ? [copyFile(input.image.path, join(assets, imageFile))] : []),
    ]);
    await writeFile(join(directory, "index.html"), screenClipHtml(input, imageFile));
    const partial = join(directory, "partial.mp4");
    await executeHf(directory, partial, input.signal);
    const probed = Probe.parse(
      await runFfprobeJson(
        ["-show_entries", "stream=codec_type,width,height:format=duration", partial],
        input.signal,
      ),
    );
    const video = probed.streams.find((stream) => stream.codec_type === "video");
    if (
      video?.width !== 1080 ||
      video.height !== 1920 ||
      Math.abs(Number(probed.format.duration) - input.durationMs / 1000) > 0.15
    )
      throw new StudioError(
        "hf_render",
        "HyperFrames 화면 컷 결과의 길이·해상도 검증을 통과하지 못했습니다.",
      );
    await rename(partial, rendered);
  }
  const d = (input.durationMs / 1000).toFixed(3);
  const encode = [...segmentEncodeArgs(input.profile), "-t", d, input.out];
  if (input.kind === "screen") {
    await run(
      [
        "-i",
        rendered,
        "-vf",
        `${normalizeChain(input.profile)},tpad=stop_mode=clone:stop_duration=0.5,trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p`,
        ...encode,
      ],
      { signal: input.signal, timeoutMs: 120_000 },
    );
    return;
  }
  const bottom =
    input.bottom ?? (input.image ? { ...input.image, video: false, offsetMs: 0 } : null);
  if (!bottom)
    throw new StudioError("render_screen", "작용 원리 컷 아래쪽에 쓸 실사·이미지가 없습니다.");
  const bottomInput = bottom.video
    ? ["-ss", (bottom.offsetMs / 1000).toFixed(3), "-t", d, "-i", bottom.path]
    : ["-loop", "1", "-framerate", String(input.profile.fps), "-t", d, "-i", bottom.path];
  await run(
    [
      "-i",
      rendered,
      ...bottomInput,
      "-filter_complex",
      mechanismStackFilter(input.profile, input.durationMs, bottom.video ? bottom.crop : undefined),
      "-map",
      "[out]",
      ...encode,
    ],
    { signal: input.signal, timeoutMs: 120_000 },
  );
}
