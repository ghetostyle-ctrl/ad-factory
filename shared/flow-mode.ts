import { z } from "zod";
import { ExplanationPlanSchema } from "./explanation-plan";
import {
  type ExplainerContext,
  infoCleanPrompt,
  infoClipExpectsText,
  infoMotionPrompt,
  infoOverlayPrompt,
  infoTextLines,
} from "./flow-info-prompts";
import { type FlowTexts, fillTemplate } from "./flow-texts";
import { HfLabelPlanSchema } from "./hf-label-plan";
import { ClipIdSchema } from "./render-state";
import type { Job } from "./schema";
import { clipPrompt } from "./veo-prompt";
import { VisualPolicySchema } from "./video-planning";
import {
  ClipPlanSchema,
  EXPLAINER_SCENE_TYPES,
  ExplainerEmphasisSchema,
  ExplainerObjectSchema,
  emptyClipPlan,
  isExplainerScene,
  VEO_CLIP_SEC,
  type VideoScript,
  videoPolicyOf,
} from "./video-script";

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
  // 구간 계획(2026-10-06, R5). 예전 내보내기 파일에는 없어 빈 계획으로 읽힌다.
  plan: ClipPlanSchema.default(() => emptyClipPlan()),
  aspectRatio: z.literal(FLOW_ASPECT_RATIO),
  durationSec: z.literal(VEO_CLIP_SEC),
  suggestedModel: z.enum(FLOW_MODELS),
  outputFile: z.string().min(1),
  importCommand: z.string().min(1),
});
export type FlowExportClip = z.infer<typeof FlowExportClipSchema>;
// 설명 컷: Flow 에서 CLEAN 이미지 → (CLEAN 을 첨부해) INFO 이미지 → 두 장을 첫·마지막 프레임으로 8초 영상.
export const flowCleanImageFile = (number: number, clipId: string) =>
  `flow-${number}-${clipId}-clean.png`;
export const flowInfoImageFile = (number: number, clipId: string) =>
  `flow-${number}-${clipId}-info.png`;
export const FlowExportObjectSchema = ExplainerObjectSchema.extend({
  traits: z.string().default(""),
});
export const FlowExportInfoClipSchema = z.object({
  id: ClipIdSchema,
  stage: z.string(),
  labelLayer: HfLabelPlanSchema.optional(),
  explanation: ExplanationPlanSchema.nullable().optional(),
  cleanPrompt: z.string().min(1),
  infoPrompt: z.string().min(1),
  // 새 설명 컷(2026-10-06): 그래픽이 생기는 순서와 구간 계획. 예전 내보내기 파일에는 없다.
  graphicOrder: z.array(z.string()).default([]),
  plan: ClipPlanSchema.default(() => emptyClipPlan()),
  // 예전 설명 컷(글자 대조)만 채운다. 새 설명 컷은 비어 있다(INFO 에 글자 없음).
  infoLines: z.array(z.string()).default([]),
  // 혼합형 설명 장면(2026-10-07, H4): 장면 종류·물체(색 + 대본 subjects 의 외형)·동작 순서·강조. 예전·immersive 내보내기에는 없다.
  sceneType: z.enum(["", ...EXPLAINER_SCENE_TYPES]).default(""),
  objects: z.array(FlowExportObjectSchema).default([]),
  actions: z.array(z.string()).default([]),
  emphasis: z.array(ExplainerEmphasisSchema).default([]),
  motionPrompt: z.string().min(1),
  cleanFile: z.string().min(1),
  infoFile: z.string().min(1),
  outputFile: z.string().min(1),
  suggestedModel: z.enum(FLOW_MODELS),
  imageImportCommands: z.array(z.string()).length(2),
  importCommand: z.string().min(1),
});
export type FlowExportInfoClip = z.infer<typeof FlowExportInfoClipSchema>;
export const FlowExportSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  number: z.number().int().min(1).max(10),
  title: z.string(),
  flowUrl: z.literal(FLOW_URL),
  // 대본의 시각 정책(혼합형이면 번들·화면이 실사/설명 세계 확인 항목을 보인다). 예전 내보내기·예전 대본에는 없다.
  visualPolicy: VisualPolicySchema.optional(),
  checklist: z.array(z.string()).min(1),
  clips: z.array(FlowExportClipSchema),
  infoClips: z.array(FlowExportInfoClipSchema).default([]),
});
export type FlowExport = z.infer<typeof FlowExportSchema>;
// 미리 보기(GET /api/jobs/:id/videos/:n/flow-export, 화면 FlowPanel): 시작 이미지가 아직 없으면 startImageArtifact 가 비어 있다.
// 저장 산출물(flow-export-<n>.json)은 시작 이미지 검증 뒤에 만들므로 FlowExportSchema(이름 필수)를 그대로 쓴다.
export const FlowExportPreviewSchema = FlowExportSchema.extend({
  clips: z.array(FlowExportClipSchema.extend({ startImageArtifact: z.string() })),
});
export type FlowExportPreview = z.infer<typeof FlowExportPreviewSchema>;

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
  return [...script.veoClips, ...script.infoClips]
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

// 번들 공통 순서(instructions/flow.md FLOW_CHECKLIST 절, 한 줄 = 한 단계, {{model}} = 추천 모델). 빈 줄은 건너뛴다.
export function flowChecklist(
  model: FlowModel,
  texts: Pick<FlowTexts, "FLOW_CHECKLIST">,
): string[] {
  return fillTemplate(texts.FLOW_CHECKLIST, { model })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 클립 단계가 쓰는 내보내기 데이터. 시각 같은 값은 넣지 않아 같은 입력이면 같은 JSON 이 나온다.
// 고정 문장(프롬프트 꼬리·설명 컷 문장·체크리스트)은 texts(instructions/flow.md)에서 온다 — 서버는 server/flow-instructions.ts
// flowExportFor() 로 로더의 글을 채워 부르고, 화면은 그 결과(JSON)를 받는다.
export function buildFlowExport(job: Job, number: number, texts: FlowTexts): FlowExport {
  const script = videoScriptFor(job, number);
  if (!script) throw new Error(`영상 ${number} 의 대본이 없습니다.`);
  const policy = job.automation?.policy;
  const model = script.infoClips.some((clip) => clip.labelLayer)
    ? "Veo 3.1 - Lite"
    : suggestedFlowModel(policy?.mode === "creative" ? policy.videoModel : undefined);
  const render = job.renders.find((item) => item.number === number);
  const kind = videoPolicyOf(script);
  const immersive = kind === "immersive";
  const hybrid = kind === "hybrid";
  const explainer: ExplainerContext = {
    explainerAnchor: script.explainerAnchor,
    subjects: script.subjects,
  };
  const checklist = flowChecklist(model, texts);
  // 설명 컷이 있을 때 덧붙이는 순서. 혼합형 설명 장면 / 새 설명 컷(글자 없음) / 예전 설명 컷(지정 문구 대조)의 문구가 다르다.
  if (script.infoClips.some((clip) => clip.labelLayer))
    checklist.push(texts.FLOW_INFO_CHECKLIST_HF);
  if (script.infoClips.some((clip) => isExplainerScene(clip) && !clip.labelLayer))
    checklist.push(texts.FLOW_INFO_CHECKLIST_EXPLAINER);
  if (hybrid) checklist.push(texts.FLOW_HYBRID_EYE_CHECK);
  if (script.infoClips.some((clip) => !isExplainerScene(clip) && !infoClipExpectsText(clip)))
    checklist.push(texts.FLOW_INFO_CHECKLIST_NO_TEXT);
  // 혼합형 설명 장면의 INFO 문구(infoLines, 2026-10-08)는 FLOW_INFO_CHECKLIST_EXPLAINER 가 설명하므로 예전 지정 문구 항목은 넣지 않는다.
  if (script.infoClips.some((clip) => !isExplainerScene(clip) && infoClipExpectsText(clip)))
    checklist.push(texts.FLOW_INFO_CHECKLIST_LINES);
  const visualPolicy = script.planning?.visualPolicy;
  return {
    version: 1,
    jobId: job.id,
    number,
    title: script.title,
    flowUrl: FLOW_URL,
    ...(visualPolicy ? { visualPolicy } : {}),
    checklist,
    clips: script.veoClips.map((clip) => ({
      id: clip.id,
      startImageArtifact: render?.startImages[clip.id]?.name ?? "",
      startImageFile: flowStartImageFile(number, clip.id),
      // 혼합형 실사 클립은 사람이 있는 실제 장소의 촬영 영상 문구를 꼬리에 더한다(H3).
      prompt: clipPrompt(clip, texts, { liveAction: hybrid }),
      plan: clip.plan,
      aspectRatio: FLOW_ASPECT_RATIO,
      durationSec: VEO_CLIP_SEC,
      suggestedModel: model,
      outputFile: flowOutputFile(number, clip.id),
      importCommand: `bun run flow import ${job.id} ${number} ${clip.id} <내려받은-파일-경로>`,
    })),
    infoClips: script.infoClips.map((clip) => ({
      id: clip.id,
      stage: clip.stage,
      ...(clip.labelLayer ? { labelLayer: structuredClone(clip.labelLayer) } : {}),
      ...(clip.explanation ? { explanation: clip.explanation } : {}),
      cleanPrompt: infoCleanPrompt(clip, script.styleAnchor, texts, { immersive, explainer }),
      infoPrompt: infoOverlayPrompt(clip, texts, { immersive, explainer }),
      graphicOrder: clip.graphicOrder,
      plan: clip.plan,
      infoLines: infoTextLines(clip),
      sceneType: clip.sceneType,
      objects: clip.objects.map((object) => ({
        ...object,
        traits: script.subjects.find((subject) => subject.id === object.subjectId)?.traits ?? "",
      })),
      actions: [...clip.actions],
      emphasis: clip.emphasis.map((item) => ({ ...item })),
      motionPrompt: infoMotionPrompt(clip, texts, { immersive, explainer }),
      cleanFile: flowCleanImageFile(number, clip.id),
      infoFile: flowInfoImageFile(number, clip.id),
      outputFile: flowOutputFile(number, clip.id),
      suggestedModel: clip.labelLayer ? "Veo 3.1 - Lite" : model,
      imageImportCommands: [
        `bun run flow import-image ${job.id} ${number} ${clip.id} clean <CLEAN-이미지-경로>`,
        `bun run flow import-image ${job.id} ${number} ${clip.id} info <INFO-이미지-경로>`,
      ],
      importCommand: `bun run flow import ${job.id} ${number} ${clip.id} <내려받은-파일-경로>`,
    })),
  };
}

export { flowExportMarkdown } from "./flow-export-markdown";
export {
  EXPLAINER_COLOR_LABELS,
  EXPLAINER_EMPHASIS_LABELS,
  EXPLAINER_SCENE_LABELS,
  type ExplainerContext,
  hybridCleanPrompt,
  hybridMotionPrompt,
  hybridOverlayPrompt,
  INFO_GRAPHIC_BAND,
  infoCleanPrompt,
  infoClipExpectsText,
  infoMotionPrompt,
  infoOverlayPrompt,
  infoTextLines,
} from "./flow-info-prompts";
export { FLOW_TEXT_KEYS, type FlowTextKey, type FlowTexts } from "./flow-texts";
// 내보낸 설명 컷이 혼합형 설명 장면인가(번들·화면이 같은 기준으로 가른다).
export function flowClipIsExplainerScene(clip: Pick<FlowExportInfoClip, "sceneType">): boolean {
  return clip.sceneType !== "";
}
