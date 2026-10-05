import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  FLOW_CLIP_MAX_BYTES,
  FlowExportSchema,
  flowExportMarkdown,
  flowExportName,
} from "../shared/flow-mode";
import { ClipIdSchema } from "../shared/render-state";

// Flow 모드 명령줄 도구(`bun run flow ...`). 앱 서버의 로컬 API 만 부르며 API 키는 읽지도 출력하지도 않는다.
//   export <jobId> <number> [--out <폴더>] [--url <주소>]
//   import <jobId> <number> <clipId> <파일> [--model "Veo 3.1 - Fast"] [--url <주소>]
export type FlowCliContext = {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  // 번들 기본 저장 위치의 부모(기본 data): <dataDir>/flow/<jobId>/video-<n>/
  readonly dataDir: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};
const USAGE = [
  "사용법:",
  "  bun run flow export <jobId> <영상번호> [--out <폴더>] [--url <서버 주소>]",
  "  bun run flow import <jobId> <영상번호> <클립ID(A~H)> <mp4 파일> [--model <Flow 모델 이름>] [--url <서버 주소>]",
].join("\n");

// 업로드 응답(Job)에서 필요한 값만 읽는다.
const ImportedJobSchema = z.object({
  renders: z
    .array(
      z.object({
        number: z.number(),
        clips: z.record(z.string(), z.object({ name: z.string().nullable() }).optional()),
      }),
    )
    .default([]),
  videoScripts: z
    .array(z.object({ number: z.number(), veoClips: z.array(z.object({ id: z.string() })) }))
    .default([]),
});

type Parsed = { readonly positional: string[]; readonly flags: Map<string, string> };
function parse(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), args[index + 1] ?? "");
      index++;
    } else positional.push(arg);
  }
  return { positional, flags };
}
async function failure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  return typeof message === "string"
    ? message
    : `요청을 완료하지 못했습니다. (HTTP ${response.status})`;
}
export async function runFlowCli(argv: readonly string[], ctx: FlowCliContext): Promise<number> {
  const { positional, flags } = parse(argv);
  const [command, jobId, numberText] = positional;
  const number = Number(numberText);
  const base = (flags.get("url") || ctx.baseUrl).replace(/\/+$/, "");
  if (!jobId || !Number.isInteger(number) || number < 1 || number > 10 || !command) {
    ctx.err(USAGE);
    return 2;
  }
  try {
    if (command === "export") return await exportBundle({ ctx, base, jobId, number, flags });
    if (command === "import") {
      const clipId = ClipIdSchema.safeParse(positional[3]);
      const file = positional[4];
      if (!clipId.success || !file) {
        ctx.err(USAGE);
        return 2;
      }
      return await importClip({ ctx, base, jobId, number, clipId: clipId.data, file, flags });
    }
  } catch (error) {
    ctx.err(
      error instanceof Error && error.name !== "TypeError"
        ? error.message
        : `서버(${base})에 연결하지 못했습니다. 앱 서버가 켜져 있는지 확인하세요.`,
    );
    return 1;
  }
  ctx.err(USAGE);
  return 2;
}
async function exportBundle(input: {
  readonly ctx: FlowCliContext;
  readonly base: string;
  readonly jobId: string;
  readonly number: number;
  readonly flags: Map<string, string>;
}): Promise<number> {
  const { ctx, base, jobId, number } = input;
  const artifact = (name: string) => `${base}/api/artifacts/${jobId}/${name}`;
  const exported = await ctx.fetch(artifact(flowExportName(number, "json")));
  if (!exported.ok) {
    ctx.err(
      exported.status === 404
        ? `영상 ${number} 의 Flow 내보내기가 아직 없습니다. 작업이 Flow 모드이고 제작이 클립 단계(시작 이미지 다음)에 도달해야 만들어집니다.`
        : await failure(exported),
    );
    return 1;
  }
  const data = FlowExportSchema.safeParse(await exported.json());
  if (!data.success) {
    ctx.err("내보내기 파일 형식이 올바르지 않습니다.");
    return 1;
  }
  const directory = input.flags.get("out")
    ? resolve(input.flags.get("out") ?? "")
    : join(ctx.dataDir, "flow", jobId, `video-${number}`);
  await mkdir(directory, { recursive: true });
  for (const clip of data.data.clips) {
    const image = await ctx.fetch(artifact(clip.startImageArtifact));
    if (!image.ok) {
      ctx.err(`클립 ${clip.id} 시작 이미지를 받지 못했습니다. ${await failure(image)}`);
      return 1;
    }
    await Bun.write(
      join(directory, clip.startImageFile),
      new Uint8Array(await image.arrayBuffer()),
    );
  }
  const markdown = flowExportMarkdown(data.data);
  await Bun.write(join(directory, "prompts.md"), markdown);
  await Bun.write(join(directory, "flow-export.json"), JSON.stringify(data.data, null, 2));
  ctx.out(`Flow 번들을 저장했습니다: ${directory}`);
  ctx.out(
    `시작 이미지 ${data.data.clips.length}장과 prompts.md, flow-export.json 이 들어 있습니다.`,
  );
  ctx.out("");
  ctx.out(markdown);
  return 0;
}
async function importClip(input: {
  readonly ctx: FlowCliContext;
  readonly base: string;
  readonly jobId: string;
  readonly number: number;
  readonly clipId: string;
  readonly file: string;
  readonly flags: Map<string, string>;
}): Promise<number> {
  const { ctx, base, jobId, number, clipId } = input;
  const source = Bun.file(resolve(input.file));
  if (!(await source.exists())) {
    ctx.err(`파일을 찾을 수 없습니다: ${input.file}`);
    return 1;
  }
  if (source.size > FLOW_CLIP_MAX_BYTES) {
    ctx.err("클립 파일은 200MB 이하여야 합니다.");
    return 1;
  }
  const model = input.flags.get("model");
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  const response = await ctx.fetch(
    `${base}/api/jobs/${jobId}/videos/${number}/clips/${clipId}${query}`,
    {
      method: "POST",
      // 앱은 같은 출처 요청만 받는다: 서버 주소와 같은 Origin 을 붙인다.
      headers: { Origin: new URL(base).origin, "Content-Type": "video/mp4" },
      body: new Uint8Array(await source.arrayBuffer()),
    },
  );
  if (!response.ok) {
    ctx.err(await failure(response));
    return 1;
  }
  const parsed = ImportedJobSchema.safeParse(await response.json());
  const renders = parsed.success ? parsed.data.renders : [];
  const scripts = parsed.success ? parsed.data.videoScripts : [];
  const clips = renders.find((item) => item.number === number)?.clips ?? {};
  ctx.out(
    `영상 ${number} 클립 ${clipId} 업로드 완료: ${clips[clipId]?.name ?? "(이름 확인 불가)"}`,
  );
  const waiting = (scripts.find((item) => item.number === number)?.veoClips ?? [])
    .map((clip) => clip.id)
    .filter((id) => !clips[id]?.name);
  if (waiting.length > 0) ctx.out(`아직 올리지 않은 클립: ${waiting.join(", ")}`);
  else ctx.out("이 영상의 클립이 모두 올라왔습니다. 앱이 자동으로 다음 단계를 이어갑니다.");
  return 0;
}
