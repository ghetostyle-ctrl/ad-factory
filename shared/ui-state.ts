import type { AutomationState } from "./automation";
import type { CreativeVariant } from "./creative-plan";
import { pendingFlowClips, waitingVideoNumber } from "./flow-mode";
import { canReviewPlan } from "./plan-recovery";
import type { AgentState, Job } from "./schema";
import { pendingScriptApprovals } from "./script-approval";
import { pendingScriptDraft } from "./script-drafts";

// UI v2 상태 어휘 1벌(docs/UI-V2-2026-10-12.md 2절). 화면은 상태를 직접 번역하지 않고 이 파일의 결과를 읽는다.
// 계열 5개: 진행 중 · 당신 차례 · 완료 · 멈춤 · 대기. 순수 함수만 두고 서버 데이터는 바꾸지 않는다.
export type UiFamily = "progress" | "yourTurn" | "done" | "stopped" | "idle";
export type UiState = {
  readonly family: UiFamily;
  // "당신 차례 · 대본 승인"처럼 계열 머리 + 할 일(완료·대기는 머리만)
  readonly label: string;
  // 한 문장(없으면 "")
  readonly detail: string;
};

// 단계 이름(사용자 언어). stage~finished 는 범위 밖(Meta 게시·성과)이라 라벨만 유지한다.
export const PHASE_LABELS: Record<AutomationState["phase"], string> = {
  strategy: "자료 분석",
  creative: "광고안",
  script: "대본",
  image: "광고 이미지",
  video: "영상",
  voice: "내레이션",
  stills: "정지 이미지",
  startImages: "시작 이미지",
  clips: "클립",
  graphics: "설명 라벨 합성",
  assemble: "조립",
  review: "이미지 검토",
  stage: "Meta 준비",
  activate: "게시",
  insights: "성과",
  report: "분석",
  finished: "종료",
};

const FAMILY_HEADS: Record<UiFamily, string> = {
  progress: "진행 중",
  yourTurn: "당신 차례",
  done: "완료",
  stopped: "멈춤",
  idle: "대기",
};
function state(family: UiFamily, tail: string, detail = ""): UiState {
  const head = FAMILY_HEADS[family];
  return { family, label: tail ? `${head} · ${tail}` : head, detail };
}

// 서버가 만든 실행 기록 문장을 화면용으로만 바꾼다(원문·서버 데이터는 그대로).
// "h10 · 카드뉴스 3장 완성" → "광고안 10 · 카드뉴스 3장 완성", "(flow-export-9.md 참고)"·"(…FLOW-MODE.md…)" 제거.
// '세그먼트'는 컷과 뜻이 달라 바꾸지 않는다.
const FILE_HINT =
  /\s*\([^()]*(?:\b[\w-]+\.(?:md|json|txt|csv|ts|tsx|js|mjs|sh|ps1|mp4|mp3|wav|png|jpe?g)\b|FLOW-MODE)[^()]*\)/giu;
export function humanizeEventMessage(text: string): string {
  return text
    .replace(/\bh(\d+) ·/gu, "광고안 $1 ·")
    .replace(FILE_HINT, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trimEnd();
}

// 모델이 붙인 enum 접두("mechanism_explainer | 맛 접촉 경로")를 벗긴다. 화면 직전 한 곳에서만 쓴다.
export function stripEnumPrefix(text: string): string {
  return text.replace(/^[a-z_]+ \| /u, "");
}

// 첫 문장(줄바꿈·마침표 기준). 마침표는 뒤가 공백/끝일 때만 문장 끝으로 본다("8.0초"는 자르지 않는다).
// 서버가 붙이는 " · 자동 실행 중지" 꼬리와 파일 안내는 걷어내고, max 자를 넘으면 …로 자른다.
export function firstSentence(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  const cleaned = humanizeEventMessage(text).replace(/\s*·\s*자동 실행 중지\s*$/u, "");
  const line =
    cleaned
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const matched = /^(.*?[.!?。！？])(?=\s|$)/u.exec(line);
  const sentence = (matched?.[1] ?? line).replace(/[.!?。！？]+$/u, "").trim();
  return sentence.length > max ? `${sentence.slice(0, Math.max(1, max - 1)).trimEnd()}…` : sentence;
}

const AGENT_STAGES: Record<AgentState["id"], string> = {
  strategy: PHASE_LABELS.strategy,
  creative: PHASE_LABELS.creative,
  production: "제작",
  deployment: PHASE_LABELS.stage,
  analysis: PHASE_LABELS.report,
};

// 에이전트(단계) 한 칸의 상태. stage 를 주면 "진행 중 · {stage}"로 적는다(없으면 queued 는 '곧 시작', running 은 '제작').
export function agentUiState(status: AgentState["status"], stage?: string): UiState {
  switch (status) {
    case "idle":
      return state("idle", "");
    case "queued":
      return state("progress", stage ?? "곧 시작", "곧 시작해요.");
    case "running":
      return state("progress", stage ?? "제작", "진행하고 있어요.");
    case "blocked":
      return state("yourTurn", "연결 설정", "연결 설정을 마치면 이어서 진행해요.");
    case "review":
      return state("yourTurn", "확인", "결과를 확인해 주세요.");
    case "completed":
      return state("done", "");
    case "cancelled":
      return state("stopped", "중지함", "중지한 작업이에요.");
    case "failed":
      return state("stopped", "실패", "작업이 실패했어요.");
  }
}

// 자동 제작·운영 상태. 사용자 선택을 기다리는 기획 선택·대본 초안은 automation.status 보다 먼저 본다.
export function automationUiState(automation: AutomationState, job: Job): UiState {
  if (canReviewPlan(job))
    return state(
      "yourTurn",
      "기획 선택",
      "저장된 광고안을 확인하고 현재 기획으로 제작할지 다시 기획할지 고르세요.",
    );
  const draft = pendingScriptDraft(job);
  if (draft)
    return state(
      "yourTurn",
      "대본 초안 수정",
      `영상 ${draft.number} 대본 형식 문제로 초안을 보관했어요.`,
    );
  const creative = automation.policy.mode === "creative";
  const phase = PHASE_LABELS[automation.phase];
  switch (automation.status) {
    case "queued":
      return state("progress", phase, `${phase} 단계를 곧 시작해요.`);
    case "running":
      return state("progress", phase, `${phase} 단계를 진행하고 있어요.`);
    case "blocked":
      return state("yourTurn", "연결 설정", "연결 설정을 마치면 하던 일을 이어서 진행해요.");
    case "attention":
      return state(
        "yourTurn",
        "확인",
        firstSentence(automation.lastError ?? job.result) || "처리 결과를 확인해야 해요.",
      );
    case "stopped":
      return state("stopped", "중지함", "자동 제작을 중지했어요. 이어서 진행할 수 있어요.");
    case "completed":
      return state("done", "", creative ? "제작을 마쳤어요." : "운영을 마쳤어요.");
    case "waiting": {
      // 소재 제작의 waiting 은 분석 예약이 아니라 사용자 작업 대기다(실패가 아님).
      if (!creative) return state("idle", "", "예약 시각에 실제 성과를 조회하고 분석해요.");
      if (automation.phase === "script") {
        const count = pendingScriptApprovals(job).length;
        return state(
          "yourTurn",
          "대본 승인",
          count > 0
            ? `대본 ${count}편이 승인을 기다려요.`
            : "대본을 확인하고 승인하면 이어서 진행해요.",
        );
      }
      if (["image", "stills", "startImages"].includes(automation.phase))
        return state(
          "yourTurn",
          "Flow 이미지 올리기",
          "Flow에서 만든 이미지를 올리면 이어서 진행해요.",
        );
      const number = waitingVideoNumber(job);
      const missing = number === null ? 0 : pendingFlowClips(job, number).length;
      return state(
        "yourTurn",
        "Flow 클립 올리기",
        number !== null && missing > 0
          ? `영상 ${number}의 클립 ${missing}개를 기다려요.`
          : "Flow에서 만든 클립을 올리면 이어서 진행해요.",
      );
    }
  }
}

// 작업 1개의 상태. 자동 제작이 있으면 그 상태를, 없는 예전 작업은 job.status 로 읽는다.
export function jobUiState(job: Job): UiState {
  if (job.automation) return automationUiState(job.automation, job);
  switch (job.status) {
    case "queued":
    case "running": {
      const running = job.agents.find((agent) => agent.status === "running");
      // 새로 만든 작업은 status 가 queued 지만 아직 아무 단계도 돌지 않았다 → 시작 전은 '대기'
      if (job.status === "queued" && !running) return state("idle", "", "아직 시작하지 않았어요.");
      return agentUiState(job.status, running ? AGENT_STAGES[running.id] : undefined);
    }
    case "failed": {
      const cause = firstSentence(job.result, 40);
      return state("stopped", cause || "실패", firstSentence(job.result) || "작업이 실패했어요.");
    }
    default:
      return agentUiState(job.status);
  }
}

// 광고안(소재) 1개의 상태. 이미지 검토를 통과하면 완료, 제작 중이면 진행 중, 그 밖은 작업 상태를 따른다.
export function variantUiState(variant: CreativeVariant | undefined, job: Job): UiState {
  if (variant?.reviewStatus === "pass") return state("done", "", "이미지 검토를 통과했어요.");
  const automation = job.automation;
  if (automation) {
    switch (automation.status) {
      case "attention":
        return state(
          "yourTurn",
          "확인",
          firstSentence(automation.lastError ?? job.result) || "처리 결과를 확인해야 해요.",
        );
      case "blocked":
        return state("yourTurn", "연결 설정", "연결 설정을 마치면 이어서 진행해요.");
      case "stopped":
        return state("stopped", "중지함", "자동 제작을 중지했어요.");
      case "completed":
        return state("done", "", "제작을 마쳤어요.");
      case "queued":
      case "waiting":
        return state("idle", "", "다음 차례를 기다려요.");
      case "running": {
        const current = job.creativeVariants.find((item) => item.reviewStatus !== "pass");
        if (variant && current?.id === variant.id) {
          if (automation.phase === "image")
            return variant.reviewStatus === "revise"
              ? state("progress", "수정 중", "이미지를 고쳐 다시 만들고 있어요.")
              : state("progress", "이미지 제작", "이미지를 만들고 있어요.");
          if (automation.phase === "review")
            return state("progress", "검토", "이미지와 카피를 검토하고 있어요.");
        }
        break;
      }
    }
  }
  if (variant?.reviewStatus === "revise")
    return state("progress", "수정 중", "검토에서 고칠 점이 나와 이미지를 고쳐야 해요.");
  return variant?.imageAttempts
    ? state("idle", "", "제작과 검토를 기다려요.")
    : state("idle", "", "이미지 제작을 기다려요.");
}

// Flow 클립 슬롯 1개: 검증 실패가 업로드됨보다 앞선다(다시 올린 파일이 실패했을 때).
export function flowClipUiState(uploaded: boolean, failed: boolean): UiState {
  if (failed)
    return state("stopped", "검증 실패", "올린 파일이 조건에 맞지 않아요. 다시 올려 주세요.");
  if (uploaded) return state("done", "", "클립을 올렸어요.");
  return state("yourTurn", "올리기", "Flow에서 만든 클립을 올려 주세요.");
}
