import { afterEach, beforeEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { renderStateOf } from "../server/render-state-helpers";
import { StartImageProduction, type StartImageProviders } from "../server/start-image-production";
import { renderRuntimeFixture } from "./render-runtime-fixture";

// 시작 이미지 재개 안전성: 저장된 PNG 는 검토부터 이어서 쓰고, 이미지를 받지 못한 실패는 시도로 세지 않는다.
// 이미지·검토는 전부 스텁이라 외부 호출 0회.
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});
async function readyForStartImages() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  return job.id;
}
function providers(overrides: Partial<StartImageProviders> = {}): StartImageProviders {
  const review = f.providers.reviewStartImage;
  if (!review) throw new Error("fixture reviewer missing");
  return { image: f.providers.image, reviewStartImage: review, ...overrides };
}
const names = (id: string) => f.store.get(id).artifacts.map((asset) => asset.name);
const stateOf = (id: string) => f.store.get(id).renders[0]?.startImages;

test("an image saved before an interrupted review is reviewed again without generating a new image", async () => {
  const id = await readyForStartImages();
  let reviews = 0;
  const flaky = providers({
    reviewStartImage: async (task) => {
      reviews++;
      if (reviews === 1) throw new Error("review connection reset");
      return providers().reviewStartImage(task);
    },
  });
  await expect(new StartImageProduction(f.store, flaky).run(id, 1, signal())).rejects.toThrow(
    "reset",
  );
  expect(f.counts.startImage).toBe(1);
  expect(names(id)).toContain("start-1-A-1.png");
  expect(stateOf(id)?.A?.attempts).toBe(1);
  await new StartImageProduction(f.store, flaky).run(id, 1, signal());
  // A 는 저장된 PNG 를 재사용하고 나머지 3개만 새로 만든다(총 4장)
  expect(f.counts.startImage).toBe(4);
  expect(stateOf(id)?.A).toMatchObject({ name: "start-1-A-1.png", attempts: 1, status: "pass" });
  expect(names(id).filter((name) => name === "start-1-A-1.png")).toHaveLength(1);
  expect(names(id).filter((name) => name === "start-review-1-A-1.json")).toHaveLength(1);
}, 60_000);

test("failures that return no image never consume attempts", async () => {
  const id = await readyForStartImages();
  let failures = 4;
  const flaky = providers({
    image: async (job, prompt, abort, options) => {
      if (failures-- > 0) throw new Error("fetch failed");
      return f.providers.image(job, prompt, abort, options);
    },
  });
  for (let round = 0; round < 4; round++) {
    await expect(new StartImageProduction(f.store, flaky).run(id, 1, signal())).rejects.toThrow(
      "fetch failed",
    );
    expect(stateOf(id)?.A?.attempts).toBe(0);
  }
  await new StartImageProduction(f.store, flaky).run(id, 1, signal());
  expect(stateOf(id)?.A).toMatchObject({ name: "start-1-A-1.png", attempts: 1 });
}, 60_000);

test("a leftover attempt counter without any saved image does not block the clip", async () => {
  const id = await readyForStartImages();
  f.store.change(id, (draft) => {
    renderStateOf(draft, 1).startImages.A = { name: "", digest: "", attempts: 2, status: "pass" };
  });
  await new StartImageProduction(f.store, providers()).run(id, 1, signal());
  expect(stateOf(id)?.A?.name).toBe("start-1-A-1.png");
  expect(stateOf(id)?.A?.attempts).toBe(1);
}, 60_000);
