import type { Job } from "../shared/schema";
import {
  pendingScriptApprovals,
  scriptApprovalMessage,
  scriptApprovalReady,
} from "../shared/script-approval";
import { AutomationGuard } from "./automation-guard";
import { ClipProduction } from "./clip-production";
import { StudioError, WaitingError } from "./errors";
import { MusicLibrary } from "./music-library";
import { ProjectStore } from "./project-store";
import { defaultPreflightDeps, type PreflightResult, renderPreflight } from "./render/preflight";
import { RenderProduction } from "./render-production";
import {
  hasArtifact,
  renderNames,
  renderStateOf,
  scriptDigest,
  scriptOf,
} from "./render-state-helpers";
import { StartImageProduction } from "./start-image-production";
import { StillProduction } from "./still-production";
import type { JobStore } from "./store";
import { VoiceProduction } from "./voice-production";

// 영상 n=1..videoCount 마다 preflight → voice → stills → startImages → clips → graphics → assemble.
// "싼 것·실측이 필요한 것 먼저": 내레이션이 영상에 못 들어가면 Veo 에 돈을 쓰기 전에 멈춘다.
export type StageRunner = {
  run(id: string, number: number, signal: AbortSignal): Promise<void>;
};
export type VoiceStageRunner = {
  run(
    id: string,
    number: number,
    signal: AbortSignal,
    options?: { readonly concurrencyLimit?: number },
  ): Promise<void>;
};
export type PreflightRunner = (
  job: Job,
  number: number,
  signal: AbortSignal,
) => Promise<PreflightResult>;
export type RenderPipelineDeps = {
  readonly voice?: VoiceStageRunner;
  readonly stills?: StageRunner;
  readonly startImages?: StageRunner;
  readonly clips?: StageRunner;
  readonly render?: StageRunner;
  readonly preflight?: PreflightRunner;
};
// bun test 는 NODE_ENV=test 로 돌고 저장소 .env 의 실제 키를 자동으로 읽는다. 공급자를 주입하지 않은 기본 경로가
// 실제 Typecast·OpenAI·Veo 를 부르면 테스트가 과금되므로, 테스트 환경에서는 기본 공급자 대신 즉시 실패하는 단계를 둔다.
// 운영(NODE_ENV 가 test 가 아님)에서는 아무 영향이 없고, 테스트는 단계 러너나 공급자를 주입하면 된다.
export const TEST_PROVIDER_BLOCKED = "test_provider_blocked";
export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test";
}
function blockedError(stage: string): StudioError {
  return new StudioError(
    TEST_PROVIDER_BLOCKED,
    `테스트 환경에서는 주입하지 않은 ${stage} 단계가 실제 유료 공급자를 부를 수 없습니다. 스텁 공급자를 주입하세요.`,
  );
}
function blockedInTest(stage: string): StageRunner & VoiceStageRunner {
  return {
    run: async () => {
      throw blockedError(stage);
    },
  };
}
export class RenderPipeline {
  readonly guard: AutomationGuard;
  readonly voice: VoiceStageRunner;
  readonly stills: StageRunner;
  readonly startImages: StageRunner;
  readonly clips: StageRunner;
  readonly render: StageRunner;
  readonly preflight: PreflightRunner;
  constructor(
    readonly store: JobStore,
    deps: RenderPipelineDeps = {},
  ) {
    this.guard = new AutomationGuard(store);
    const music = new MusicLibrary();
    const test = isTestRuntime();
    this.voice = deps.voice ?? (test ? blockedInTest("내레이션") : new VoiceProduction(store));
    this.stills = deps.stills ?? (test ? blockedInTest("정지 이미지") : new StillProduction(store));
    this.startImages =
      deps.startImages ?? (test ? blockedInTest("시작 이미지") : new StartImageProduction(store));
    this.clips = deps.clips ?? (test ? blockedInTest("Veo 클립") : new ClipProduction(store));
    this.render =
      deps.render ?? new RenderProduction(store, new ProjectStore(store.db), store.root, music);
    this.preflight =
      deps.preflight ??
      (test
        ? async () => {
            throw blockedError("제작 전 점검");
          }
        : (job, number, signal) =>
            renderPreflight(job, number, defaultPreflightDeps(music), signal));
  }
  async run(id: string, signal: AbortSignal): Promise<void> {
    const policy = this.store.get(id).automation?.policy;
    if (policy?.mode !== "creative" || !policy.videoCount) return;
    // 대본 승인 게이트(사용자 결정 2026-10-04): 모든 대본이 쓰이고 검토된 뒤, 첫 유료 단계(내레이션) 전에
    // 사용자가 대본을 승인하지 않은 영상이 하나라도 있으면 Flow 모드와 같은 '대기'로 멈춘다(실패 아님).
    this.waitForScriptApproval(id, signal);
    for (let number = 1; number <= policy.videoCount; number++) {
      let job = this.guard.check(id, signal);
      // 완성본이 있으면 영상 전체를 건너뛴다(멱등). 저장 직후 끊겨 renders.final 이 비었다면 기록을 복원한다.
      if (hasArtifact(job, renderNames.final(number))) {
        if (
          job.renders.find((item) => item.number === number)?.final?.name !==
          renderNames.final(number)
        )
          await this.render.run(id, number, signal);
        continue;
      }
      const digest = scriptDigest(scriptOf(job, number));
      if (!job.renders.some((item) => item.number === number))
        job = this.store.change(id, (draft) => {
          renderStateOf(draft, number, digest);
        });
      const preflight = await this.preflight(job, number, signal);
      if (preflight.warnings.length > 0)
        this.store.change(id, (draft) => {
          for (const warning of preflight.warnings) {
            const message = `영상 ${number} 준비 확인: ${warning}`;
            if (!draft.events.some((event) => event.message === message))
              this.store.event(draft, "production", "warning", message);
          }
        });
      this.guard.check(id, signal);
      await this.voice.run(id, number, signal, { concurrencyLimit: preflight.concurrencyLimit });
      this.guard.check(id, signal);
      // 정지 이미지가 선언되지 않은 대본(예전 대본 포함)은 이 단계를 건너뛴다.
      if (scriptOf(job, number).stills.length > 0) await this.stills.run(id, number, signal);
      this.guard.check(id, signal);
      await this.startImages.run(id, number, signal);
      this.guard.check(id, signal);
      await this.clips.run(id, number, signal);
      this.guard.check(id, signal);
      await this.render.run(id, number, signal);
    }
  }
  private waitForScriptApproval(id: string, signal: AbortSignal): void {
    const job = this.guard.check(id, signal);
    const pending = pendingScriptApprovals(job);
    if (pending.length === 0) return;
    const message = scriptApprovalMessage(pending.length);
    this.store.change(id, (draft) => {
      if (draft.automation) draft.automation.phase = "script";
    });
    this.store.agent(id, "creative", {
      status: "review",
      action: `${message} (영상 ${pending.join(", ")} · 대본 카드에서 수정·승인·다시 쓰기)`,
    });
    throw new WaitingError(message, scriptApprovalReady);
  }
}
