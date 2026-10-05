import { expect, test } from "bun:test";
import { z } from "zod";
import { snapshotModels } from "../server/model-settings";
import { reviewVideoScript } from "../server/video-scripts";
import { fixtureStrategy, httpFixture } from "./automation-http-fixture";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture } from "./render-runtime-fixture";

test("review receives visual source plans and ordered cut references for continuity decisions", async () => {
  const runtime = await renderRuntimeFixture({ stubRender: true, clipReview: false });
  const http = httpFixture();
  try {
    const job = runtime.store.change(runtime.fresh().id, (draft) => {
      draft.executionModels = snapshotModels(runtime.root);
    });
    const signal = new AbortController().signal;
    const planned = await runtime.providers.plan?.(job, fixtureStrategy, signal);
    const hypothesis = planned?.value.hypotheses[0];
    if (!hypothesis) throw new Error("Fixture hypothesis missing");
    const script = renderScript(1, hypothesis.id, 36);

    const result = await reviewVideoScript(
      { job, script, hypothesis, signal },
      {
        apiKey: "local-fixture-only",
        baseUrl: `http://127.0.0.1:${http.server.port}/openai/`,
      },
    );

    expect(result.value.status).toBe("pass");
    const request = http.requests.find((item) => item.path === "/openai/responses");
    const { input } = z.object({ input: z.string() }).parse(request?.body);
    const marker = "\nDATA:\n";
    const data: unknown = JSON.parse(input.slice(input.indexOf(marker) + marker.length));
    expect(data).toMatchObject({
      styleAnchor: script.styleAnchor,
      stills: script.stills,
      veoClips: script.veoClips,
      editInstructions: script.editInstructions,
      visualSequence: script.cuts.map((cut, cutIndex) => ({
        cutIndex,
        startSec: cut.startSec,
        endSec: cut.endSec,
        source: cut.source,
        veoClip: cut.veoClip,
        stillId: cut.stillId,
        effect: cut.effect,
        screenComposition: cut.screenComposition,
        onScreenText: cut.onScreenText,
        graphicLines: cut.graphicLines,
      })),
    });
    expect(http.requests.filter((item) => item.path === "/openai/responses")).toHaveLength(1);
    expect(runtime.counts.image).toBe(0);
    expect(runtime.counts.voice).toBe(0);
    expect(runtime.counts.veoCreate).toBe(0);
  } finally {
    await http.server.stop(true);
    await runtime.close();
  }
});
