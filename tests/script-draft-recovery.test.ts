import { expect, test } from "bun:test";
import { Artifacts } from "../server/artifacts";
import { AutomationEngine } from "../server/automation";
import { WaitingError } from "../server/errors";
import { VideoScriptService } from "../server/script-service";
import { pendingScriptDraft } from "../shared/script-drafts";
import { scriptDraftFixture as setup } from "./script-draft-fixture";
import { FIXTURE_COPY } from "./video-planning-http-fixture";

test("the real HTTP provider repairs labels before strict parsing and preserves raw and final copy", async () => {
  const f = setup("repair");
  try {
    const result = await f.write();
    const job = f.store.get(f.job.id),
      assets = new Artifacts(f.store);
    expect(f.calls()).toBe(1);
    expect(result.script.voiceover.map((v) => v.text)).toEqual(
      FIXTURE_COPY.lines.map((l) => l.text),
    );
    expect(result.review.repairs.some((r) => r.includes("안전영역"))).toBe(true);
    const raw = await (await assets.read(job.id, "video-script-response-1-1.json")).json();
    expect(raw).toEqual(f.value);
    const saved = await (await assets.read(job.id, "video-script-draft-1-1.json")).json();
    expect(saved.voiceover.map((v: { text: string }) => v.text)).toEqual(
      FIXTURE_COPY.lines.map((l) => l.text),
    );
    expect(saved.infoClips[0].labelLayer.labels[0].box.x).toBe(0.16);
    expect(saved.infoClips[0].labelLayer.labels[0].anchors).toEqual(
      f.value.infoClips[0]?.labelLayer.labels[0]?.anchors,
    );
  } finally {
    f.close();
  }
});

test("an unrepairable overlap waits with a named issue and exact response without another paid attempt", async () => {
  const f = setup("overlap");
  try {
    let failure: unknown;
    try {
      await f.write();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WaitingError);
    if (!(failure instanceof WaitingError)) throw new TypeError("Expected draft waiting");
    expect(failure.message).toContain("대본 초안 수정 대기");
    expect(failure.message).toContain("설명 컷 1");
    expect(failure.message).toContain("겹칠 수 없습니다");
    expect(failure.ready(f.store.get(f.job.id))).toBe(false);
    expect(f.calls()).toBe(1);
    expect(f.store.get(f.job.id).videoScripts).toEqual([]);
    const assets = new Artifacts(f.store);
    const raw = await (await assets.read(f.job.id, "video-script-response-1-1.json")).text();
    expect(raw).toBe(JSON.stringify(f.value));
    const issues = await (await assets.read(f.job.id, "video-script-issues-1-1.json")).json();
    expect(issues.responseName).toBe("video-script-response-1-1.json");
    await expect(f.write()).rejects.toBeInstanceOf(WaitingError);
    expect(await (await assets.read(f.job.id, "video-script-response-1-1.json")).text()).toBe(raw);
    expect(
      f.store.get(f.job.id).artifacts.some((a) => a.name === "video-script-response-1-2.json"),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test("retains the first valid draft when a later correction response fails validation", async () => {
  const f = setup("second-invalid");
  try {
    await expect(f.write()).rejects.toBeInstanceOf(WaitingError);
    expect(f.calls()).toBe(2);
    const assets = new Artifacts(f.store);
    const previous = await (await assets.read(f.job.id, "video-script-draft-1-1.json")).json();
    expect(previous.voiceover.map((v: { text: string }) => v.text)).toEqual(
      FIXTURE_COPY.lines.map((l) => l.text),
    );
    expect(
      f.store.get(f.job.id).artifacts.some((a) => a.name === "video-script-response-1-2.json"),
    ).toBe(true);
    expect(
      f.store.get(f.job.id).artifacts.some((a) => a.name === "video-script-issues-1-2.json"),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test("the automation engine parks an invalid draft and does not retry on later ticks", async () => {
  const f = setup("overlap");
  const unused = async () => {
    throw new TypeError("Unexpected production stage");
  };
  const engine = new AutomationEngine(f.store, {
    produce: async (id) => {
      f.store.change(id, (job) => {
        if (job.automation) job.automation.phase = "script";
      });
      await f.write();
    },
    prepare: unused,
    activate: unused,
    analyze: unused,
    pause: unused,
    scripts: new VideoScriptService(f.store, f.providers),
  });
  try {
    await engine.tick();
    await Promise.all([...engine.active.values()].map((task) => task.promise));
    const job = f.store.get(f.job.id);
    expect(job.status).toBe("review");
    expect(job.automation?.status).toBe("waiting");
    expect(job.automation?.lastError).toBeNull();
    expect(job.automation?.nextRunAt).toBeNull();
    expect(pendingScriptDraft(job)?.response?.name).toBe("video-script-response-1-1.json");
    await engine.tick();
    expect(f.calls()).toBe(1);
    expect(job.artifacts.filter((a) => a.kind === "image" || a.kind === "video")).toEqual([]);
  } finally {
    engine.close();
    f.close();
  }
});

test("an actual font-layout failure preserves the full label instead of truncating it", async () => {
  const f = setup("layout");
  try {
    await expect(f.write()).rejects.toMatchObject({
      name: "WaitingError",
      message: expect.stringContaining("설명 컷 I1"),
    });
    const raw = await (
      await new Artifacts(f.store).read(f.job.id, "video-script-response-1-1.json")
    ).json();
    expect(raw.infoClips[0].infoLines[0]).toBe("라".repeat(24));
    expect(f.calls()).toBe(1);
  } finally {
    f.close();
  }
});
