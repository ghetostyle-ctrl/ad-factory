import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomaticProduction } from "../server/automation-production";
import { automationServices } from "../server/automation-services";
import { FlowImageProduction } from "../server/flow-image-production";
import { getModelSettings, saveModelSettings } from "../server/model-settings";
import { Pipeline } from "../server/pipeline";
import { JobStore } from "../server/store";
import { automationBrief } from "./automation-fixture";
import { fixtureCreative, fixtureStrategy } from "./automation-http-fixture";
export const flowFixtureModel = {
  provider: "codex",
  requestedModel: "fixture",
  effectiveModel: "fixture",
  quality: null,
} as const;
export async function flowImageFixture(options: { readonly revise?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "studio-flow-images-"));
  const store = new JobStore(root);
  saveModelSettings(root, {
    ...getModelSettings(root),
    textProvider: "codex",
    codexModel: "fixture",
    imageProvider: "flow",
  });
  const images = new FlowImageProduction(store);
  const counts = { image: 0, review: 0 };
  const production = new AutomaticProduction(store, {
    strategy: async () => ({ value: fixtureStrategy, model: flowFixtureModel }),
    creative: async () => ({ value: fixtureCreative, model: flowFixtureModel }),
    image: async (job, prompt, signal, imageOptions) => {
      counts.image++;
      return images.image({
        job,
        prompt,
        signal,
        ...(imageOptions ? { options: imageOptions } : {}),
      });
    },
    review: async () => {
      counts.review++;
      return {
        model: flowFixtureModel,
        value: options.revise
          ? {
              status: "revise",
              summary: "수정 필요",
              issues: ["제품 표현 확인"],
              revisionPrompt: "수정한 이미지 프롬프트",
            }
          : { status: "pass", summary: "확인", issues: [], revisionPrompt: null },
      };
    },
  });
  const engine = new AutomationEngine(store, automationServices(store, { production }));
  const app = createApp(store, new Pipeline(store), engine);
  const id = store.create(automationBrief).id;
  engine.start(id, { mode: "creative", imageCount: 1, videoCount: 0 });
  const settle = async () => {
    await engine.tick();
    await Promise.all([...engine.active.values()].map((item) => item.promise));
  };
  await settle();
  const upload = async (requestId: string, bytes: Uint8Array, confirmed = true, jobId = id) => {
    const body = new FormData();
    body.set("file", new File([new Uint8Array(bytes)], "Flow 이미지.png", { type: "image/png" }));
    body.set("confirmed", String(confirmed));
    return app.request(`http://127.0.0.1:4317/api/jobs/${jobId}/flow-images/${requestId}`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:4317" },
      body,
    });
  };
  return {
    root,
    store,
    images,
    engine,
    id,
    app,
    counts,
    upload,
    settle,
    close: async () => {
      engine.close();
      await Promise.all([...engine.active.values()].map((item) => item.promise));
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function flowPng(root: string, size = "256x256"): Uint8Array {
  const path = join(root, `input-${size}.png`);
  const result = Bun.spawnSync([
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=olive:s=${size}`,
    "-frames:v",
    "1",
    path,
  ]);
  if (result.exitCode !== 0) throw new TypeError(result.stderr.toString());
  return new Uint8Array(readFileSync(path));
}
