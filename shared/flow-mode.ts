import { z } from "zod";
import { ClipIdSchema } from "./render-state";
import type { Job } from "./schema";
import { clipPrompt } from "./veo-prompt";
import { VEO_CLIP_SEC, type VideoScript } from "./video-script";

// Flow 모드: Google AI Pro 사용자가 Veo 클립을 API 대신 Google Flow 웹에서 만든다.
// 앱은 시작 이미지·프롬프트를 내보내고(flow-export-<n>.json/.md), 완성된 클립을 받아(import) 이어서 조립한다.
// 이 파일은 서버·화면·CLI 가 같이 쓰는 순수 함수와 상수만 둔다(Flow 화면 조작은 앱이 하지 않는다).
export const FLOW_URL = "https://labs.google/fx/tools/flow";
export const FLOW_CLIP_MAX_BYTES = 200 * 1024 * 1024;
export const FLOW_CLIP_MIN_SEC = 4;
export const FLOW_CLIP_MAX_SEC = 12;
// 측정 길이가 컷이 읽는 끝 지점보다 이만큼까지 짧은 것은 받아 준다(컨테이너·프레임 단위 오차).
export const FLOW_CLIP_TOLERANCE_MS = 200;
export const FLOW_MAX_ATTEMPTS = 9;
export const FLOW_ASPECT_RATIO = "9:16";
export const FLOW_MODELS = ["Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality"] as const;
export type FlowModel = (typeof FLOW_MODELS)[number];

export const flowExportName = (number: number, extension: "json" | "md") =>
  `flow-export-${number}.${extension}`;
// 번들 안에서 쓰는 파일 이름: 시작 이미지는 시도 번호를 뺀 안정적인 이름, 내려받을 클립은 영상·클립 ID 가 보이는 이름
export const flowStartImageFile = (number: number, clipId: string) =>
  `flow-start-${number}-${clipId}.png`;
export const flowOutputFile = (number: number, clipId: string) => `flow-${number}-${clipId}.mp4`;

type VideoModelPolicy =
  | "veo-3.1-lite-generate-preview"
  | "veo-3.1-fast-generate-preview"
  | "veo-3.1-generate-preview";
// API 모델 선택을 Flow 의 모델 이름으로 옮긴다. Flow 의 실제 모델 목록·이름은 화면마다 다를 수 있어 미검증이다.
export function suggestedFlowModel(videoModel: VideoModelPolicy | undefined): FlowModel {
  if (videoModel === "veo-3.1-lite-generate-preview") return "Veo 3.1 - Lite";
  if (videoModel === "veo-3.1-fast-generate-preview") return "Veo 3.1 - Fast";
  return "Veo 3.1 - Quality";
}
// 산출물 모델 ID 규칙(ModelIdSchema)에 맞게 "Veo 3.1 - Fast" → "veo-3.1-fast" 로 정규화한다.
export function flowModelId(label: string | null | undefined): string | null {
  const id = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._:/-]+$|-+$/g, "")
    .slice(0, 160);
  return /^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(id) ? id : null;
}

export const FlowExportClipSchema = z.object({
  id: ClipIdSchema,
  startImageArtifact: z.string().min(1),
  startImageFile: z.string().min(1),
  prompt: z.string().min(1),
  aspectRatio: z.literal(FLOW_ASPECT_RATIO),
  durationSec: z.literal(VEO_CLIP_SEC),
  suggestedModel: z.enum(FLOW_MODELS),
  outputFile: z.string().min(1),
  importCommand: z.string().min(1),
});
export type FlowExportClip = z.infer<typeof FlowExportClipSchema>;
export const FlowExportSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  number: z.number().int().min(1).max(10),
  title: z.string(),
  flowUrl: z.literal(FLOW_URL),
  checklist: z.array(z.string()).min(1),
  clips: z.array(FlowExportClipSchema).min(1),
});
export type FlowExport = z.infer<typeof FlowExportSchema>;

export function clipModeOf(job: Pick<Job, "automation">): "api" | "flow" {
  const policy = job.automation?.policy;
  return policy?.mode === "creative" && policy.clipMode === "flow" ? "flow" : "api";
}
export function videoScriptFor(
  job: Pick<Job, "videoScripts">,
  number: number,
): VideoScript | undefined {
  return job.videoScripts.find((item) => item.number === number) ?? job.videoScripts[number - 1];
}
// 아직 Flow 클립이 들어오지 않았거나 파일이 없는 클립 ID(대본 선언 순서).
export function pendingFlowClips(job: Job, number: number): string[] {
  const script = videoScriptFor(job, number);
  if (!script) return [];
  const render = job.renders.find((item) => item.number === number);
  return script.veoClips
    .filter((clip) => {
      const name = render?.clips[clip.id]?.name;
      return !name || !job.artifacts.some((asset) => asset.name === name);
    })
    .map((clip) => clip.id);
}
// 파이프라인은 영상 번호 순으로 돌기 때문에 "지금 기다리는 영상"은 완성본이 없는 가장 앞 번호다.
export function waitingVideoNumber(job: Job): number | null {
  const policy = job.automation?.policy;
  if (policy?.mode !== "creative") return null;
  for (let number = 1; number <= (policy.videoCount ?? 0); number++)
    if (!job.artifacts.some((asset) => asset.name === `video-final-${number}.mp4`)) return number;
  return null;
}
// 기다리던 영상의 클립이 모두 들어왔는지(또는 기다릴 영상이 없는지). 대본이 아직 없으면 아니다.
export function flowReady(job: Job): boolean {
  const number = waitingVideoNumber(job);
  if (number === null) return true;
  const script = videoScriptFor(job, number);
  return Boolean(script) && pendingFlowClips(job, number).length === 0;
}

const CHECKLIST = (model: FlowModel): string[] => [
  "Flow(https://labs.google/fx/tools/flow)에 AI Pro 구독 Google 계정으로 로그인되어 있는지 확인한다.",
  `클립마다 새 프로젝트(또는 새 장면)를 열고 모델을 ${model}(내보낸 suggestedModel)로 고른다.`,
  "화면 비율 9:16, 길이 8초, 해상도 1080p(선택지가 있을 때)로 설정한다.",
  "시작 이미지(startImageFile)를 첫 프레임 또는 이미지 참조로 올린다.",
  "프롬프트(prompt)를 수정 없이 그대로 붙여 넣고 생성한다.",
  "완성되면 시작 이미지와 같은 제품·인물·배경인지, 글자·로고가 생기지 않았는지 화면에서 직접 확인한다.",
  "확인한 클립을 outputFile 이름으로 내려받는다(영상 한 편의 다운로드 확인은 사용자에게 한 번만 묻는다).",
  "importCommand 로 앱에 업로드한다. 업로드가 끝나면 앱이 자동으로 다음 단계를 이어간다.",
];

// 클립 단계가 쓰는 내보내기 데이터. 시각 같은 값은 넣지 않아 같은 입력이면 같은 JSON 이 나온다.
export function buildFlowExport(job: Job, number: number): FlowExport {
  const script = videoScriptFor(job, number);
  if (!script) throw new Error(`영상 ${number} 의 대본이 없습니다.`);
  const policy = job.automation?.policy;
  const model = suggestedFlowModel(policy?.mode === "creative" ? policy.videoModel : undefined);
  const render = job.renders.find((item) => item.number === number);
  return {
    version: 1,
    jobId: job.id,
    number,
    title: script.title,
    flowUrl: FLOW_URL,
    checklist: CHECKLIST(model),
    clips: script.veoClips.map((clip) => ({
      id: clip.id,
      startImageArtifact: render?.startImages[clip.id]?.name ?? "",
      startImageFile: flowStartImageFile(number, clip.id),
      prompt: clipPrompt(clip),
      aspectRatio: FLOW_ASPECT_RATIO,
      durationSec: VEO_CLIP_SEC,
      suggestedModel: model,
      outputFile: flowOutputFile(number, clip.id),
      importCommand: `bun run flow import ${job.id} ${number} ${clip.id} <내려받은-파일-경로>`,
    })),
  };
}

// 사람·에이전트가 그대로 따라 할 수 있는 단계 목록. 같은 데이터(FlowExport)에서만 만든다.
export function flowExportMarkdown(data: FlowExport): string {
  const lines = [
    `# Flow 클립 제작 지시 · 영상 ${data.number} · ${data.title}`,
    "",
    `작업 ID: ${data.jobId}`,
    `Flow 주소: ${data.flowUrl}`,
    `클립 ${data.clips.length}개를 만들어 앱에 업로드하면 앱이 내레이션·정지 이미지·모션그래픽과 조립해 완성 영상을 만든다.`,
    "Flow 화면 조작 순서는 실제 화면에서 확인된 적이 없다(미검증). 화면이 다르면 화면에 맞게 조정하되 아래 값(비율·길이·프롬프트·시작 이미지)은 바꾸지 않는다.",
    "자세한 절차: FLOW-MODE.md",
    "",
    "## 공통 순서",
    "",
    ...data.checklist.map((step, index) => `${index + 1}. ${step}`),
    "",
  ];
  for (const clip of data.clips)
    lines.push(
      `## 클립 ${clip.id}`,
      "",
      `- 시작 이미지: ${clip.startImageFile} (앱 산출물 ${clip.startImageArtifact})`,
      `- 모델: ${clip.suggestedModel}`,
      `- 비율·길이: ${clip.aspectRatio} · ${clip.durationSec}초`,
      `- 내려받을 파일 이름: ${clip.outputFile}`,
      `- 업로드: \`${clip.importCommand}\``,
      "",
      "프롬프트(수정 없이 그대로):",
      "",
      "```text",
      clip.prompt,
      "```",
      "",
    );
  return lines.join("\n");
}
