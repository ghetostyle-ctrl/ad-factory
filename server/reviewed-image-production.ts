import type { ModelResult } from "../shared/models";
import { type ImageReview, ImageReviewSchema } from "../shared/planning";
import type { RenderState, StartImageState } from "../shared/render-state";
import { Artifacts } from "./artifacts";
import { AutomationGuard, contentDigest } from "./automation-guard";
import { BlockedError } from "./errors";
import {
  approvedSources,
  hasArtifact,
  renderStateOf,
  saveArtifactOnce,
} from "./render-state-helpers";
import { ReviewedImageGenerator, type ReviewedImageProviders } from "./reviewed-image-providers";
import { sceneImageReferences } from "./scene-image-references";
import type { JobStore } from "./store";

// 시작 이미지(startImages)와 AI 정지 이미지(stills)가 같이 쓰는 "생성 → 승인 대표 이미지와 비전 검토 → 최대 2회" 엔진.
// 두 단계는 산출물 이름·기록 위치·메시지 문구만 다르고 시도 횟수·재개·강제 통과 규칙은 완전히 같다.
export {
  defaultReviewedImageProviders,
  type ReviewedImageProviders,
} from "./reviewed-image-providers";
export const REVIEWED_IMAGE_MAX_ATTEMPTS = 2;

export type ReviewedImageSpec = {
  readonly phase: "startImages" | "stills";
  // 화면 문구에 쓰는 이름. 예: "시작 이미지" / "정지 이미지"
  readonly noun: string;
  // 한 장의 이름. 예: "클립 A 시작 이미지" / "정지 이미지 S1"
  readonly label: (key: string) => string;
  readonly imageName: (number: number, key: string, attempt: number) => string;
  readonly reviewName: (number: number, key: string, attempt: number) => string;
  readonly read: (render: RenderState | undefined, key: string) => StartImageState | undefined;
  readonly write: (render: RenderState, key: string, state: StartImageState) => void;
};
export type ReviewedImageItem = {
  // 클립 ID(A..) 또는 정지 이미지 ID(S1..)
  readonly key: string;
  readonly prompt: string;
  // 비전 검토가 "이 장이 의도한 것"으로 보는 원래 프롬프트
  readonly intent: string;
};

export class ReviewedImageEngine {
  readonly assets: Artifacts;
  readonly guard: AutomationGuard;
  private readonly generator: ReviewedImageGenerator;
  constructor(
    readonly store: JobStore,
    readonly providers: ReviewedImageProviders,
    readonly spec: ReviewedImageSpec,
  ) {
    this.assets = new Artifacts(store);
    this.guard = new AutomationGuard(store);
    this.generator = new ReviewedImageGenerator(providers.image);
  }
  async run(
    id: string,
    number: number,
    signal: AbortSignal,
    input: {
      readonly hypothesisId: string;
      readonly styleAnchor: string;
      readonly items: readonly ReviewedImageItem[];
    },
  ): Promise<void> {
    const job = this.guard.check(id, signal);
    if (input.items.length === 0) return;
    const sources = approvedSources(job, input.hypothesisId);
    if (!sources.approvedImage)
      throw new BlockedError(`영상 ${number} 에 연결된 승인 대표 이미지가 없습니다.`);
    const approvedName = sources.approvedImage.name;
    const approved = new Uint8Array(await (await this.assets.read(id, approvedName)).arrayBuffer());
    if (sources.approvedImage.digest && contentDigest(approved) !== sources.approvedImage.digest)
      throw new BlockedError("검토를 통과한 대표 이미지 파일이 변경되었습니다. 제작을 중단합니다.");
    for (const item of input.items) {
      const current = this.store.get(id).renders.find((render) => render.number === number);
      const state = this.spec.read(current, item.key);
      if (state && hasArtifact(this.store.get(id), state.name)) continue;
      const referenceImages = await sceneImageReferences(this.assets, {
        job: this.store.get(id),
        number,
        approved,
      });
      await this.guard.operation(id, {
        phase: this.spec.phase,
        signal,
        run: () =>
          this.produce({
            id,
            number,
            item,
            styleAnchor: input.styleAnchor,
            approved,
            referenceImages,
            signal,
          }),
      });
    }
    this.store.agent(id, "production", {
      status: "completed",
      action: `영상 ${number} ${this.spec.noun} ${input.items.length}장 확정`,
    });
  }
  private async produce(input: {
    readonly id: string;
    readonly number: number;
    readonly item: ReviewedImageItem;
    readonly styleAnchor: string;
    readonly approved: Uint8Array;
    readonly referenceImages: readonly Uint8Array[];
    readonly signal: AbortSignal;
  }): Promise<void> {
    const { id, number, item, signal } = input;
    const { spec } = this;
    const label = spec.label(item.key);
    let prompt = item.prompt;
    const attemptsOf = () =>
      spec.read(
        this.store.get(id).renders.find((render) => render.number === number),
        item.key,
      )?.attempts ?? 0;
    // attempts 는 "이미지를 받아 저장한 시도"만 센다. 생성 도중 끊겨 파일이 없는 시도는 세지 않는다(영구 정체 방지).
    const savedName = (attempt: number) => spec.imageName(number, item.key, attempt);
    let started = attemptsOf();
    while (started >= 1 && !hasArtifact(this.store.get(id), savedName(started))) started--;
    if (started !== attemptsOf()) this.setAttempts(id, number, item.key, started);
    // 이전 실행이 생성 뒤 기록 전에 끊겼고 한도에 도달했으면 남은 파일로 확정해 추가 과금을 막는다.
    if (attemptsOf() >= REVIEWED_IMAGE_MAX_ATTEMPTS) {
      const existing = [REVIEWED_IMAGE_MAX_ATTEMPTS, 1]
        .map((attempt) => savedName(attempt))
        .find((name) => hasArtifact(this.store.get(id), name));
      if (!existing) throw new BlockedError(`${label} 생성 한도에 도달했습니다.`);
      const bytes = new Uint8Array(await (await this.assets.read(id, existing)).arrayBuffer());
      this.record(id, number, item.key, existing, contentDigest(bytes), attemptsOf(), "forced");
      return;
    }
    // 저장은 끝났는데 검토 도중 끊긴 시도: 같은 이미지를 다시 만들지 않고 저장된 파일로 검토부터 이어간다.
    let carried: { readonly attempt: number; readonly bytes: Uint8Array } | null = null;
    if (attemptsOf() >= 1) {
      const attempt = attemptsOf();
      const file = await this.assets.read(id, savedName(attempt));
      carried = { attempt, bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    while (true) {
      const attempt = carried?.attempt ?? attemptsOf() + 1;
      const name = savedName(attempt);
      let image: Uint8Array;
      if (carried) {
        image = carried.bytes;
        carried = null;
      } else {
        this.store.agent(id, "production", {
          status: "running",
          action: `영상 ${number} ${label} ${attempt}/${REVIEWED_IMAGE_MAX_ATTEMPTS} 생성 중`,
        });
        this.setAttempts(id, number, item.key, attempt);
        const result = await this.generator
          .generate({
            job: this.store.get(id),
            prompt,
            signal,
            referenceImages: input.referenceImages,
          })
          .catch((error) => {
            // 이미지를 받지 못한 실패(키 부재·HTTP 오류·타임아웃·중단)는 시도로 세지 않는다.
            this.setAttempts(id, number, item.key, attempt - 1);
            throw error;
          });
        await saveArtifactOnce(this.assets, id, {
          name,
          kind: "image",
          agentId: "production",
          content: result.value,
          model: result.model,
        });
        image = result.value;
      }
      const digest = contentDigest(image);
      const reviewName = spec.reviewName(number, item.key, attempt);
      const review = await this.reviewOnce(id, reviewName, async () => {
        this.store.agent(id, "production", {
          status: "running",
          action: `영상 ${number} ${label} ${attempt} · 대표 이미지와 연속성 검토 중`,
        });
        return this.providers.reviewStartImage({
          job: this.store.get(id),
          approvedImage: input.approved,
          candidate: image,
          styleAnchor: input.styleAnchor,
          startImagePrompt: item.intent,
          signal,
        });
      });
      if (review.status === "pass") {
        this.record(id, number, item.key, name, digest, attempt, "pass");
        return;
      }
      if (attempt >= REVIEWED_IMAGE_MAX_ATTEMPTS) {
        // 강제 통과라도 digest 는 반드시 저장한다(뒤 단계가 파일 변조를 재검증한다).
        this.record(id, number, item.key, name, digest, attempt, "forced");
        return;
      }
      prompt = review.revisionPrompt ?? `${prompt}\n수정 요청: ${review.issues.join("; ")}`;
    }
  }
  // 같은 이름의 검토 결과가 저장돼 있으면 그대로 쓰고, 없을 때만 유료 검토를 호출해 저장한다.
  private async reviewOnce(
    id: string,
    reviewName: string,
    request: () => Promise<ModelResult<ImageReview>>,
  ): Promise<ImageReview> {
    if (hasArtifact(this.store.get(id), reviewName)) {
      const saved = ImageReviewSchema.safeParse(
        await this.assets
          .read(id, reviewName)
          .then((file) => file.json())
          .catch(() => null),
      );
      if (saved.success) return saved.data;
    }
    const review = await request();
    await saveArtifactOnce(this.assets, id, {
      name: reviewName,
      kind: "json",
      agentId: "production",
      content: JSON.stringify(review.value),
      model: review.model,
    });
    return review.value;
  }
  private setAttempts(id: string, number: number, key: string, attempts: number) {
    this.store.change(id, (draft) => {
      const render = renderStateOf(draft, number);
      const current = this.spec.read(render, key);
      this.spec.write(
        render,
        key,
        current ? { ...current, attempts } : { name: "", digest: "", attempts, status: "pass" },
      );
    });
  }
  private record(
    id: string,
    number: number,
    key: string,
    name: string,
    digest: string,
    attempts: number,
    status: "pass" | "forced",
  ) {
    this.store.change(id, (draft) => {
      this.spec.write(renderStateOf(draft, number), key, { name, digest, attempts, status });
    });
  }
}
