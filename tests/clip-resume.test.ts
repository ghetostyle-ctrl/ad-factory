import { afterEach, beforeEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { ClipProduction, type FrameExtractor, type VideoProvider } from "../server/clip-production";
import { StudioError } from "../server/errors";
import { renderRuntimeFixture } from "./render-runtime-fixture";

// Veo 클립 재개 안전성: 결정적 실패의 핸들 폐기, 과금 없는 실패는 시도로 세지 않음, 저장·검토 중단 뒤 재사용.
// Veo·검토는 전부 스텁이고 프레임 추출도 스텁이라 외부 호출과 ffmpeg 검토 호출이 없다.
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});
async function readyForClips() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
    clipReview: true,
  });
  await f.production.run(job.id, signal());
  await f.deps.voice?.run(job.id, 1, signal(), { concurrencyLimit: 3 });
  await f.deps.startImages?.run(job.id, 1, signal());
  return job.id;
}
const veo = (): VideoProvider => {
  if (!f.providers.veo) throw new Error("fixture veo provider missing");
  return f.providers.veo;
};
const extract: FrameExtractor = async () => [new Uint8Array([1, 2, 3])];
const clipsOf = (id: string) => f.store.get(id).renders[0]?.clips;
const names = (id: string) => f.store.get(id).artifacts.map((asset) => asset.name);
const duplicates = (list: readonly string[]) =>
  list.filter((name, index) => list.indexOf(name) !== index);

test("a Veo error clears the handle without counting an attempt and the next resume regenerates", async () => {
  const id = await readyForClips();
  f.control.awaitError = new StudioError("veo_failed", "Veo 영상 생성 실패: 안전 필터", 409);
  await expect(
    new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal()),
  ).rejects.toMatchObject({ code: "veo_failed", message: expect.stringContaining("폐기") });
  expect(f.counts.veoCreate).toBe(4);
  expect(f.counts.veoAwait).toBe(4);
  for (const clipId of ["A", "B", "C", "D"] as const) {
    expect(clipsOf(id)?.[clipId]).toMatchObject({
      name: null,
      operation: null,
      pendingSince: null,
      attempts: 0,
    });
  }
  // 같은 핸들을 다시 폴링하지 않는다: 재개하면 새로 만들고 폴링도 새 핸들만 한다
  f.control.awaitError = null;
  await new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal());
  expect(f.counts.veoCreate).toBe(8);
  expect(f.counts.veoAwait).toBe(8);
  expect(clipsOf(id)?.A).toMatchObject({ name: "clip-1-A-1.mp4", attempts: 1 });
}, 60_000);

test("a downloaded clip that fails validation counts as a billed attempt", async () => {
  const id = await readyForClips();
  f.control.awaitError = new StudioError(
    "veo_format",
    "Veo 결과가 8초 세로 MP4 규격에 맞지 않습니다.",
  );
  await expect(
    new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal()),
  ).rejects.toMatchObject({ code: "veo_format" });
  expect(clipsOf(id)?.A).toMatchObject({ operation: null, attempts: 1, name: null });
  f.control.awaitError = null;
  await new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal());
  expect(clipsOf(id)?.A).toMatchObject({ name: "clip-1-A-2.mp4", attempts: 2 });
}, 60_000);

test("HTTP rejections of the create request never consume attempts or leave an uncertain mark", async () => {
  const id = await readyForClips();
  let failures = 3;
  const provider: VideoProvider = {
    await: veo().await,
    create: async (task) => {
      if (failures-- > 0)
        throw new StudioError("veo_request", "Veo 요청 실패 (HTTP 429). 잠시 뒤 다시 시도하세요.");
      return veo().create(task);
    },
  };
  // 세 번 연속 거절돼도 시도 한도(2회)에 걸리지 않는다
  for (let round = 0; round < 3; round++) {
    await expect(
      new ClipProduction(f.store, provider, null, extract).run(id, 1, signal()),
    ).rejects.toMatchObject({ code: "veo_request" });
    expect(clipsOf(id)?.A).toMatchObject({ attempts: 0, pendingSince: null, operation: null });
  }
  expect(f.counts.veoCreate).toBe(0);
  await new ClipProduction(f.store, provider, null, extract).run(id, 1, signal());
  expect(f.counts.veoCreate).toBe(4);
  expect(clipsOf(id)?.A).toMatchObject({ name: "clip-1-A-1.mp4", attempts: 1 });
}, 60_000);

test("a create timeout keeps the uncertain mark (no attempt counted) until the user confirms", async () => {
  const id = await readyForClips();
  let timeouts = 1;
  const provider: VideoProvider = {
    await: veo().await,
    create: async (task) => {
      if (timeouts-- > 0) throw new DOMException("The operation timed out.", "TimeoutError");
      return veo().create(task);
    },
  };
  await expect(
    new ClipProduction(f.store, provider, null, extract).run(id, 1, signal()),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(clipsOf(id)?.A?.pendingSince).not.toBeNull();
  expect(clipsOf(id)?.A?.attempts).toBe(0);
  // 사용자가 확인하기 전에는 다시 요청하지 않는다
  await expect(
    new ClipProduction(f.store, provider, null, extract).run(id, 1, signal()),
  ).rejects.toMatchObject({ code: "clip_uncertain" });
  expect(f.counts.veoCreate).toBe(0);
  f.store.change(id, (draft) => {
    if (draft.automation) {
      draft.automation.status = "attention";
      draft.automation.operation = "clips";
    }
  });
  new AutomationEnrollment(f.store).resume(id);
  await new ClipProduction(f.store, provider, null, extract).run(id, 1, signal());
  expect(f.counts.veoCreate).toBe(4);
}, 60_000);

test("a discarded 48h handle gives its attempt back", async () => {
  const id = await readyForClips();
  f.control.awaitError = new Error("Polling connection interrupted");
  await expect(
    new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal()),
  ).rejects.toThrow("interrupted");
  f.control.awaitError = null;
  f.store.change(id, (draft) => {
    const clip = draft.renders[0]?.clips.B;
    if (clip?.operation)
      clip.operation = {
        ...clip.operation,
        startedAt: new Date(Date.now() - 49 * 3600_000).toISOString(),
      };
    if (draft.automation) draft.automation.operation = null;
  });
  await new ClipProduction(f.store, veo(), null, extract).run(id, 1, signal());
  expect(clipsOf(id)?.B).toMatchObject({ name: "clip-1-B-1.mp4", attempts: 1 });
}, 60_000);

test("a clip saved before an interrupted frame review is reused without a second download or entry", async () => {
  const id = await readyForClips();
  let reviews = 0;
  const reviewer = f.providers.reviewClipFrames;
  if (!reviewer) throw new Error("fixture reviewer missing");
  const flaky: typeof reviewer = async (task) => {
    reviews++;
    if (reviews === 1) throw new Error("review connection reset");
    return reviewer(task);
  };
  await expect(
    new ClipProduction(f.store, veo(), flaky, extract).run(id, 1, signal()),
  ).rejects.toThrow("reset");
  expect(f.counts.veoAwait).toBe(1);
  expect(clipsOf(id)?.A?.operation).not.toBeNull();
  expect(names(id)).toContain("clip-1-A-1.mp4");
  await new ClipProduction(f.store, veo(), flaky, extract).run(id, 1, signal());
  // A 는 다시 폴링·다운로드하지 않고, 나머지 3개만 폴링한다
  expect(f.counts.veoAwait).toBe(1 + 3);
  expect(duplicates(names(id))).toEqual([]);
  expect(clipsOf(id)?.A).toMatchObject({ name: "clip-1-A-1.mp4", operation: null });
}, 60_000);

test("a saved review result is reused when the clip record was lost before the final write", async () => {
  const id = await readyForClips();
  await new ClipProduction(f.store, veo(), f.providers.reviewClipFrames, extract).run(
    id,
    1,
    signal(),
  );
  const awaits = f.counts.veoAwait;
  const reviews = f.counts.review;
  // 검토 결과까지 저장했지만 클립 기록(name·operation 해제) 직전에 끊긴 상태를 만든다
  f.store.change(id, (draft) => {
    const clip = draft.renders[0]?.clips.A;
    if (clip)
      Object.assign(clip, {
        name: null,
        digest: null,
        operation: {
          name: "operations/fixture-1",
          startedAt: new Date().toISOString(),
          model: "m",
        },
      });
  });
  await new ClipProduction(f.store, veo(), f.providers.reviewClipFrames, extract).run(
    id,
    1,
    signal(),
  );
  expect(f.counts.veoAwait).toBe(awaits);
  expect(f.counts.review).toBe(reviews);
  expect(clipsOf(id)?.A).toMatchObject({ name: "clip-1-A-1.mp4", operation: null });
  expect(duplicates(names(id))).toEqual([]);
}, 60_000);
