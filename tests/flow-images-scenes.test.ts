import { expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { AutomaticProduction, type ProductionProviders } from "../server/automation-production";
import { WaitingError } from "../server/errors";
import { FlowImageProduction } from "../server/flow-image-production";
import { getModelSettings, saveModelSettings } from "../server/model-settings";
import { StartImageProduction } from "../server/start-image-production";
import { StillProduction } from "../server/still-production";
import { flowImagesOf } from "../shared/flow-images";
import { flowPng } from "./flow-images-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

test("Flow covers representative, cards, stills and start images without automatic generation", async () => {
  const f = await renderRuntimeFixture({ stubRender: true });
  try {
    saveModelSettings(f.root, { ...getModelSettings(f.root), imageProvider: "flow" });
    const images = new FlowImageProduction(f.store);
    const plan = f.providers.plan;
    if (!plan) throw new TypeError("plan fixture missing");
    const providers: ProductionProviders = {
      ...f.providers,
      image: (job, prompt, signal, options) =>
        images.image({ job, prompt, signal, ...(options ? { options } : {}) }),
      plan: async (job, strategy, signal) => {
        const result = await plan(job, strategy, signal);
        return {
          ...result,
          value: {
            ...result.value,
            hypotheses: result.value.hypotheses.map((hypothesis) => ({
              ...hypothesis,
              cardSlides: [
                { headline: "카드", body: "설명", imagePrompt: "올리브 제품 설명 카드" },
              ],
            })),
          },
        };
      },
    };
    const production = new AutomaticProduction(f.store, providers);
    const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      clipMode: "flow",
      scriptApproval: "auto",
    });
    const square = flowPng(f.root);
    const portrait = flowPng(f.root, "288x512");
    const signal = new AbortController().signal;
    const drive = async (run: () => Promise<unknown>) => {
      for (let turn = 0; turn < 20; turn++) {
        try {
          await run();
          return;
        } catch (error) {
          if (!(error instanceof WaitingError)) throw error;
          const request = flowImagesOf(f.store.get(job.id)).find((item) => !item.digest);
          if (!request) throw new TypeError("pending image missing");
          f.store.change(job.id, (draft) => {
            if (draft.automation) {
              draft.automation.status = "waiting";
              draft.automation.operation = null;
            }
            draft.status = "review";
          });
          await images.upload({
            jobId: job.id,
            requestId: request.id,
            bytes: request.aspect === "portrait" ? portrait : square,
            confirmed: true,
            signal,
          });
          f.store.change(job.id, (draft) => {
            if (draft.automation) draft.automation.status = "queued";
          });
        }
      }
      throw new TypeError("flow did not settle");
    };
    await drive(() => production.run(job.id, signal));
    const review = f.providers.reviewStartImage;
    if (!review) throw new TypeError("review fixture missing");
    const sceneProviders = { image: providers.image, reviewStartImage: review };
    await drive(() => new StillProduction(f.store, sceneProviders).run(job.id, 1, signal));
    await drive(() => new StartImageProduction(f.store, sceneProviders).run(job.id, 1, signal));
    const requests = flowImagesOf(f.store.get(job.id));
    for (const prefix of ["image-", "card-", "stills-", "startImages-"])
      expect(requests.some((request) => request.target.startsWith(prefix))).toBe(true);
    expect(requests.every((request) => request.digest !== null)).toBe(true);
    expect(f.counts.image + f.counts.startImage + f.counts.still).toBe(0);
    const count = requests.length;
    await production.run(job.id, signal);
    await new StillProduction(f.store, sceneProviders).run(job.id, 1, signal);
    await new StartImageProduction(f.store, sceneProviders).run(job.id, 1, signal);
    expect(flowImagesOf(f.store.get(job.id))).toHaveLength(count);
  } finally {
    await f.close();
  }
}, 90_000);
