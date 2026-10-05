import { z } from "zod";
import {
  VideoScriptReviewIssueSchema,
  VideoScriptSchema,
  voiceCutRange,
} from "../shared/video-script";

// 영상 대본 확인·승인·다시 쓰기 명령줄 도구(`bun run script ...`). 앱 서버의 로컬 API 만 부르며 API 키는 읽지도 출력하지도 않는다.
// Codex 처럼 화면이 없는 에이전트도 같은 절차(확인 → 수정/다시 쓰기 → 승인)를 밟을 수 있다.
//   show    <jobId> <number> [--url <주소>]            현재 대본(문장·자막·승인·AI 검토) 출력
//   approve <jobId> <number> [--url <주소>]            대본 승인(모든 영상이 승인되면 제작이 이어진다)
//   rewrite <jobId> <number> "<피드백>" [--url <주소>]  피드백을 붙여 다시 생성(유료 텍스트 호출)·승인 해제
export type ScriptCliContext = {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};
const USAGE = [
  "사용법:",
  "  bun run script show <jobId> <영상번호> [--url <서버 주소>]",
  "  bun run script approve <jobId> <영상번호> [--url <서버 주소>]",
  '  bun run script rewrite <jobId> <영상번호> "<수정 요청>" [--url <서버 주소>]',
].join("\n");
const ViewSchema = z.object({
  number: z.number(),
  script: VideoScriptSchema,
  approvalMode: z.enum(["required", "auto"]),
  approved: z.boolean(),
  approval: z.object({ approvedAt: z.string(), scriptDigest: z.string() }).nullable(),
  review: z
    .object({
      attempt: z.number(),
      status: z.enum(["pass", "revise"]),
      summary: z.string(),
      issues: z.array(VideoScriptReviewIssueSchema),
      // needsFix: 3회 생성 뒤에도 규칙을 통과하지 못한 초안(고치거나 다시 쓰기)
      accepted: z.enum(["pass", "forced", "needsFix"]),
      repairs: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
      hardProblems: z.array(z.string()).optional(),
      generations: z.number().optional(),
    })
    .nullable(),
  // 지금 저장된 대본의 규칙 판정(서버 계산). hard 가 남아 있으면 승인할 수 없다.
  rules: z.object({ hard: z.array(z.string()), soft: z.array(z.string()) }).optional(),
  synthesized: z.boolean(),
  pending: z.array(z.number()),
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
export function formatScriptView(view: z.infer<typeof ViewSchema>): string[] {
  const { script } = view;
  const lines = [
    `영상 ${view.number} · ${script.title} · ${script.durationSec}초 · 컷 ${script.cuts.length}개`,
    view.approvalMode === "auto" && !view.pending.includes(view.number)
      ? "대본 확인: 자동 진행(AI 검토 통과, 승인 없이 제작)"
      : view.approved
        ? `승인됨 · ${view.approval?.approvedAt ?? ""}`
        : view.synthesized
          ? "내레이션이 이미 합성되어 대본을 바꿀 수 없음(초기화 필요)"
          : view.review?.accepted === "needsFix" || (view.rules?.hard.length ?? 0) > 0
            ? "규칙 미통과 초안 · 문장·자막을 고쳐 저장(PUT)하거나 `rewrite` 한 뒤 `approve`"
            : "승인 대기 · 확인 후 `approve` 또는 `rewrite`",
    "",
    "[내레이션] (문장 → 그 문장이 흐르는 컷 번호(0부터)·화면)",
    ...script.voiceover.flatMap((voice, index) => {
      const range = voiceCutRange(voice, script.cuts);
      const head = `${index + 1}. (${voice.startSec}~${voice.endSec}초${range ? `, 컷 ${range[0]}~${range[1]}` : ""}) ${voice.text}`;
      const cuts = range
        ? script.cuts.slice(range[0], range[1] + 1).map((cut, offset) => {
            const extra = [
              cut.onScreenText ? `자막 "${cut.onScreenText.replace("\n", " / ")}"` : "",
              cut.graphicLines.length > 0 ? `글줄 ${cut.graphicLines.join(" / ")}` : "",
            ]
              .filter((item) => item.length > 0)
              .join(" · ");
            return `   컷 ${range[0] + offset} (${cut.startSec}~${cut.endSec}초, ${cut.purpose}, ${cut.source}) ${cut.screenComposition}${extra ? ` · ${extra}` : ""}`;
          })
        : [];
      return [head, ...cuts];
    }),
    "",
    "[자막] (컷 번호는 0부터)",
    ...script.cuts.map(
      (cut, index) =>
        `컷 ${index} (${cut.startSec}~${cut.endSec}초) ${cut.onScreenText || "(없음)"}`,
    ),
  ];
  if (view.review && view.review.accepted !== "needsFix") {
    lines.push(
      "",
      `[AI 검토 ${view.review.attempt}회차] ${view.review.status === "pass" ? "통과" : "수정 권고"}${view.review.accepted === "forced" ? " · 생성 한도 뒤 강제 수용(사용자 확인 필요)" : ""} · ${view.review.summary}`,
      ...view.review.issues.map(
        (issue) =>
          `- ${issue.sentenceIndex === null ? "전체" : `${issue.sentenceIndex + 1}번째 문장`}${issue.cutIndexes.length > 0 ? `(컷 ${issue.cutIndexes.join(", ")})` : ""}: ${issue.problem} → ${issue.fix}`,
      ),
    );
  }
  // 규칙 미통과: 서버의 현재 판정(rules.hard)이 우선, 없으면 저장된 기록(hardProblems)
  const hard = view.rules?.hard ?? view.review?.hardProblems ?? [];
  if (view.review?.accepted === "needsFix" || hard.length > 0) {
    lines.push(
      "",
      `[규칙 미통과] 고치거나 다시 쓰기(생성 ${view.review?.generations ?? 0}회) · 승인 전에 아래를 모두 해소해야 합니다`,
      ...(hard.length > 0
        ? hard
        : ["(지금 저장된 대본에는 남은 위반이 없습니다 — approve 할 수 있습니다)"]
      ).map((item) => `- ${item}`),
    );
  }
  const soft = view.rules?.soft ?? view.review?.warnings ?? [];
  if (soft.length > 0)
    lines.push("", `[경고 ${soft.length}건]`, ...soft.map((item) => `- ${item}`));
  const repairs = view.review?.repairs ?? [];
  if (repairs.length > 0)
    lines.push("", `[자동 수리 ${repairs.length}건]`, ...repairs.map((item) => `- ${item}`));
  if (view.pending.length > 0) lines.push("", `승인 대기 영상: ${view.pending.join(", ")}`);
  return lines;
}
export async function runScriptCli(
  argv: readonly string[],
  ctx: ScriptCliContext,
): Promise<number> {
  const { positional, flags } = parse(argv);
  const [command, jobId, numberText, feedback] = positional;
  const number = Number(numberText);
  const base = (flags.get("url") || ctx.baseUrl).replace(/\/+$/, "");
  if (!command || !jobId || !Number.isInteger(number) || number < 1 || number > 10) {
    ctx.err(USAGE);
    return 2;
  }
  const url = `${base}/api/jobs/${jobId}/videos/${number}/script`;
  // 앱은 같은 출처 요청만 받는다: 서버 주소와 같은 Origin 을 붙인다.
  const headers = { Origin: new URL(base).origin, "Content-Type": "application/json" };
  try {
    let response: Response;
    if (command === "show") response = await ctx.fetch(url);
    else if (command === "approve")
      response = await ctx.fetch(`${url}/approve`, { method: "POST", headers, body: "{}" });
    else if (command === "rewrite") {
      if (!feedback?.trim()) {
        ctx.err(USAGE);
        return 2;
      }
      response = await ctx.fetch(`${url}/rewrite`, {
        method: "POST",
        headers,
        body: JSON.stringify({ feedback }),
      });
    } else {
      ctx.err(USAGE);
      return 2;
    }
    if (!response.ok) {
      ctx.err(await failure(response));
      return 1;
    }
    const view = ViewSchema.safeParse(await response.json());
    if (!view.success) {
      ctx.err("서버 응답 형식이 올바르지 않습니다.");
      return 1;
    }
    if (command === "approve")
      ctx.out(
        view.data.pending.length === 0
          ? `영상 ${number} 대본을 승인했습니다. 모든 영상이 승인되어 앱이 제작을 이어갑니다.`
          : `영상 ${number} 대본을 승인했습니다. 아직 승인하지 않은 영상: ${view.data.pending.join(", ")}`,
      );
    if (command === "rewrite")
      ctx.out(
        view.data.review?.accepted === "needsFix"
          ? `영상 ${number} 대본을 다시 썼지만 규칙을 통과하지 못한 초안입니다. 아래 [규칙 미통과]를 고쳐 저장하거나 다시 rewrite 하세요.`
          : view.data.review?.accepted === "forced"
            ? `영상 ${number} 대본을 다시 썼습니다(AI 검토 미통과, 확인 필요). 확인한 뒤 approve 로 승인하세요.`
            : `영상 ${number} 대본을 다시 썼습니다. 확인한 뒤 approve 로 승인하세요.`,
      );
    for (const line of formatScriptView(view.data)) ctx.out(line);
    return 0;
  } catch (error) {
    ctx.err(
      error instanceof Error && error.name !== "TypeError"
        ? error.message
        : `서버(${base})에 연결하지 못했습니다. 앱 서버가 켜져 있는지 확인하세요.`,
    );
    return 1;
  }
}
