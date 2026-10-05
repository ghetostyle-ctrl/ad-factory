import { afterEach, beforeEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { approvedSources } from "../server/render-state-helpers";
import type { ReviewedImageProviders } from "../server/reviewed-image-production";
import { StartImageProduction } from "../server/start-image-production";
import { StillProduction } from "../server/still-production";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true });
});
afterEach(async () => {
  await f.close();
});

async function ready() {
  const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
  });
  await f.production.run(job.id, signal());
  f.store.change(job.id, (draft) => {
    const hypothesisId = draft.videoScripts[0]?.hypothesisId;
    if (!hypothesisId) throw new Error("script missing");
    draft.videoScripts[0] = renderScript(1, hypothesisId, 36);
  });
  const current = f.store.get(job.id);
  const script = current.videoScripts[0];
  if (!script) throw new Error("script missing");
  const approved = approvedSources(current, script.hypothesisId).approvedImage;
  if (!approved) throw new Error("approved image missing");
  const bytes = new Uint8Array(
    await (await f.production.assets.read(job.id, approved.name)).arrayBuffer(),
  );
  return { id: job.id, approved: bytes };
}

function recordingProviders() {
  const references: (readonly Uint8Array[])[] = [];
  const generated: Uint8Array[] = [];
  const review = f.providers.reviewStartImage;
  if (!review) throw new Error("fixture reviewer missing");
  const providers: ReviewedImageProviders = {
    image: async (job, prompt, abort, options) => {
      references.push(options?.referenceImages ?? []);
      const result = await f.providers.image(job, prompt, abort, options);
      const value = new Uint8Array([...result.value, generated.length]);
      generated.push(value);
      return { ...result, value };
    },
    reviewStartImage: review,
  };
  return { providers, references, generated };
}

test("stills and starts receive approved pixels plus the same first passed photographic anchor", async () => {
  // Given
  const { id, approved } = await ready();
  const calls = recordingProviders();
  // When
  await new StillProduction(f.store, calls.providers).run(id, 1, signal());
  await new StartImageProduction(f.store, calls.providers).run(id, 1, signal());
  // Then
  expect(calls.references).toHaveLength(6);
  expect(calls.references[0]).toEqual([approved]);
  const anchor = calls.generated[0];
  if (!anchor) throw new Error("first still missing");
  for (const reference of calls.references.slice(1)) expect(reference).toEqual([approved, anchor]);
});

test("forced stills never become scene anchors and starts establish their own passed anchor", async () => {
  // Given
  const { id, approved } = await ready();
  const calls = recordingProviders();
  const forced: ReviewedImageProviders = {
    ...calls.providers,
    reviewStartImage: async (task) => {
      const result = await calls.providers.reviewStartImage(task);
      return { ...result, value: { ...result.value, status: "revise", issues: ["fixture"] } };
    },
  };
  // When
  await new StillProduction(f.store, forced).run(id, 1, signal());
  await new StartImageProduction(f.store, calls.providers).run(id, 1, signal());
  // Then
  expect(calls.references).toHaveLength(8);
  for (const reference of calls.references.slice(0, 5)) expect(reference).toEqual([approved]);
  const anchor = calls.generated[4];
  if (!anchor) throw new Error("first start image missing");
  for (const reference of calls.references.slice(5)) expect(reference).toEqual([approved, anchor]);
});

test("a changed photographic anchor blocks before another generation request", async () => {
  // Given
  const { id } = await ready();
  const calls = recordingProviders();
  await new StillProduction(f.store, calls.providers).run(id, 1, signal());
  await Bun.write(f.production.assets.path(id, "still-1-S1-1.png"), "changed image");
  const count = calls.references.length;
  // When
  const running = new StartImageProduction(f.store, calls.providers).run(id, 1, signal());
  // Then
  await expect(running).rejects.toThrow("변경");
  expect(calls.references).toHaveLength(count);
});
