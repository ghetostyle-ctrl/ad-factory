import { afterEach, beforeEach, expect, test } from "bun:test";
import { HTTPError } from "ky";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { contentDigest } from "../server/automation-guard";
import { BlockedError } from "../server/errors";
import { renderNames, renderStateOf } from "../server/render-state-helpers";
import { START_IMAGE_MAX_ATTEMPTS } from "../server/start-image-production";
import { STILL_MAX_ATTEMPTS, StillProduction, stillPrompt } from "../server/still-production";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

// 정지 이미지(phase 'stills'): 이미지 생성 → 승인 대표 이미지와 비전 검토(최대 2회) → digest 기록.
// 이미지·검토는 전부 스텁이라 외부 호출 0회. 대본은 36초로 고정해 정지 이미지는 S1·S2 두 장이다.
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});
async function readyForStills() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  // 대본 길이는 작업 ID 로 정해지므로, 정지 이미지 구성이 고정되도록 36초 대본(S1·S2)으로 바꿔 둔다.
  f.store.change(job.id, (draft) => {
    const hypothesisId = draft.videoScripts[0]?.hypothesisId;
    if (!hypothesisId) throw new Error("script missing");
    draft.videoScripts[0] = renderScript(1, hypothesisId, 36);
  });
  return job.id;
}
type Calls = {
  images: { prompt: string; size: string | undefined }[];
  reviews: { candidate: Uint8Array; styleAnchor: string; intent: string; approved: number }[];
};
// 호출을 기록하는 공급자. 기본은 서로 다른 PNG 바이트를 돌려주고 검토는 통과시킨다.
function providers(
  calls: Calls,
  options: {
    readonly review?: (index: number) => "pass" | "revise";
    readonly failImage?: (index: number) => Error | null;
  } = {},
) {
  const pass = {
    status: "pass" as const,
    summary: "ok",
    issues: [] as string[],
    revisionPrompt: null,
  };
  const model = {
    provider: "openai",
    requestedModel: "fixture-image",
    effectiveModel: "fixture-image",
    quality: null,
  } as const;
  return {
    image: async (
      _job: unknown,
      prompt: string,
      _abort: AbortSignal,
      imageOptions?: { readonly size?: "1024x1536" | "1024x1024" },
    ) => {
      const failure = options.failImage?.(calls.images.length);
      calls.images.push({ prompt, size: imageOptions?.size });
      if (failure) throw failure;
      return {
        value: new TextEncoder().encode(`png-bytes-${calls.images.length}`),
        model,
      };
    },
    reviewStartImage: async (task: {
      readonly candidate: Uint8Array;
      readonly styleAnchor: string;
      readonly startImagePrompt: string;
      readonly approvedImage: Uint8Array;
    }) => {
      calls.reviews.push({
        candidate: task.candidate,
        styleAnchor: task.styleAnchor,
        intent: task.startImagePrompt,
        approved: task.approvedImage.length,
      });
      const verdict = options.review?.(calls.reviews.length - 1) ?? "pass";
      return {
        value:
          verdict === "pass"
            ? pass
            : {
                status: "revise" as const,
                summary: "다시",
                issues: ["제품 색이 다릅니다"],
                revisionPrompt: `Revised prompt ${calls.reviews.length}`,
              },
        model,
      };
    },
  };
}
const newCalls = (): Calls => ({ images: [], reviews: [] });
const names = (id: string) => f.store.get(id).artifacts.map((asset) => asset.name);
const stateOf = (id: string) => f.store.get(id).renders[0]?.stills;

test("each declared still is generated once at 1024x1536 with the style anchor and reviewed against the approved image", async () => {
  const id = await readyForStills();
  const script = f.store.get(id).videoScripts[0];
  if (!script) throw new Error("script missing");
  expect(script.stills.map((still) => still.id)).toEqual(["S1", "S2"]);
  const calls = newCalls();
  await new StillProduction(f.store, providers(calls)).run(id, 1, signal());
  expect(calls.images).toHaveLength(2);
  expect(calls.images.every((call) => call.size === "1024x1536")).toBe(true);
  const first = script.stills[0];
  if (!first) throw new Error("still S1 missing");
  expect(calls.images[0]?.prompt).toBe(stillPrompt(script, first));
  expect(calls.images[0]?.prompt.startsWith(script.styleAnchor)).toBe(true);
  expect(calls.images[0]?.prompt).toContain(first.prompt);
  expect(calls.images[0]?.prompt).toContain("No text");
  // 검토: 승인 대표 이미지가 참조로 붙고 styleAnchor·원래 프롬프트가 함께 간다
  expect(calls.reviews).toHaveLength(2);
  expect(calls.reviews[0]?.styleAnchor).toBe(script.styleAnchor);
  expect(calls.reviews[0]?.intent).toBe(first.prompt);
  expect(calls.reviews[0]?.approved).toBeGreaterThan(0);
  // 산출물과 기록
  for (const stillId of ["S1", "S2"] as const) {
    expect(names(id)).toContain(renderNames.still(1, stillId, 1));
    expect(names(id)).toContain(renderNames.stillReview(1, stillId, 1));
    const state = stateOf(id)?.[stillId];
    expect(state).toMatchObject({ name: `still-1-${stillId}-1.png`, attempts: 1, status: "pass" });
    const bytes = new Uint8Array(
      await (await f.production.assets.read(id, `still-1-${stillId}-1.png`)).arrayBuffer(),
    );
    expect(state?.digest).toBe(contentDigest(bytes));
  }
  expect(f.store.get(id).artifacts.find((asset) => asset.name === "still-1-S1-1.png")?.kind).toBe(
    "image",
  );
  expect(f.store.get(id).agents.find((agent) => agent.id === "production")?.status).toBe(
    "completed",
  );
});

test("two rejected reviews force-pass the second image and still store its digest", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  await new StillProduction(f.store, providers(calls, { review: () => "revise" })).run(
    id,
    1,
    signal(),
  );
  // 장마다 생성 2회(시도 한도) + 검토 2회, 두 번째 프롬프트는 검토가 준 수정 프롬프트
  expect(STILL_MAX_ATTEMPTS).toBe(START_IMAGE_MAX_ATTEMPTS);
  expect(calls.images).toHaveLength(2 * STILL_MAX_ATTEMPTS);
  expect(calls.images[1]?.prompt).toBe("Revised prompt 1");
  for (const stillId of ["S1", "S2"] as const) {
    const state = stateOf(id)?.[stillId];
    expect(state).toMatchObject({
      name: `still-1-${stillId}-2.png`,
      attempts: 2,
      status: "forced",
    });
    // 강제 통과여도 digest 는 반드시 저장한다(조립 단계가 파일 변조를 재검증한다)
    expect(state?.digest).toMatch(/^[0-9a-f]{64}$/);
    const bytes = new Uint8Array(
      await (await f.production.assets.read(id, `still-1-${stillId}-2.png`)).arrayBuffer(),
    );
    expect(state?.digest).toBe(contentDigest(bytes));
    expect(names(id)).toContain(`still-1-${stillId}-1.png`);
    expect(names(id)).toContain(`still-review-1-${stillId}-2.json`);
  }
});

test("a second run finds every still recorded and makes zero image or review calls", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  const production = new StillProduction(f.store, providers(calls));
  await production.run(id, 1, signal());
  const before = { images: calls.images.length, reviews: calls.reviews.length };
  const artifacts = names(id).length;
  await production.run(id, 1, signal());
  await new StillProduction(f.store, providers(calls)).run(id, 1, signal());
  expect(calls.images).toHaveLength(before.images);
  expect(calls.reviews).toHaveLength(before.reviews);
  expect(names(id)).toHaveLength(artifacts);
});

test("a 400 for the portrait size falls back to 1024x1024 and keeps using it", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  const bad = new HTTPError(
    new Response("unsupported size", { status: 400 }),
    new Request("http://127.0.0.1/images"),
    {} as never,
  );
  await new StillProduction(
    f.store,
    providers(calls, { failImage: (index) => (index === 0 ? bad : null) }),
  ).run(id, 1, signal());
  // S1: 세로 400 → 정사각 재시도, S2: 처음부터 정사각(프로세스당 1회 판정)
  expect(calls.images.map((call) => call.size)).toEqual(["1024x1536", "1024x1024", "1024x1024"]);
  expect(stateOf(id)?.S1).toMatchObject({ name: "still-1-S1-1.png", attempts: 1, status: "pass" });
  expect(stateOf(id)?.S2).toMatchObject({ name: "still-1-S2-1.png", attempts: 1, status: "pass" });
});

test("an image saved before an interrupted review is reviewed again without generating a new image", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  const flaky = providers(calls);
  const real = flaky.reviewStartImage;
  let reviews = 0;
  const interrupted = {
    ...flaky,
    reviewStartImage: async (task: Parameters<typeof real>[0]) => {
      if (++reviews === 1) throw new Error("review connection reset");
      return real(task);
    },
  };
  await expect(new StillProduction(f.store, interrupted).run(id, 1, signal())).rejects.toThrow(
    "reset",
  );
  expect(calls.images).toHaveLength(1);
  expect(names(id)).toContain("still-1-S1-1.png");
  expect(stateOf(id)?.S1?.attempts).toBe(1);
  await new StillProduction(f.store, interrupted).run(id, 1, signal());
  // S1 은 저장된 PNG 를 재사용하고 S2 만 새로 만든다(총 2장), 검토 결과 파일은 한 번만 등록된다
  expect(calls.images).toHaveLength(2);
  expect(stateOf(id)?.S1).toMatchObject({ name: "still-1-S1-1.png", attempts: 1, status: "pass" });
  expect(names(id).filter((name) => name === "still-1-S1-1.png")).toHaveLength(1);
  expect(names(id).filter((name) => name === "still-review-1-S1-1.json")).toHaveLength(1);
});

test("failures that return no image never consume attempts", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  const failing = providers(calls, {
    failImage: (index) => (index < 4 ? new Error("fetch failed") : null),
  });
  for (let round = 0; round < 4; round++) {
    await expect(new StillProduction(f.store, failing).run(id, 1, signal())).rejects.toThrow(
      "fetch failed",
    );
    expect(stateOf(id)?.S1?.attempts).toBe(0);
  }
  await new StillProduction(f.store, failing).run(id, 1, signal());
  expect(stateOf(id)?.S1).toMatchObject({ name: "still-1-S1-1.png", attempts: 1 });
});

test("a leftover attempt counter without any saved image does not block the still", async () => {
  const id = await readyForStills();
  f.store.change(id, (draft) => {
    renderStateOf(draft, 1).stills.S1 = { name: "", digest: "", attempts: 2, status: "pass" };
  });
  const calls = newCalls();
  await new StillProduction(f.store, providers(calls)).run(id, 1, signal());
  expect(stateOf(id)?.S1).toMatchObject({ name: "still-1-S1-1.png", attempts: 1 });
});

test("a script without stills does nothing and a missing approved image blocks before any paid call", async () => {
  const id = await readyForStills();
  const calls = newCalls();
  f.store.change(id, (draft) => {
    const script = draft.videoScripts[0];
    if (script) script.stills = [];
  });
  await new StillProduction(f.store, providers(calls)).run(id, 1, signal());
  expect(calls.images).toHaveLength(0);
  expect(stateOf(id) ?? {}).toEqual({});
  // 스크립트에 다시 정지 이미지가 있어도 승인 대표 이미지가 없으면 호출 전에 멈춘다
  f.store.change(id, (draft) => {
    const script = draft.videoScripts[0];
    if (script)
      script.stills = [{ id: "S1", prompt: "Still S1: a kitchen counter, photographic, no text." }];
    for (const variant of draft.creativeVariants) variant.approvedImageId = null;
    if (draft.automation) draft.automation.approvedImageId = null;
  });
  await expect(
    new StillProduction(f.store, providers(calls)).run(id, 1, signal()),
  ).rejects.toBeInstanceOf(BlockedError);
  expect(calls.images).toHaveLength(0);
});
