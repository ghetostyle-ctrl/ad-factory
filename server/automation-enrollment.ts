import { rmSync } from "node:fs";
import { join } from "node:path";
import { type AutomationPolicy, AutomationPolicySchema } from "../shared/automation";
import type { Job } from "../shared/schema";
import { AutomationGuard, scopeDigest, validatePolicy } from "./automation-guard";
import { StudioError } from "./errors";
import { evidencePack } from "./evidence-pack";
import { snapshotModels } from "./model-settings";
import type { JobStore } from "./store";

// 응답 수신과 핸들 저장 사이에 끊겨 Veo 생성 여부가 불확실한 클립(영상 번호별 클립 ID).
function uncertainClipIds(job: Job): string[] {
  return job.renders.flatMap((render) =>
    Object.entries(render.clips).flatMap(([clipId, clip]) =>
      clip?.pendingSince && !clip.operation && !clip.name ? [clipId] : [],
    ),
  );
}
export class AutomationEnrollment {
  constructor(readonly store: JobStore) {}
  start(id: string, input: AutomationPolicy): Job {
    // scopeDigest 는 정책 JSON 을 해시한다. 저장된 작업은 스키마 키 순서로 읽히므로, 호출자가 넘긴 키 순서와
    // 상관없이 같은 해시가 나오도록 먼저 스키마로 정규화한다(라우트 validator 를 거치지 않는 직접 호출 포함).
    const policy = AutomationPolicySchema.parse(input);
    const job = this.store.get(id);
    if (job.automation || job.staged || job.status === "running" || job.artifacts.length > 0)
      throw new StudioError(
        "enrolled",
        "산출물이나 실행 이력이 없는 새 작업에서 자동 운영 범위를 승인하세요.",
      );
    validatePolicy(job, policy);
    if (job.sourceSnapshot && evidencePack(job.sourceSnapshot).facts.length === 0)
      throw new StudioError(
        "source_facts",
        "확인된 제품 사실 또는 오퍼 본문 자료가 있는 프로젝트로 새 작업을 만드세요.",
        400,
      );
    const models = job.executionModels ?? snapshotModels(this.store.root);
    if (
      models.textProvider === "none" ||
      (models.textProvider === "codex" && models.codexModel === null)
    )
      throw new StudioError(
        "model",
        "자동 운영에는 명시적인 텍스트 공급자와 모델 ID가 필요합니다. 모델 설정에서 선택하세요.",
        400,
      );
    const now = new Date().toISOString();
    const result = this.store.change(id, (draft) => {
      draft.executionModels = models;
      draft.automation = {
        policy,
        status: "queued",
        phase: "strategy",
        nextRunAt: now,
        nextAnalysisAt: null,
        lastError: null,
        authorizedAt: now,
        scopeDigest: scopeDigest(draft, policy),
        imageAttempts: 0,
        operation: null,
        videoOperation: null,
        stoppedAt: null,
        approvedImageId: null,
        approvedImageDigest: null,
        approvedCreativeDigest: null,
        approvedPlanDigest: null,
        lastAnalysisDigest: null,
      };
      draft.status = "queued";
      this.store.event(
        draft,
        null,
        "info",
        policy.mode === "creative"
          ? "소재 자동 제작 시작 · Meta 광고 계정 연결·게시·성과 조회 없음"
          : `자동 운영 범위 승인 완료 · ${policy.mode === "activate" ? "활성화 포함" : "PAUSED 준비만"} · 한도 ${policy.maxTotalSpend} ${draft.currency} · 종료 ${policy.endAt}`,
      );
      if (draft.sourceSnapshot)
        this.store.event(
          draft,
          null,
          "info",
          policy.mode === "creative"
            ? `자료 스냅샷 고정 · 이미지 ${policy.imageCount ?? 3}개 · 영상 ${policy.videoCount ?? 0}개(${policy.clipMode === "flow" ? "Veo 클립은 Google Flow 웹에서 직접 제작해 업로드" : "Veo 클립 최대 4개"}·정지 이미지 최대 14장·내레이션·완성본) · 이미지 각 최대 2회 · Meta 전송 없음`
            : "자료 스냅샷 고정 · 가설 3개 · 이미지 각 최대 2회(총 최대 6회) · 하나의 캠페인/광고 세트 예산 공유",
        );
    });
    return result;
  }
  resume(id: string): Job {
    const job = this.store.get(id);
    // 레거시 단일 클립(video) 또는 클립 단계(clips)에 저장된 Veo 핸들·불확실(pendingSince) 클립이 있는 경우
    const videoRecovery =
      job.automation?.status === "attention" &&
      ((job.automation.operation === "video" && job.automation.videoOperation !== null) ||
        (job.automation.operation === "clips" &&
          job.renders.some((render) =>
            Object.values(render.clips).some((clip) => clip?.operation || clip?.pendingSince),
          )));
    const retryableAiFailure =
      job.automation?.lastError?.startsWith("공급자 요청 실패 (HTTP ") === true ||
      job.automation?.lastError?.startsWith("AI 응답이 완료되지 않았습니다") === true ||
      job.automation?.lastError === "입력 또는 공급자 응답이 지원 형식과 일치하지 않습니다." ||
      job.automation?.lastError === "제품 주장 인용이 확인된 사실 자료 본문과 일치하지 않습니다.";
    const creativeStoppedRecovery =
      job.automation?.status === "stopped" && job.automation.policy.mode === "creative";
    // attention(확인 필요)과 Flow 클립 업로드 대기(waiting)는 소재 제작에서만 수동 재개를 허용한다.
    // waiting 은 업로드가 오면 자동으로 이어지지만, 사용자가 중지·재개하거나 직접 다시 확인시킬 수 있게 둔다.
    const creativeReviewRecovery =
      (job.automation?.status === "attention" || job.automation?.status === "waiting") &&
      job.automation.policy.mode === "creative";
    if (
      (!videoRecovery &&
        !creativeStoppedRecovery &&
        !creativeReviewRecovery &&
        !retryableAiFailure &&
        !["blocked", "stopped"].includes(job.automation?.status ?? "")) ||
      (job.automation?.operation &&
        !videoRecovery &&
        !retryableAiFailure &&
        !creativeStoppedRecovery &&
        !creativeReviewRecovery) ||
      job.staged?.pendingOperation
    )
      throw new StudioError(
        "reconcile",
        "안전한 설정 대기 작업만 재개할 수 있습니다. 불확실한 외부 요청은 광고 관리자에서 확인하세요.",
      );
    // 요청 중 중지돼 결과가 불확실한 Veo 클립이 있으면 곧바로 재생성하지 않는다. 중지 상태의 화면에는
    // '중복 과금 가능성' 경고가 없으므로, 경고가 보이는 attention 으로 바꾸고 사용자가 한 번 더 재개해야 재생성한다.
    const uncertain = [...new Set(uncertainClipIds(job))];
    if (job.automation?.status === "stopped" && uncertain.length > 0) {
      const message = `클립 ${uncertain.join(", ")} 의 Veo 요청 결과가 불확실합니다(중복 과금 가능성). 공급자 사용량을 확인한 뒤 다시 재개하면 새로 생성합니다.`;
      return this.store.change(id, (draft) => {
        if (draft.automation) {
          draft.automation.status = "attention";
          draft.automation.lastError = message;
          draft.automation.nextRunAt = null;
        }
        draft.status = "blocked";
        draft.result = message;
        this.store.event(draft, null, "warning", message);
      });
    }
    if (job.automation && (job.automation.status === "stopped" || creativeReviewRecovery)) {
      if (
        (retryableAiFailure || creativeStoppedRecovery || creativeReviewRecovery) &&
        job.automation.operation
      ) {
        this.store.change(id, (draft) => {
          if (draft.automation) draft.automation.operation = null;
        });
      }
      if (job.automation.scopeDigest !== scopeDigest(job, job.automation.policy))
        throw new StudioError("scope_changed", "중지 후 작업 범위가 변경되어 재개할 수 없습니다.");
    } else {
      new AutomationGuard(this.store).check(id, new AbortController().signal);
    }
    const result = this.store.change(id, (draft) => {
      if (draft.automation) {
        if (videoRecovery) draft.automation.operation = null;
        draft.automation.status = "queued";
        draft.automation.lastError = null;
        draft.automation.nextRunAt = new Date().toISOString();
      }
      // 사용자가 재개를 확인했으므로 '불확실' 표시를 지운다: 다음 실행이 그 클립을 다시 생성한다(중복 과금 ≤1회).
      for (const render of draft.renders)
        for (const clip of Object.values(render.clips))
          if (clip?.pendingSince && !clip.operation && !clip.name) clip.pendingSince = null;
      draft.status = "queued";
    });
    return result;
  }
  reset(id: string): Job {
    const job = this.store.get(id);
    if (job.status === "running")
      throw new StudioError("busy", "실행 중인 작업은 먼저 중지한 뒤 초기화하세요.");
    if (job.automation?.operation || job.staged?.pendingOperation)
      throw new StudioError("reconcile", "확인되지 않은 외부 작업이 있어 초기화할 수 없습니다.");
    rmSync(join(this.store.root, "render", job.id), { recursive: true, force: true });
    rmSync(join(this.store.root, "flow", job.id), { recursive: true, force: true });
    return this.store.change(id, (draft) => {
      draft.status = "queued";
      draft.automation = null;
      draft.executionModels = null;
      draft.creativePlan = null;
      draft.videoScripts = [];
      draft.renders = [];
      draft.creativeVariants = [];
      draft.variantMetrics = [];
      draft.result = null;
      draft.metrics = null;
      draft.artifacts = draft.artifacts.filter((asset) => asset.name.startsWith("uploaded-"));
      for (const agent of draft.agents) {
        agent.status = "idle";
        agent.action = "초기화 완료 · 실행 대기";
        agent.startedAt = null;
        agent.finishedAt = null;
      }
      this.store.event(
        draft,
        null,
        "warning",
        "자동 운영과 생성 결과물을 초기화했습니다. 새로 시작할 수 있습니다.",
      );
    });
  }
  wakeBlocked(): void {
    for (const job of this.store.list())
      if (
        job.automation?.status === "blocked" &&
        !job.automation.operation &&
        !job.staged?.pendingOperation &&
        job.automation.scopeDigest === scopeDigest(job, job.automation.policy) &&
        (job.automation.policy.mode === "creative" ||
          Date.parse(job.automation.policy.endAt) > Date.now())
      ) {
        this.store.change(job.id, (draft) => {
          if (draft.automation) {
            draft.automation.status = "queued";
            draft.automation.nextRunAt = new Date().toISOString();
          }
        });
      }
  }
}
