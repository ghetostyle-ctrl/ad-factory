import type { CreativeVariant } from "../shared/creative-plan";
import { ImageReviewSchema } from "../shared/planning";
import type { Job } from "../shared/schema";
import { Artifacts } from "./artifacts";
import { AutomationGuard } from "./automation-guard";
import type { ProductionProviders } from "./automation-production";
import { BlockedError, StudioError } from "./errors";
import { sourceImagePrompt } from "./source-image-style";
import type { JobStore } from "./store";

function variantOf(job: Job, id: string): CreativeVariant {
  const variant = job.creativeVariants.find((item) => item.id === id);
  if (!variant) throw new StudioError("variant", "고객 가설 상태를 찾을 수 없습니다.");
  return variant;
}
export async function produceSourceCards(
  store: JobStore,
  task: {
    readonly id: string;
    readonly variantId: string;
    readonly signal: AbortSignal;
    readonly providers: ProductionProviders;
  },
): Promise<void> {
  const { id, variantId, signal, providers } = task;
  const assets = new Artifacts(store);
  const guard = new AutomationGuard(store);
  const job = store.get(id);
  const slides =
    job.creativePlan?.hypotheses.find((item) => item.id === variantId)?.cardSlides ?? [];
  const flow = job.executionModels?.imageProvider === "flow";
  for (const [index, slide] of slides.entries()) {
    if (variantOf(store.get(id), variantId).cardImageIds[index]) continue;
    const number = index + 2;
    await guard.operation(id, {
      phase: "image",
      signal,
      run: async () => {
        const base = variantOf(store.get(id), variantId).creative;
        const creative = {
          ...base,
          headline: slide.headline,
          primaryText: slide.body || slide.headline,
          imagePrompt: slide.imagePrompt,
        };
        let prompt = slide.imagePrompt;
        for (let attempt = 1; ; attempt++) {
          signal.throwIfAborted();
          const name = `card-${variantId}-${number}-${attempt}.png`;
          const reviewName = `card-review-${variantId}-${number}-${attempt}.json`;
          let saved = store.get(id).artifacts.find((asset) => asset.name === name);
          let bytes: Uint8Array;
          if (saved) bytes = new Uint8Array(await (await assets.read(id, name)).arrayBuffer());
          else {
            store.agent(id, "production", {
              status: "running",
              action: `${variantId} · 카드 ${number} · ${attempt}차 ${flow ? "Flow 이미지 준비" : "생성"} 중`,
            });
            const result = await providers.image(
              store.get(id),
              sourceImagePrompt(store.get(id), variantId, prompt),
              signal,
              { target: { key: name, label: `${variantId} · 카드 ${number} · ${attempt}차` } },
            );
            bytes = result.value;
            saved = await assets.save(id, {
              name,
              kind: "image",
              agentId: "production",
              content: bytes,
              model: result.model,
            });
          }
          let passed = !flow && attempt >= 2;
          if (!passed) {
            const cached = store
              .get(id)
              .artifacts.find(
                (asset) =>
                  asset.name === reviewName ||
                  (attempt === 1 && asset.name === `card-review-${variantId}-${number}.json`),
              );
            const review = cached
              ? ImageReviewSchema.parse(await (await assets.read(id, cached.name)).json())
              : await (async () => {
                  const result = await providers.review({
                    job: store.get(id),
                    creative,
                    image: bytes,
                    signal,
                  });
                  await assets.save(id, {
                    name: reviewName,
                    kind: "json",
                    agentId: "production",
                    content: JSON.stringify(result.value),
                    model: result.model,
                  });
                  return result.value;
                })();
            passed = review.status === "pass";
            prompt =
              review.revisionPrompt ??
              `${slide.imagePrompt}\n수정 요청: ${review.issues.join("; ")}`;
          }
          if (passed) {
            const savedId = saved.id;
            store.change(id, (draft) => {
              variantOf(draft, variantId).cardImageIds[index] = savedId;
            });
            return;
          }
          if (attempt >= 2)
            throw new BlockedError(
              "Flow 카드 이미지가 두 차례 검토를 통과하지 못했습니다. 검토 결과를 확인하세요.",
            );
        }
      },
    });
  }
  if (slides.length)
    store.agent(id, "production", {
      status: "completed",
      action: `${variantId} · 카드뉴스 ${slides.length + 1}장 완성`,
    });
}
