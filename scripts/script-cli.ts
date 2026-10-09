import { z } from "zod";
import { CHAIN_STEP_LABELS } from "../shared/persuasion-chain";
import type { VisualPolicyId } from "../shared/video-planning";
import {
  CLIP_PHASE_RANGES_MS,
  CLIP_PHASES,
  type ClipPhaseId,
  type ClipPlan,
  type ExplainerEmphasis,
  type ExplainerObject,
  type InfoClip,
  isClipPlanEmpty,
  isExplainerScene,
  type VideoScript,
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
// 클립 구간 라벨: early(0~3초) 형태.
function phaseLabel(phase: ClipPhaseId): string {
  const [from, to] = CLIP_PHASE_RANGES_MS[phase];
  return `${phase}(${from / 1000}~${to / 1000}초)`;
}
// 혼합형(2026-10-07) 한국어 라벨. 값은 shared/video-planning.ts·shared/explainer-scene.ts 의 enum 과 같다.
const POLICY_LABELS: Record<VisualPolicyId, string> = {
  immersive_explanations_v1: "입체 설명(이전 기준)",
  hybrid_explainer_v1: "혼합형(실사 + 3D 설명)",
};
const SCENE_TYPE_LABELS = { process: "과정", comparison: "비교", analogy: "비유" } as const;
const COLOR_LABELS: Record<ExplainerObject["color"], string> = {
  accent1: "강조색 1",
  accent2: "강조색 2",
  neutral: "중립",
};
const EMPHASIS_LABELS: Record<ExplainerEmphasis["kind"], string> = {
  color_code: "색 구분",
  outline: "빨간 외곽선",
  glow_line: "흰 발광선",
  ghost_object: "반투명 비유 물체",
};
// 혼합형 설명 장면: 종류 · 물체(색) · 동작 순서 · 강조(몇 번째 동작 뒤). 설명 세계에는 글자가 없어 자막 한 줄만 보인다.
function explainerSceneLines(clip: InfoClip): string[] {
  if (!isExplainerScene(clip) || clip.sceneType === "") return [];
  const objects = clip.objects
    .map((object) => `${object.subjectId}(${COLOR_LABELS[object.color]})`)
    .join(", ");
  const actions = clip.actions.map((action, index) => `${index + 1}) ${action}`).join(" ");
  const emphasis = clip.emphasis
    .map(
      (item) =>
        `${EMPHASIS_LABELS[item.kind]} → ${item.target} (${item.afterAction + 1}번째 동작 뒤)`,
    )
    .join(" · ");
  return [
    `  장면: ${SCENE_TYPE_LABELS[clip.sceneType]} · 물체: ${objects}`,
    `  동작: ${actions}`,
    ...(emphasis ? [`  강조: ${emphasis}`] : []),
  ];
}
// 장면 계획(2026-10-06 R5): Veo 클립·설명 컷의 세 구간 계획(카메라/동작). 계획이 없는 예전 대본은 절을 내지 않는다.
// 혼합형 설명 장면은 그래픽 순서 대신 장면 종류·물체·동작·강조를 낸다.
function clipPlanLines(script: VideoScript): string[] {
  const clips: {
    label: string;
    plan: ClipPlan;
    order: readonly string[];
    scene: readonly string[];
  }[] = [
    ...script.veoClips.map((clip) => ({
      label: `Veo 클립 ${clip.id}`,
      plan: clip.plan,
      order: [],
      scene: [],
    })),
    ...script.infoClips.map((clip) => ({
      label: `설명 컷 ${clip.id} (${clip.stage})`,
      plan: clip.plan,
      order: clip.graphicOrder,
      scene: explainerSceneLines(clip),
    })),
  ].filter((clip) => !isClipPlanEmpty(clip.plan));
  if (clips.length === 0) return [];
  return [
    "",
    "[클립 구간 계획] (8초 클립의 세 구간 · 카메라 / 동작)",
    ...clips.flatMap((clip) => [
      clip.label,
      ...CLIP_PHASES.map(
        (phase) =>
          `  ${phaseLabel(phase)} 카메라: ${clip.plan[phase].camera} / 동작: ${clip.plan[phase].action}`,
      ),
      ...(clip.order.length > 0 ? [`  그래픽 순서: ${clip.order.join(" → ")}`] : []),
      ...clip.scene,
    ]),
  ];
}
function copyFlowLine(repairs: readonly string[]): string {
  const record = repairs.find((item) => item.startsWith("카피 먼저:"));
  const restored = repairs.filter((item) =>
    item.endsWith("번째 문장을 카피 원문으로 되돌림"),
  ).length;
  return `흐름: 카피 먼저${record ? ` · ${record.replace(/^카피 먼저:\s*/u, "")}` : ""} · 카피 원문으로 되돌린 문장 ${restored}개`;
}
export function formatScriptView(view: z.infer<typeof ViewSchema>): string[] {
  const { script } = view;
  const policy = script.planning?.visualPolicy;
  const lines = [
    `영상 ${view.number} · ${script.title} · ${script.durationSec}초 · 컷 ${script.cuts.length}개${policy ? ` · ${POLICY_LABELS[policy]}` : ""}`,
    view.approvalMode === "auto" && !view.pending.includes(view.number)
      ? "대본 확인: 자동 진행(AI 검토 통과, 승인 없이 제작)"
      : view.approved
        ? `승인됨 · ${view.approval?.approvedAt ?? ""}`
        : view.synthesized
          ? "내레이션이 이미 합성되어 대본을 바꿀 수 없음(초기화 필요)"
          : view.review?.accepted === "needsFix" || (view.rules?.hard.length ?? 0) > 0
            ? "규칙 미통과 초안 · 문장·자막을 고쳐 저장(PUT)하거나 `rewrite` 한 뒤 `approve`"
            : "승인 대기 · 확인 후 `approve` 또는 `rewrite`",
    // 카피 먼저 흐름(2026-10-08): 카피 회차·추정 초(repairs 맨 앞 기록)와 편지 2 가 바꿔서 원문으로 되돌린 문장 수.
    ...(script.flow === "copy_first" ? [copyFlowLine(view.review?.repairs ?? [])] : []),
    "",
    "[내레이션] (문장 → 콜아웃 → 그 문장이 흐르는 컷 번호(0부터)·목표·구간·화면)",
    ...script.voiceover.flatMap((voice, index) => {
      const range = voiceCutRange(voice, script.cuts);
      const head = `${index + 1}. (${voice.startSec}~${voice.endSec}초${range ? `, 컷 ${range[0]}~${range[1]}` : ""}${voice.chainStep ? ` · ${CHAIN_STEP_LABELS[voice.chainStep]}` : ""}) ${voice.text}`;
      // 콜아웃(R7): 어절 → 종류 '글자' (위치). 그 어절이 발음되는 순간 그려져 컷 끝까지 남는다.
      const callouts =
        voice.callouts.length > 0
          ? [
              `   콜아웃: ${voice.callouts
                .map(
                  (callout) =>
                    `"${callout.word}" → ${callout.kind} '${callout.text}' (${callout.anchor})`,
                )
                .join(" · ")}`,
            ]
          : [];
      const cuts = range
        ? script.cuts.slice(range[0], range[1] + 1).map((cut, offset) => {
            const extra = [
              cut.goal ? `목표 "${cut.goal}"` : "",
              cut.phase ? `구간 ${cut.phase}` : "",
              cut.onScreenText ? `자막 "${cut.onScreenText.replace("\n", " / ")}"` : "",
              cut.graphicLines.length > 0 ? `글줄 ${cut.graphicLines.join(" / ")}` : "",
            ]
              .filter((item) => item.length > 0)
              .join(" · ");
            return `   컷 ${range[0] + offset} (${cut.startSec}~${cut.endSec}초, ${cut.purpose}, ${cut.source}) ${cut.screenComposition}${extra ? ` · ${extra}` : ""}`;
          })
        : [];
      return [head, ...callouts, ...cuts];
    }),
    "",
    "[자막] (컷 번호는 0부터)",
    ...script.cuts.map(
      (cut, index) =>
        `컷 ${index} (${cut.startSec}~${cut.endSec}초) ${cut.onScreenText || "(없음)"}`,
    ),
    ...(script.subjects.length > 0
      ? [
          "",
          "[등장 대상] (모든 이미지 프롬프트가 이 외형 낱말을 직접 담는다)",
          ...script.subjects.map((subject) => `- ${subject.id}: ${subject.traits}`),
        ]
      : []),
    // 혼합형: 설명 장면(I1~I3)의 CLEAN·INFO 프롬프트가 따르는 기준. 실사 기준(styleAnchor)과 다르며 사람·글자가 없다.
    ...(script.explainerAnchor
      ? [
          "",
          "[설명 세계 기준] (설명 장면 I1~I3 전용 · 실사 기준과 별개)",
          `- ${script.explainerAnchor}`,
        ]
      : []),
    ...clipPlanLines(script),
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
