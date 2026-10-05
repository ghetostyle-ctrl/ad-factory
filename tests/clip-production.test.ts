import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { ClipProduction, VEO_HANDLE_TTL_MS } from "../server/clip-production";
import { BlockedError } from "../server/errors";
import { renderRuntimeFixture } from "./render-runtime-fixture";

// Veo 2패스(create/await)·핸들 재개·48시간 폐기·불확실(pendingSince)·시작 이미지 변조·프레임 검토 재생성.
// 실 Veo 호출 0회(스텁), ffmpeg 는 프레임 추출에만 쓴다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 클립 제작 테스트를 건너뜁니다.");
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});
// 기획·대본·이미지(AutomaticProduction) → voice → startImages 까지 돌려 클립 단계 직전 상태를 만든다
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

test.skipIf(!hasFfmpeg)(
  "creates four clips, awaits them and records names, digests and attempts",
  async () => {
    const id = await readyForClips();
    await new ClipProduction(f.store, f.providers.veo, f.providers.reviewClipFrames).run(
      id,
      1,
      signal(),
    );
    const render = f.store.get(id).renders.find((item) => item.number === 1);
    expect(f.counts.veoCreate).toBe(4);
    expect(f.counts.veoAwait).toBe(4);
    expect(f.counts.review).toBe(4 + 4);
    for (const clipId of ["A", "B", "C", "D"] as const) {
      const clip = render?.clips[clipId];
      expect(clip?.name).toBe(`clip-1-${clipId}-1.mp4`);
      expect(clip?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(clip?.attempts).toBe(1);
      expect(clip?.operation).toBeNull();
      expect(clip?.pendingSince).toBeNull();
    }
    expect(
      f.store.get(id).artifacts.filter((asset) => /^clip-1-[A-D]-1\.mp4$/.test(asset.name)),
    ).toHaveLength(4);
    expect(
      f.store.get(id).artifacts.filter((asset) => /^clip-review-1-[A-D]-1\.json$/.test(asset.name)),
    ).toHaveLength(4);
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "a new instance resumes saved handles by polling only, discarding handles older than 48h",
  async () => {
    const id = await readyForClips();
    f.control.awaitError = new Error("Polling connection interrupted");
    await expect(
      new ClipProduction(f.store, f.providers.veo, null).run(id, 1, signal()),
    ).rejects.toThrow("interrupted");
    expect(f.counts.veoCreate).toBe(4);
    const saved = f.store.get(id).renders[0]?.clips;
    expect(saved?.A?.operation?.name).toBe("operations/fixture-1");
    expect(saved?.A?.pendingSince).toBeNull();
    // 핸들 하나는 49시간 전 생성으로 바꾼다 → 폐기·재생성 1회(받지 못한 시도는 세지 않아 -1 이름을 다시 쓴다)
    f.store.change(id, (draft) => {
      const clip = draft.renders[0]?.clips.D;
      if (clip?.operation)
        clip.operation = {
          ...clip.operation,
          startedAt: new Date(Date.now() - VEO_HANDLE_TTL_MS - 3600_000).toISOString(),
        };
      if (draft.automation) draft.automation.operation = null;
    });
    f.control.awaitError = null;
    await new ClipProduction(f.store, f.providers.veo, null).run(id, 1, signal());
    expect(f.counts.veoCreate).toBe(5);
    // 첫 실행은 A 에서 끊겼으니(await 1회) 재개 때 4회만 폴링한다
    expect(f.counts.veoAwait).toBe(1 + 4);
    expect(f.store.get(id).renders[0]?.clips.D?.name).toBe("clip-1-D-1.mp4");
    expect(f.store.get(id).renders[0]?.clips.A?.name).toBe("clip-1-A-1.mp4");
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "a clip left pendingSince stays uncertain until the user resumes, then regenerates once",
  async () => {
    const id = await readyForClips();
    f.store.change(id, (draft) => {
      const render = draft.renders[0];
      if (render)
        render.clips.B = {
          name: null,
          digest: null,
          attempts: 1,
          pendingSince: new Date().toISOString(),
          operation: null,
        };
    });
    await expect(
      new ClipProduction(f.store, f.providers.veo, null).run(id, 1, signal()),
    ).rejects.toMatchObject({ code: "clip_uncertain" });
    expect(f.counts.veoCreate).toBe(0);
    // 사용자 재개(attention 상태) → pendingSince 해제
    f.store.change(id, (draft) => {
      if (draft.automation) {
        draft.automation.status = "attention";
        draft.automation.operation = "clips";
      }
    });
    new AutomationEnrollment(f.store).resume(id);
    expect(f.store.get(id).renders[0]?.clips.B?.pendingSince).toBeNull();
    await new ClipProduction(f.store, f.providers.veo, null).run(id, 1, signal());
    expect(f.counts.veoCreate).toBe(4);
    expect(f.store.get(id).renders[0]?.clips.B?.name).toBe("clip-1-B-2.mp4");
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "a tampered start image blocks before any Veo request",
  async () => {
    const id = await readyForClips();
    await Bun.write(join(f.store.root, "artifacts", id, "start-1-C-1.png"), "changed bytes");
    const failure = new ClipProduction(f.store, f.providers.veo, null).run(id, 1, signal());
    await expect(failure).rejects.toBeInstanceOf(BlockedError);
    await expect(failure).rejects.toThrow("변경");
    expect(f.counts.veoCreate).toBe(0);
  },
  60_000,
);

test.skipIf(!hasFfmpeg)(
  "a failed frame review regenerates once and the second result is accepted",
  async () => {
    const id = await readyForClips();
    let reviews = 0;
    const clips = new ClipProduction(f.store, f.providers.veo, async () => {
      reviews++;
      return reviews <= 4
        ? {
            value: {
              status: "revise",
              summary: "Fixture defect",
              issues: ["Morphing"],
              revisionPrompt: "Replace",
            },
            model: { provider: "openai", requestedModel: "m", effectiveModel: "m", quality: null },
          }
        : {
            value: { status: "pass", summary: "ok", issues: [], revisionPrompt: null },
            model: { provider: "openai", requestedModel: "m", effectiveModel: "m", quality: null },
          };
    });
    await clips.run(id, 1, signal());
    expect(f.counts.veoCreate).toBe(8);
    expect(reviews).toBe(8);
    const render = f.store.get(id).renders[0];
    for (const clipId of ["A", "B", "C", "D"] as const) {
      expect(render?.clips[clipId]?.attempts).toBe(2);
      expect(render?.clips[clipId]?.name).toBe(`clip-1-${clipId}-2.mp4`);
    }
    // 두 번 다 불합격이면 2회차를 수용한다
    const other = await readyForClips();
    f.counts.veoCreate = 0;
    await new ClipProduction(f.store, f.providers.veo, async () => ({
      value: {
        status: "revise",
        summary: "Fixture defect",
        issues: ["Morphing"],
        revisionPrompt: "Replace",
      },
      model: { provider: "openai", requestedModel: "m", effectiveModel: "m", quality: null },
    })).run(other, 1, signal());
    expect(f.counts.veoCreate).toBe(8);
    expect(f.store.get(other).renders[0]?.clips.A?.name).toBe("clip-1-A-2.mp4");
  },
  120_000,
);
