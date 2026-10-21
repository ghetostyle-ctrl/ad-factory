import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

// 실생활 B-roll 명령줄 도구(`bun run broll ...`). 샤오홍슈(rednote) 영상이나 직접 찍은 영상을 잘라 자료 라이브러리(production assets)에 올린다.
// 앱 서버의 로컬 API 만 부르며 API 키는 읽지도 출력하지도 않는다. 검색·선별 절차는 BROLL-AGENT-BRIEF.md.
//   sheet <노트 URL|mp4> [--out <폴더>]                    — 내려받고(URL이면) 1초 간격 프레임 시트를 만든다(선별용)
//   add <projectId> <노트 URL|mp4> --start <초> --end <초> --title "<한국어 장면 이름>"
//       [--zoom <1~2.5>] [--y <0~100>] [--placement auto|opening|middle|ending] [--videos 1,3] [--url <주소>]
//                                                           — 구간 자르기·9:16 맞추기·폰 카메라 색감·무음 → 업로드 → 제목·설정 저장
export type BrollCliContext = {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly dataDir: string; // 내려받은 원본·가공본: <dataDir>/broll/raw, <dataDir>/broll/clips
  readonly run: (
    cmd: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

const USAGE = [
  "사용법:",
  "  bun run broll sheet <샤오홍슈 노트 URL 또는 mp4> [--out <폴더>]",
  '  bun run broll add <projectId> <노트 URL 또는 mp4> --start <초> --end <초> --title "<장면 이름>" [--zoom 1.3] [--y 30] [--placement auto|opening|middle|ending] [--videos 1,3] [--url <서버 주소>]',
].join("\n");

// 폰 카메라 색감(리메이크 스킬 rules 5와 같은 값): 채도·밝기를 낮추고 노이즈를 조금.
export const PHONE_GRADE = "eq=saturation=0.8:brightness=-0.025:contrast=1.06,noise=alls=6:allf=t";
const NOTE_ID = /[0-9a-f]{24}/i;

export type NoteRef = { readonly noteId: string; readonly downloadUrl: string };

// rednote.com / xiaohongshu.com 의 explore·search_result·discovery 링크에서 노트 ID 와 xsec_token 을 읽어 yt-dlp 가 받는 주소로 바꾼다.
export function parseNoteUrl(input: string): NoteRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/(^|\.)(rednote\.com|xiaohongshu\.com|xhslink\.com)$/i.test(url.hostname)) return null;
  const id = url.pathname.match(NOTE_ID)?.[0];
  if (!id) return null;
  const token = url.searchParams.get("xsec_token");
  const query = token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : "";
  return {
    noteId: id.toLowerCase(),
    downloadUrl: `https://www.xiaohongshu.com/explore/${id.toLowerCase()}${query}`,
  };
}

// 세로 9:16 으로 맞추는 크롭 + (선택) 확대 크롭. 가로 영상은 가운데 9:16, 세로 영상은 zoom 배율로 잘라 y% 기준점.
export function fitFilter(width: number, height: number, zoom = 1, yPct = 50): string {
  const z = Math.min(2.5, Math.max(1, zoom));
  const y = Math.min(100, Math.max(0, yPct)) / 100;
  // 9:16 이 되는 최대 창
  let cw = width;
  let ch = Math.round((width * 16) / 9);
  if (ch > height) {
    ch = height;
    cw = Math.round((height * 9) / 16);
  }
  cw = Math.floor(cw / z / 2) * 2;
  ch = Math.floor(ch / z / 2) * 2;
  const x = Math.floor((width - cw) / 2);
  const top = Math.floor((height - ch) * y);
  return `crop=${cw}:${ch}:${x}:${top},scale=720:1280:flags=lanczos,setsar=1,${PHONE_GRADE}`;
}

type Flags = Record<string, string>;
function splitArgs(args: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "";
      i++;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function probe(
  ctx: BrollCliContext,
  file: string,
): Promise<{ width: number; height: number; duration: number }> {
  const r = await ctx.run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    file,
  ]);
  if (r.code !== 0) throw new Error(`영상을 읽지 못했습니다: ${basename(file)}`);
  const data = z
    .object({
      streams: z.array(z.object({ width: z.number(), height: z.number() })).min(1),
      format: z.object({ duration: z.string() }),
    })
    .parse(JSON.parse(r.stdout));
  const s = data.streams[0];
  if (!s) throw new Error("영상 스트림이 없습니다.");
  return { width: s.width, height: s.height, duration: Number(data.format.duration) };
}

// URL 이면 yt-dlp 로 <dataDir>/broll/raw/<노트ID>.mp4 에 받는다(이미 있으면 재사용). 파일이면 그대로.
async function source(
  ctx: BrollCliContext,
  input: string,
): Promise<{ file: string; noteId: string | null }> {
  const note = parseNoteUrl(input);
  if (!note) {
    await stat(input).catch(() => {
      throw new Error(`샤오홍슈 노트 URL 도 파일도 아닙니다: ${input}`);
    });
    return { file: resolve(input), noteId: null };
  }
  const dir = join(ctx.dataDir, "broll", "raw");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${note.noteId}.mp4`);
  if (
    await stat(file).then(
      () => true,
      () => false,
    )
  )
    return { file, noteId: note.noteId };
  const r = await ctx.run("yt-dlp", [
    "-q",
    "--no-warnings",
    "-f",
    "mp4/best",
    "-o",
    file,
    note.downloadUrl,
  ]);
  if (
    r.code !== 0 ||
    !(await stat(file).then(
      () => true,
      () => false,
    ))
  )
    throw new Error(
      `내려받기 실패(yt-dlp): ${(r.stderr || r.stdout).trim().slice(-300) || "원인 미상"} — 이미지 노트이거나 링크의 xsec_token 이 만료됐을 수 있습니다.`,
    );
  return { file, noteId: note.noteId };
}

async function sheet(ctx: BrollCliContext, input: string, flags: Flags): Promise<number> {
  const { file, noteId } = await source(ctx, input);
  const info = await probe(ctx, file);
  const fps = info.duration <= 80 ? 1 : info.duration <= 130 ? 0.66 : 0.33;
  const outDir = flags["out"] ? resolve(flags["out"]) : join(ctx.dataDir, "broll", "sheets");
  await mkdir(outDir, { recursive: true });
  const name = noteId ?? basename(file).replace(/\.[^.]+$/, "");
  const png = join(outDir, `${name}.jpg`);
  const r = await ctx.run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    `fps=${fps},scale=96:-1,tile=10x8`,
    "-frames:v",
    "1",
    png,
  ]);
  if (r.code !== 0) throw new Error(`시트를 만들지 못했습니다: ${r.stderr.trim().slice(-200)}`);
  ctx.out(`원본: ${file} (${info.width}x${info.height}, ${info.duration.toFixed(1)}초)`);
  ctx.out(`시트: ${png} (${fps === 1 ? "1초" : `${(1 / fps).toFixed(1)}초`} 간격, 왼쪽 위부터)`);
  return 0;
}

const PlacementSchema = z.enum(["auto", "opening", "middle", "ending"]);
const UploadedSchema = z.object({ id: z.string(), title: z.string(), durationSec: z.number() });

async function add(
  ctx: BrollCliContext,
  projectId: string,
  input: string,
  flags: Flags,
): Promise<number> {
  const start = Number(flags["start"]);
  const end = Number(flags["end"]);
  const title = (flags["title"] ?? "").trim();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 15)
    throw new Error("--start 와 --end 를 초 단위로 주세요(구간 15초 이하, end > start).");
  if (!title)
    throw new Error(
      '--title "<장면 이름>"이 필요합니다. 대본의 화면 설명에 나올 한국어 낱말로(예: "요거트 볼").',
    );
  const placement = PlacementSchema.parse(flags["placement"] || "auto");
  const videos = flags["videos"]
    ? flags["videos"]
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)
    : [];
  const { file, noteId } = await source(ctx, input);
  const info = await probe(ctx, file);
  if (end > info.duration + 0.05)
    throw new Error(`--end ${end}초가 원본 길이 ${info.duration.toFixed(1)}초보다 깁니다.`);
  const clipsDir = join(ctx.dataDir, "broll", "clips");
  await mkdir(clipsDir, { recursive: true });
  const outFile = join(
    clipsDir,
    `${noteId ?? basename(file).replace(/\.[^.]+$/, "")}-${start}-${end}.mp4`,
  );
  const vf = fitFilter(
    info.width,
    info.height,
    Number(flags["zoom"] || 1),
    Number(flags["y"] ?? 50),
  );
  const r = await ctx.run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    String(start),
    "-t",
    String(end - start),
    "-i",
    file,
    "-vf",
    vf,
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outFile,
  ]);
  if (r.code !== 0) throw new Error(`가공 실패(ffmpeg): ${r.stderr.trim().slice(-300)}`);
  const base = ctx.baseUrl.replace(/\/$/, "");
  const origin = new URL(base).origin;
  const form = new FormData();
  form.append(
    "file",
    new File([await readFile(outFile)], `${title.replace(/[\\/:*?"<>|]/g, "_")}.mp4`, {
      type: "video/mp4",
    }),
  );
  const up = await ctx.fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/production-assets`,
    {
      method: "POST",
      headers: { Origin: origin },
      body: form,
    },
  );
  if (!up.ok) throw new Error(`업로드 실패 ${up.status}: ${(await up.text()).slice(0, 300)}`);
  const asset = UploadedSchema.parse(await up.json());
  const settings = {
    usage: "optional",
    startSec: 0,
    endSec: null,
    placement,
    targets:
      videos.length > 0
        ? { mode: "selected", videoNumbers: [...new Set(videos)] }
        : { mode: "all" },
    audio: "mute",
    notes: `실생활 B-roll${noteId ? ` · rednote ${noteId}` : ""} · 원본 ${start}~${end}초`,
  };
  const put = await ctx.fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/production-assets/${asset.id}`,
    {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ title, settings }),
    },
  );
  if (!put.ok) throw new Error(`설정 저장 실패 ${put.status}: ${(await put.text()).slice(0, 300)}`);
  ctx.out(
    `올림: "${title}" (${asset.id}, ${(end - start).toFixed(1)}초, 위치 ${placement}${videos.length ? `, 영상 ${videos.join(",")}` : ""})`,
  );
  ctx.out(`가공본: ${outFile}`);
  ctx.out("주의: 새로 만드는 작업부터 쓰입니다(작업은 만들 때 자료 라이브러리를 스냅숏으로 고정).");
  return 0;
}

export async function runBrollCli(argv: readonly string[], ctx: BrollCliContext): Promise<number> {
  const { positional, flags } = splitArgs(argv);
  const [command, a, b] = positional;
  try {
    if (command === "sheet" && a) return await sheet(ctx, a, flags);
    if (command === "add" && a && b) return await add(ctx, a, b, flags);
    ctx.err(USAGE);
    return 2;
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
