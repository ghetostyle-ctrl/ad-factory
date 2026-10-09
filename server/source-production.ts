import type { CreativePlan, CreativeVariant } from "../shared/creative-plan";
import type { ModelResult } from "../shared/models";
import { type Creative, ImageReviewSchema, type Strategy } from "../shared/planning";
import type { Job } from "../shared/schema";
import {
  pendingScriptApprovals,
  scriptApprovalMessage,
  scriptApprovalReady,
  scriptArtifactName,
} from "../shared/script-approval";
import { videoTargetSeconds, videoVariantIndex } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import type { ProductionProviders } from "./automation-production";
import { BlockedError, MissingConnectionError, StudioError, WaitingError } from "./errors";
import { instructionsEventMessage } from "./instructions";
import { renderStateOf } from "./render-state-helpers";
import { SCRIPT_MAX_GENERATIONS, writeVideoScript } from "./script-writer";
import { validatePlanEvidence } from "./source-evidence";
import { sourceImagePrompt } from "./source-image-style";
import { SourcePlanner } from "./source-planning";
import type { JobStore } from "./store";
import { verifyVideoScript } from "./video-scripts";

export function videoHypotheses(plan: CreativePlan): CreativePlan["hypotheses"] {
  return plan.hypotheses;
}
export type PlanProvider = (
  job: Job,
  strategy: Strategy,
  signal: AbortSignal,
) => Promise<ModelResult<CreativePlan>>;
export class SourceProduction {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  constructor(
    readonly store: JobStore,
    readonly providers: ProductionProviders,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
  }
  async run(id: string, strategy: Strategy, signal: AbortSignal): Promise<Creative> {
    const policy = this.store.get(id).automation?.policy;
    const imageCount = policy?.mode === "creative" ? (policy.imageCount ?? 3) : 3;
    if (!this.store.get(id).creativePlan)
      await this.guard.operation(id, {
        phase: "creative",
        signal,
        run: async () => {
          const job = this.store.get(id);
          const planner = new SourcePlanner(this.store);
          const plan = this.providers.plan ?? planner.plan.bind(planner);
          const result = await plan(job, strategy, signal);
          if (!job.sourceSnapshot) throw new BlockedError("고정된 자료 스냅샷이 없습니다.");
          validatePlanEvidence(result.value, job.sourceSnapshot, imageCount);
          await this.assets.save(id, {
            name: "source-plan-auto.json",
            kind: "json",
            agentId: "creative",
            content: JSON.stringify(result.value),
            model: result.model,
          });
          this.store.change(id, (draft) => {
            draft.creativePlan = result.value;
            if (draft.automation)
              draft.automation.approvedPlanDigest = contentDigest(JSON.stringify(result.value));
            draft.creativeVariants = result.value.hypotheses.map((hypothesis) => ({
              id: hypothesis.id,
              creative: hypothesis.creative,
              imageAttempts: 0,
              approvedImageId: null,
              approvedImageDigest: null,
              approvedCreativeDigest: null,
              reviewStatus: "pending",
              cardImageIds: [],
            }));
          });
          this.store.agent(id, "creative", {
            status: "completed",
            action: `인용 근거·다양성 검토를 통과한 고객 가설 ${imageCount}개 저장 완료`,
          });
        },
      });
    const job = this.store.get(id);
    if (!job.sourceSnapshot || !job.creativePlan)
      throw new BlockedError("자료 기반 기획이 없습니다.");
    validatePlanEvidence(job.creativePlan, job.sourceSnapshot, imageCount);
    const videoCount = policy?.mode === "creative" ? (policy.videoCount ?? 0) : 0;
    const videoOrder = videoHypotheses(job.creativePlan);
    for (let index = this.store.get(id).videoScripts.length; index < videoCount; index++) {
      const uses = new Map<string, number>();
      for (const script of this.store.get(id).videoScripts)
        uses.set(script.hypothesisId, (uses.get(script.hypothesisId) ?? 0) + 1);
      const hypothesis = videoOrder.toSorted(
        (left, right) => (uses.get(left.id) ?? 0) - (uses.get(right.id) ?? 0),
      )[0];
      if (!hypothesis) throw new BlockedError("영상 대본에 연결할 광고안이 없습니다.");
      await this.guard.operation(id, {
        phase: "script",
        signal,
        run: async () => {
          const number = index + 1;
          const durationSec = videoTargetSeconds(
            id,
            number,
            videoVariantIndex(this.store.get(id).videoScripts, number, hypothesis.id),
          );
          // 규칙(길이·컷·자막·내레이션)과 AI 품질 검토에 걸리면 이유를 모아 다시 쓴다(생성 최대 3회).
          const result = await writeVideoScript({
            store: this.store,
            providers: this.providers,
            id,
            number,
            hypothesis,
            durationSec,
            signal,
            progress: (attempt, reason, plannedDurationSec) => {
              this.store.agent(id, "creative", {
                status: "running",
                action: {
                  planning: `영상 ${number}/${videoCount} · 고객 상황 분석·영상 콘셉트 기획 중`,
                  copy: `영상 ${number}/${videoCount} · 내레이션·화면 카피 교정 중`,
                  write: `영상 ${number}/${videoCount} · ${plannedDurationSec === undefined ? "" : `${plannedDurationSec}초 `}대본·컷 구성 작성 중${attempt > 1 ? ` · 수정 ${attempt - 1}회` : ""}`,
                  review: `영상 ${number}/${videoCount} · 대본 AI 품질 검토 중(말맛·설득력·사실 일치)`,
                }[reason],
              });
            },
          });
          await this.assets.save(id, {
            name: scriptArtifactName(number),
            kind: "json",
            agentId: "creative",
            content: JSON.stringify(result.script),
            model: result.model,
          });
          this.store.change(id, (draft) => {
            draft.videoScripts.push(result.script);
            renderStateOf(draft, number).scriptReview = result.review;
            // 이 대본을 만들 때 읽은 지시 파일(D5): 해시는 scriptReview 에, 이벤트에는 앞 8자리만.
            if (result.review.instructionsDigest)
              this.store.event(
                draft,
                "creative",
                "info",
                `영상 ${number} 대본 · ${instructionsEventMessage({ digest: result.review.instructionsDigest })}`,
              );
            if (result.review.repairs.length > 0)
              this.store.event(
                draft,
                "creative",
                "info",
                `영상 ${number} 대본 자동 수리 ${result.review.repairs.length}건`,
              );
          });
          this.store.agent(id, "creative", {
            status: "completed",
            action:
              result.review.accepted === "pass"
                ? `영상 ${number}/${videoCount} 대본·컷·소스·Flow·편집 지시 저장 완료 · AI 검토 통과${result.review.warnings.length > 0 ? ` · 경고 ${result.review.warnings.length}건` : ""}`
                : result.review.accepted === "forced"
                  ? `영상 ${number}/${videoCount} 대본 저장 · AI 검토가 ${SCRIPT_MAX_GENERATIONS}회 생성 뒤에도 수정을 권해 사용자 확인이 필요합니다(승인 전에는 유료 제작을 시작하지 않습니다)`
                  : `영상 ${number}/${videoCount} 대본 초안 저장 · 규칙을 통과하지 못해 대본 카드에서 고치거나 다시 써야 합니다(승인 전 유료 제작 없음, 생성 ${SCRIPT_MAX_GENERATIONS}회)`,
          });
        },
      });
    }
    const awaitingApproval = pendingScriptApprovals(this.store.get(id));
    if (awaitingApproval.length > 0) {
      this.store.change(id, (draft) => {
        if (draft.automation) draft.automation.phase = "script";
      });
      throw new WaitingError(scriptApprovalMessage(awaitingApproval.length), scriptApprovalReady);
    }
    for (const [index, script] of this.store.get(id).videoScripts.entries()) {
      const hypothesis = job.creativePlan.hypotheses.find(
        (item) => item.id === script.hypothesisId,
      );
      if (!hypothesis) throw new BlockedError("영상 대본에 연결할 광고안이 없습니다.");
      verifyVideoScript(script, index + 1, hypothesis.id);
    }
    for (const variant of job.creativeVariants) {
      await this.produce({ id, variantId: variant.id, signal });
      await this.produceCards({ id, variantId: variant.id, signal });
    }
    const first = this.store.get(id).creativeVariants[0];
    if (!first) throw new BlockedError("제작할 가설이 없습니다.");
    return first.creative;
  }
  // 메커니즘 설명형 카드뉴스: 표지(대표 이미지)가 확정된 뒤 2~5번째 장을 장마다 생성·검토한다.
  // 장마다 검토는 1회, 수정 요청이 오면 한 번만 다시 만들고 그 결과로 확정해 비용을 제한한다.
  private async produceCards(task: {
    readonly id: string;
    readonly variantId: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { id, variantId, signal } = task;
    const slides =
      this.store.get(id).creativePlan?.hypotheses.find((item) => item.id === variantId)
        ?.cardSlides ?? [];
    for (const [index, slide] of slides.entries()) {
      if (this.variant(this.store.get(id), variantId).cardImageIds[index]) continue;
      const cardNumber = index + 2;
      await this.guard.operation(id, {
        phase: "image",
        signal,
        run: async () => {
          const base = this.variant(this.store.get(id), variantId).creative;
          const creative = {
            ...base,
            headline: slide.headline,
            primaryText: slide.body || slide.headline,
            imagePrompt: slide.imagePrompt,
          };
          let prompt = slide.imagePrompt;
          let saved: { id: string } | null = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            this.store.agent(id, "production", {
              status: "running",
              action: `${variantId} · 카드뉴스 ${cardNumber}/${slides.length + 1}장 ${attempt === 1 ? "생성" : "수정"} 중`,
            });
            const result = await this.providers.image(
              this.store.get(id),
              sourceImagePrompt(this.store.get(id), variantId, prompt),
              signal,
            );
            saved = await this.assets.save(id, {
              name: `card-${variantId}-${cardNumber}-${attempt}.png`,
              kind: "image",
              agentId: "production",
              content: result.value,
              model: result.model,
            });
            if (attempt === 2) break;
            const review = await this.providers.review({
              job: this.store.get(id),
              creative,
              image: result.value,
              signal,
            });
            await this.assets.save(id, {
              name: `card-review-${variantId}-${cardNumber}.json`,
              kind: "json",
              agentId: "production",
              content: JSON.stringify(review.value),
              model: review.model,
            });
            if (review.value.status === "pass" || !review.value.revisionPrompt) break;
            prompt = review.value.revisionPrompt;
          }
          if (!saved) throw new BlockedError("카드뉴스 이미지를 만들지 못했습니다.");
          const savedId = saved.id;
          this.store.change(id, (draft) => {
            this.variant(draft, variantId).cardImageIds[index] = savedId;
          });
        },
      });
    }
    if (slides.length)
      this.store.agent(id, "production", {
        status: "completed",
        action: `${variantId} · 카드뉴스 ${slides.length + 1}장 완성`,
      });
  }
  private variant(job: Job, variantId: string): CreativeVariant {
    const variant = job.creativeVariants.find((item) => item.id === variantId);
    if (!variant) throw new StudioError("variant", "고객 가설 상태를 찾을 수 없습니다.");
    return variant;
  }
  private async produce(task: {
    readonly id: string;
    readonly variantId: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { id, variantId, signal } = task;
    while (true) {
      const job = this.guard.check(id, signal);
      const variant = this.variant(job, variantId);
      const imageAsset = job.artifacts.findLast(
        (asset) =>
          asset.name === `image-${variantId}-${variant.imageAttempts}.png` &&
          asset.kind === "image",
      );
      if (variant.reviewStatus === "pass") {
        if (
          !imageAsset ||
          variant.approvedImageId !== imageAsset.id ||
          contentDigest(JSON.stringify(variant.creative)) !== variant.approvedCreativeDigest
        )
          throw new StudioError(
            "review_binding",
            "가설 검토 이후 이미지 또는 카피가 변경되었습니다.",
          );
        return;
      }
      let prompt = variant.creative.imagePrompt;
      if (variant.reviewStatus === "revise") {
        const reviewAsset = job.artifacts.findLast(
          (asset) => asset.name === `review-${variantId}-${variant.imageAttempts}.json`,
        );
        if (!reviewAsset)
          throw new StudioError("review_missing", "가설 수정 검토 기록이 없습니다.");
        const review = ImageReviewSchema.parse(
          await (await this.assets.read(id, reviewAsset.name)).json(),
        );
        prompt = review.revisionPrompt ?? prompt;
      }
      if (!imageAsset || variant.reviewStatus === "revise") {
        if (variant.imageAttempts >= 2) {
          this.store.change(id, (draft) => {
            const current = this.variant(draft, variantId);
            current.reviewStatus = "pass";
            current.approvedImageId = imageAsset?.id ?? null;
            current.approvedCreativeDigest = contentDigest(JSON.stringify(current.creative));
          });
          this.store.agent(id, "production", {
            status: "completed",
            action: `${variantId} · 검토 보류로 확정하고 다음 소재로 진행`,
          });
          return;
        }
        await this.guard.operation(id, {
          phase: "image",
          signal,
          run: async () => {
            const attempt = variant.imageAttempts + 1;
            this.store.agent(id, "production", {
              status: "running",
              action: `${variantId} · 이미지 ${attempt}/2 생성 중`,
            });
            this.store.change(id, (draft) => {
              this.variant(draft, variantId).imageAttempts = attempt;
            });
            const result = await this.providers
              .image(
                this.store.get(id),
                sourceImagePrompt(this.store.get(id), variantId, prompt),
                signal,
              )
              .catch((error) => {
                if (error instanceof MissingConnectionError)
                  this.store.change(id, (draft) => {
                    this.variant(draft, variantId).imageAttempts = attempt - 1;
                  });
                throw error;
              });
            await this.assets.save(id, {
              name: `image-${variantId}-${attempt}.png`,
              kind: "image",
              agentId: "production",
              content: result.value,
              model: result.model,
            });
            this.store.change(id, (draft) => {
              this.variant(draft, variantId).reviewStatus = "pending";
            });
          },
        });
      }
      await this.guard.operation(id, {
        phase: "review",
        signal,
        run: async () => {
          const current = this.store.get(id);
          const target = this.variant(current, variantId);
          const asset = current.artifacts.findLast(
            (item) =>
              item.name === `image-${variantId}-${target.imageAttempts}.png` &&
              item.kind === "image",
          );
          if (!asset) throw new BlockedError("검토할 가설 이미지가 없습니다.");
          const image = new Uint8Array(
            await (await this.assets.read(id, asset.name)).arrayBuffer(),
          );
          this.store.agent(id, "production", {
            status: "running",
            action: `${variantId} · 실제 픽셀·카피와 제품 인용 근거 검토 중`,
          });
          const result = await this.providers.review({
            job: current,
            creative: target.creative,
            image,
            signal,
          });
          await this.assets.save(id, {
            name: `review-${variantId}-${target.imageAttempts}.json`,
            kind: "json",
            agentId: "production",
            content: JSON.stringify(result.value),
            model: result.model,
          });
          this.store.change(id, (draft) => {
            const saved = this.variant(draft, variantId);
            const passed = result.value.status === "pass";
            saved.reviewStatus = result.value.status;
            saved.approvedImageId = passed ? asset.id : null;
            saved.approvedImageDigest = passed ? contentDigest(image) : null;
            saved.approvedCreativeDigest = passed
              ? contentDigest(JSON.stringify(saved.creative))
              : null;
          });
          this.store.agent(id, "production", {
            status: result.value.status === "pass" ? "completed" : "review",
            action: `${variantId} · ${result.value.summary}`,
          });
        },
      });
    }
  }
}
