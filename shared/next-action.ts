import { flowImagesOf } from "./flow-images";
import { pendingFlowClips, videoScriptFor, waitingVideoNumber } from "./flow-mode";
import { canReviewPlan } from "./plan-recovery";
import type { Job } from "./schema";
import { pendingScriptApprovals, scriptNeedsFix } from "./script-approval";
import { pendingScriptDraft } from "./script-drafts";
import { firstSentence, jobUiState, PHASE_LABELS } from "./ui-state";

// "지금 할 일" 카드 1장의 내용(docs/UI-V2-2026-10-12.md 8절). 화면은 작업 상태를 직접 읽지 않고 nextAction(job) 결과만 그린다.
// 순수 함수만 둔다 — 명령(command)은 이름만 돌려주고 실행은 화면(④)이 한다.
export type NextActionKind = "start" | "yourTurn" | "progress" | "done" | "stopped";
export type NextActionCommand =
  | { readonly type: "start" } // 설정 창 열기
  | { readonly type: "resume" } // POST automation/resume {confirmation:true}
  | { readonly type: "approveScripts"; readonly numbers: readonly number[] }
  | { readonly type: "openVideo"; readonly number: number } // 대본·영상 탭 n
  | { readonly type: "openSettings" }
  | { readonly type: "reviewPlan" }
  | { readonly type: "downloadFinals"; readonly numbers: readonly number[] }
  | { readonly type: "stop" };
export type NextActionFact = {
  readonly label: string;
  readonly value: string;
  readonly unit: "편" | "개" | "장" | "";
};
export type NextActionButton = {
  readonly label: string;
  readonly command: NextActionCommand;
};
export type NextAction = {
  readonly kind: NextActionKind;
  // 라벨 뒤 "멈춘 이유: …" (yourTurn/stopped 에서 이유가 있을 때만, 없으면 "")
  readonly reason: string;
  // 동사형 한 문장
  readonly title: string;
  // 왜·얼마나 한두 문장
  readonly detail: string;
  // 최대 4개
  readonly facts: readonly NextActionFact[];
  readonly primary: NextActionButton | null;
  readonly secondary: NextActionButton | null;
  readonly videoNumber: number | null;
};
export type JobProgress = {
  readonly done: number;
  readonly total: number;
  readonly yourTurn: number;
  readonly waiting: number;
  // 완성 영상 길이 합(초). 길이를 모르는 영상이 하나라도 있으면 null(지어내지 않는다).
  readonly totalSec: number | null;
};

const FINAL_FILE = /^video-final-([1-9][0-9]*)\.mp4$/u;
// 완성된 영상 번호: renders[n].final 이 있거나(FinalVideo 와 같은 기준), 예전 작업처럼 video-final-<n>.mp4 산출물만 있는 것.
function finalNumbers(job: Job): number[] {
  const numbers = new Set<number>();
  for (const render of job.renders) if (render.final) numbers.add(render.number);
  for (const artifact of job.artifacts) {
    const matched = FINAL_FILE.exec(artifact.name);
    if (matched?.[1]) numbers.add(Number(matched[1]));
  }
  return [...numbers].sort((left, right) => left - right);
}
function videoTotal(job: Job): number {
  const policy = job.automation?.policy;
  return policy?.mode === "creative"
    ? (policy.videoCount ?? job.videoScripts.length)
    : job.videoScripts.length;
}

export function jobProgress(job: Job): JobProgress {
  const finals = finalNumbers(job);
  const done = finals.length;
  const total = Math.max(videoTotal(job), done);
  const automation = job.automation;
  // 사용자를 기다리는 영상: 대본 승인 대기(phase script)와 Flow 대기 영상. 겹치는 번호는 한 번만 센다.
  const counted = new Set<number>();
  if (automation?.status === "waiting" && automation.policy.mode === "creative") {
    if (automation.phase === "script") for (const n of pendingScriptApprovals(job)) counted.add(n);
    else {
      const number = waitingVideoNumber(job);
      if (number !== null) counted.add(number);
    }
  }
  // 영상 번호로 셀 수 없는 사용자 차례(연결 설정·확인·기획 선택·대본 초안)도 최소 1로 센다.
  const yourTurn = Math.max(counted.size, jobUiState(job).family === "yourTurn" ? 1 : 0);
  let totalSec: number | null = null;
  if (done > 0) {
    let milliseconds = 0;
    let known = true;
    for (const number of finals) {
      const final = job.renders.find((render) => render.number === number)?.final;
      if (final) milliseconds += final.durationMs;
      else known = false;
    }
    if (known) totalSec = Math.round(milliseconds / 100) / 10;
  }
  return { done, total, yourTurn, waiting: Math.max(0, total - done - yourTurn), totalSec };
}

const fact = (
  label: string,
  value: number | string,
  unit: NextActionFact["unit"],
): NextActionFact => ({
  label,
  value: String(value),
  unit,
});
const button = (label: string, command: NextActionCommand): NextActionButton => ({
  label,
  command,
});
const RESUME = button("이어서 진행", { type: "resume" });
// 영상이 없는 작업(광고 이미지만)은 0/0 을 보이지 않는다.
function finalsFacts(progress: JobProgress): NextActionFact[] {
  return progress.total > 0 ? [fact("완성 영상", `${progress.done}/${progress.total}`, "편")] : [];
}
function durationText(seconds: number): string {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}초` : `${Math.floor(whole / 60)}분 ${whole % 60}초`;
}

// 영상 번호가 있는 단계(이 영상이 끝나야 다음 영상으로 넘어간다)
const VIDEO_PHASES = new Set(["voice", "stills", "startImages", "clips", "graphics", "assemble"]);

export function nextAction(job: Job): NextAction {
  const automation = job.automation;
  const progress = jobProgress(job);
  const base = {
    reason: "",
    detail: "",
    facts: finalsFacts(progress),
    primary: null,
    secondary: null,
    videoNumber: null,
  } satisfies Omit<NextAction, "kind" | "title">;

  // ① 대본 초안 보관: 형식 문제로 멈춘 초안을 고치거나 다시 쓴다
  const draft = pendingScriptDraft(job);
  if (draft)
    return {
      ...base,
      kind: "yourTurn",
      reason: "대본 형식 문제로 초안을 보관했어요",
      title: `영상 ${draft.number} 대본 초안을 고치거나 다시 쓰세요`,
      detail:
        "오류와 응답 원문을 확인한 뒤 고치거나 다시 쓸 수 있어요. 다시 쓰면 같은 설정의 API 비용이 들어요.",
      primary: button(`영상 ${draft.number} 대본 열기`, {
        type: "openVideo",
        number: draft.number,
      }),
      secondary: RESUME,
      videoNumber: draft.number,
    };

  // ② 기획 선택 대기: 저장된 광고안을 쓸지 다시 기획할지
  if (canReviewPlan(job))
    return {
      ...base,
      kind: "yourTurn",
      reason: firstSentence(automation?.lastError ?? job.result),
      title: "저장된 광고안을 확인하고 선택하세요",
      detail: "현재 기획으로 제작하거나 다시 기획할 수 있어요. 고른 뒤에 제작이 이어져요.",
      facts: [],
      primary: button("광고안 확인", { type: "reviewPlan" }),
    };

  if (automation) {
    const creative = automation.policy.mode === "creative";

    // ③ 연결 설정이 필요해 멈춤
    if (automation.status === "blocked")
      return {
        ...base,
        kind: "yourTurn",
        reason: firstSentence(automation.lastError ?? job.result) || "필요한 연결이 빠져 있어요",
        title: "연결 설정을 마치면 이어서 진행합니다",
        detail: "필요한 키나 도구를 연결 설정에서 채우면 하던 일을 이어서 진행해요.",
        primary: button("연결 설정 열기", { type: "openSettings" }),
        secondary: RESUME,
      };

    if (automation.status === "waiting" && creative) {
      // ④ 대본 승인 대기
      if (automation.phase === "script") {
        const pending = pendingScriptApprovals(job);
        const needsFix = pending.filter((number) => scriptNeedsFix(job, number));
        const approvable = pending.filter((number) => !needsFix.includes(number));
        const first = pending[0];
        if (first === undefined)
          return {
            ...base,
            kind: "yourTurn",
            title: "대본 승인 상태를 다시 확인하세요",
            detail: "승인을 마쳤다면 이어서 진행하면 바로 다음 단계로 넘어가요.",
            primary: RESUME,
          };
        return {
          ...base,
          kind: "yourTurn",
          title: `영상 ${first} 대본을 확인하고 승인하세요`,
          detail:
            needsFix.length > 0
              ? `규칙을 통과하지 못한 초안 ${needsFix.length}편은 고치거나 다시 쓴 뒤에만 승인할 수 있어요.`
              : "승인하면 내레이션 합성부터 유료 제작이 이어져요.",
          facts: [
            fact("승인 대기", pending.length, "편"),
            fact("규칙 미통과", needsFix.length, "편"),
            ...finalsFacts(progress),
          ],
          primary: button(`영상 ${first} 대본 열기`, { type: "openVideo", number: first }),
          secondary:
            approvable.length > 0
              ? button(`대본 ${approvable.length}편 승인`, {
                  type: "approveScripts",
                  numbers: approvable,
                })
              : null,
          videoNumber: first,
        };
      }
      // ⑤ Flow 이미지 올리기
      if (["image", "stills", "startImages"].includes(automation.phase)) {
        const number = waitingVideoNumber(job);
        const waitingImages = flowImagesOf(job).filter((request) => request.digest === null);
        return {
          ...base,
          kind: "yourTurn",
          title: "Flow 이미지를 만들어 올리세요",
          detail: "이미지를 올리면 검토를 마치고 다음 단계가 자동으로 이어져요.",
          facts: [fact("대기", waitingImages.length, "장"), ...finalsFacts(progress)],
          primary:
            number === null ? null : button(`영상 ${number} 열기`, { type: "openVideo", number }),
          secondary: RESUME,
          videoNumber: number,
        };
      }
      // ⑥ Flow 클립 올리기
      const number = waitingVideoNumber(job);
      const script = number === null ? undefined : videoScriptFor(job, number);
      const clipTotal = script ? script.veoClips.length + script.infoClips.length : 0;
      const missing = number === null ? 0 : pendingFlowClips(job, number).length;
      if (number === null || missing === 0)
        return {
          ...base,
          kind: "yourTurn",
          title:
            number === null
              ? "Flow 클립을 올린 뒤 이어서 진행하세요"
              : `영상 ${number} 클립을 모두 올렸어요. 이어서 진행하세요`,
          detail: "클립이 모두 채워졌다면 이어서 진행하면 바로 조립이 시작돼요.",
          primary: RESUME,
          videoNumber: number,
        };
      return {
        ...base,
        kind: "yourTurn",
        title: `영상 ${number} 클립 ${missing}개를 Flow에서 만들어 올리세요`,
        detail: "클립이 모두 올라오면 자동으로 조립을 이어가고, 다음 영상의 준비물을 알려 드려요.",
        facts: [
          fact("올린 클립", `${clipTotal - missing}/${clipTotal}`, "개"),
          ...finalsFacts(progress),
          fact("남은 영상", Math.max(0, progress.total - progress.done), "편"),
        ],
        primary: button(`영상 ${number} Flow 지시서 보기`, { type: "openVideo", number }),
        secondary: RESUME,
        videoNumber: number,
      };
    }

    // ⑦ 확인이 필요해 멈춤(외부 요청 결과 불확실 등)
    if (automation.status === "attention") {
      const uncertain = job.renders.some((render) =>
        Object.values(render.clips).some(
          (clip) => clip?.pendingSince && !clip.operation && !clip.name,
        ),
      );
      return {
        ...base,
        kind: "yourTurn",
        reason: firstSentence(automation.lastError ?? job.result) || "처리 결과를 확인해야 해요",
        title: "멈춘 이유를 확인하고 이어서 진행하세요",
        detail: uncertain
          ? "일부 클립 요청 결과가 불확실해요. 공급자 사용량을 확인한 뒤 이어서 진행하면 그 클립만 다시 만들어요."
          : "저장된 결과는 그대로 두고 남은 단계부터 다시 시도해요.",
        primary: RESUME,
      };
    }

    // ⑧ 중지함
    if (automation.status === "stopped")
      return {
        ...base,
        kind: "stopped",
        reason: firstSentence(job.result),
        title: "중지한 작업을 이어서 진행할 수 있어요",
        detail:
          progress.done > 0
            ? `완성 영상 ${progress.done}편은 그대로 남아 있고, 이어서 진행하면 남은 단계부터 다시 해요.`
            : "이어서 진행하면 저장된 결과는 그대로 두고 남은 단계부터 다시 해요.",
        primary: RESUME,
      };

    // ⑨ 진행 중
    if (automation.status === "running" || automation.status === "queued") {
      const phase = PHASE_LABELS[automation.phase];
      return {
        ...base,
        kind: "progress",
        title: `${phase} 진행 중`,
        detail: "지금은 할 일이 없어요. 끝나면 자동으로 다음 단계로 넘어가요.",
        secondary: button("중지", { type: "stop" }),
        videoNumber: VIDEO_PHASES.has(automation.phase) ? waitingVideoNumber(job) : null,
      };
    }

    // ⑩ 완료
    if (automation.status === "completed") {
      const finals = finalNumbers(job);
      if (!creative)
        return {
          ...base,
          kind: "done",
          title: "운영을 마쳤어요",
          detail: "결과를 확인하세요.",
          facts: [],
        };
      if (finals.length === 0)
        return {
          ...base,
          kind: "done",
          title: "광고 이미지 제작을 마쳤어요",
          detail: "만든 이미지와 카드뉴스는 파일에서 확인하고 받을 수 있어요.",
          facts: [],
        };
      return {
        ...base,
        kind: "done",
        title: `완성 영상 ${finals.length}편을 받으세요`,
        detail: "완성 영상은 영상 보드에서 하나씩 보거나 한 번에 받을 수 있어요.",
        facts: [
          ...finalsFacts(progress),
          ...(progress.totalSec === null
            ? []
            : [fact("총 길이", durationText(progress.totalSec), "")]),
        ],
        primary: button(`완성 영상 ${finals.length}편 모두 받기`, {
          type: "downloadFinals",
          numbers: finals,
        }),
      };
    }
  }

  // 광고 운영(범위 밖)의 예약 대기: 사용자가 할 일은 없다
  if (automation?.status === "waiting")
    return {
      ...base,
      kind: "progress",
      title: "다음 성과 분석을 기다리는 중이에요",
      detail: "예약 시각에 실제 성과를 조회하고 분석해요.",
      facts: [],
    };

  // ⑪ 아직 시작하지 않은 새 작업
  if (!automation && job.artifacts.length === 0 && !job.staged)
    return {
      ...base,
      kind: "start",
      title: "자료로 광고안과 영상을 만들기 시작하세요",
      detail:
        "상품 자료와 이미지 모델을 확인한 뒤 시작해요. 광고 계정이나 예산 없이 소재만 만들어요.",
      facts: [],
      primary: button("시작", { type: "start" }),
    };

  // ⑫ 그 밖(자동 제작 이전에 만든 예전 작업, 광고 운영 대기 등): job.status 기준 단순 매핑
  switch (job.status) {
    case "queued":
    case "running":
      return {
        ...base,
        kind: "progress",
        title: "작업을 진행 중이에요",
        detail: "끝나면 알려 드려요.",
      };
    case "completed":
      return {
        ...base,
        kind: "done",
        title: "만든 결과를 확인하세요",
        detail: "예전 방식으로 만든 작업이에요. 결과는 파일에서 확인하고 받을 수 있어요.",
        facts: [],
      };
    case "blocked":
      return {
        ...base,
        kind: "yourTurn",
        reason: firstSentence(job.result),
        title: "연결 설정을 확인하세요",
        detail: "필요한 연결을 채우면 이어서 진행할 수 있어요.",
        facts: [],
        primary: button("연결 설정 열기", { type: "openSettings" }),
      };
    case "review":
      return {
        ...base,
        kind: "yourTurn",
        reason: firstSentence(job.result),
        title: "결과를 확인하세요",
        detail: "만든 결과를 확인한 뒤 다음 일을 정하세요.",
        facts: [],
      };
    case "failed":
    case "cancelled":
      return {
        ...base,
        kind: "stopped",
        reason: firstSentence(job.result),
        title: "중지된 작업이에요",
        detail: "이 작업은 이어서 진행할 수 없어요. 파일에서 남은 결과를 확인하세요.",
        facts: [],
      };
  }
}
