import { expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { automationServices } from "../server/automation-services";
import { env } from "../server/config";
import { FlowImport } from "../server/flow-import";
import { Pipeline } from "../server/pipeline";
import { verifyVideoScript } from "../server/video-scripts";
import { FlowExportPreviewSchema, flowExportMarkdown } from "../shared/flow-mode";
import { videoScriptFromResponse } from "../shared/script-repair";
import { HfVideoScriptResponseSchema, VideoScriptSchema } from "../shared/video-script";
import { hfLabelFixture } from "./hf-label-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

function response() {
  const old = hybridScriptResponse();
  return {
    ...old,
    infoClips: old.infoClips.map((clip) => ({
      ...clip,
      labelLayer: hfLabelFixture(
        clip.infoLines.length,
        clip.objects.map((object) => object.subjectId),
      ),
    })),
  };
}

test("new model schema requires every label-plan field while retaining all copy", () => {
  // Given
  const input = response();
  // When
  const parsed = HfVideoScriptResponseSchema.parse(input);
  const missing = HfVideoScriptResponseSchema.safeParse(hybridScriptResponse());
  // Then
  expect(parsed.sentences.map((item) => item.text)).toEqual(
    input.sentences.map((item) => item.text),
  );
  expect(missing.success).toBe(false);
  function inspect(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (
      "type" in value &&
      value.type === "object" &&
      "properties" in value &&
      value.properties &&
      typeof value.properties === "object"
    ) {
      expect("additionalProperties" in value && value.additionalProperties).toBe(false);
      expect("required" in value ? value.required : []).toEqual(Object.keys(value.properties));
    }
    for (const child of Object.values(value)) inspect(child);
  }
  inspect(z.toJSONSchema(HfVideoScriptResponseSchema));
});

test("HTTP export and INFO import retain the plan while approval still protects paid production", async () => {
  // Given: only local fixture providers; no account, credit or real source job is changed.
  const f = await renderRuntimeFixture({
    script: (_job, hypothesisId, number) => {
      const { script } = videoScriptFromResponse(response(), {
        number,
        hypothesisId,
        targetSec: 36,
        hasCardSlides: false,
        requireApprovedImage: false,
      });
      return VideoScriptSchema.parse({
        ...script,
        planning: { ...fixtureVideoPlanning(), visualPolicy: "hybrid_explainer_v1" },
      });
    },
  });
  const engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
  try {
    const job = f.fresh();
    // When: drive the normal engine until the first production boundary.
    engine.start(job.id, {
      mode: "creative",
      imageCount: 1,
      videoCount: 1,
      scriptApproval: "required",
      clipMode: "flow",
    });
    await settle(engine);
    const blocked = f.store.get(job.id);
    // Then: no image, TTS, start-image, video or subscription call passes the script-approval boundary.
    expect(blocked.automation?.phase).toBe("script");
    for (const key of [
      "image",
      "voice",
      "startImage",
      "still",
      "veoCreate",
      "veoAwait",
      "subscription",
    ] as const)
      expect(f.counts[key]).toBe(0);
    expect(blocked.videoScripts[0]?.infoClips[0]?.labelLayer?.version).toBe("hyperframes_v1");
    const script = blocked.videoScripts[0];
    if (!script) throw new TypeError("Missing script");
    expect(() => verifyVideoScript(script, 1, script.hypothesisId)).not.toThrow();
    const app = createApp(f.store, new Pipeline(f.store), engine);
    const origin = `http://127.0.0.1:${env.PORT}`;
    const exported = await app.request(`${origin}/api/jobs/${job.id}/videos/1/flow-export`);
    expect(exported.status).toBe(200);
    const bundle = FlowExportPreviewSchema.parse(await exported.json());
    expect(bundle.infoClips[0]?.labelLayer).toEqual(
      blocked.videoScripts[0]?.infoClips[0]?.labelLayer,
    );
    const handoff = flowExportMarkdown({ ...bundle, clips: [] });
    const match = handoff.match(/```json\n([\s\S]*?)\n```/);
    if (!match?.[1]) throw new TypeError("Missing label handoff JSON");
    expect(JSON.parse(match[1])).toEqual({
      infoLines: bundle.infoClips[0]?.infoLines,
      labelLayer: bundle.infoClips[0]?.labelLayer,
    });
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XxkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const clean = await app.request(
      new Request(`${origin}/api/jobs/${job.id}/videos/1/info/I1/clean`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "image/png" },
        body: png,
      }),
    );
    expect(clean.status).toBe(200);
    const task = {
      jobId: job.id,
      number: 1,
      clipId: "I1" as const,
      which: "info" as const,
      bytes: png,
      signal: AbortSignal.timeout(5000),
    };
    // Inject only the external OCR boundary; exercise real import, persistence and rejection.
    await expect(
      new FlowImport(f.store, undefined, async () => ({
        lines: ["가"],
        marks: [],
      })).importInfoImage(task),
    ).rejects.toMatchObject({ code: "flow_info_text", status: 400 });
    expect(f.store.get(job.id).renders[0]?.infoImages.I1?.verified).toBe(false);
    await expect(
      new FlowImport(f.store, undefined, async () => ({
        lines: [],
        marks: ["label_connector"],
      })).importInfoImage(task),
    ).rejects.toMatchObject({ code: "flow_info_text", status: 400 });
    expect(f.store.get(job.id).renders[0]?.infoImages.I1?.verified).toBe(false);
    const accepted = await new FlowImport(f.store, undefined, async () => ({
      lines: [],
      marks: ["arrow", "ring", "leader_line"],
    })).importInfoImage(task);
    expect(accepted.problems).toEqual([]);
    const saved = f.store.get(job.id);
    expect(saved.renders[0]?.infoImages.I1?.verified).toBe(true);
    expect(saved.videoScripts[0]?.infoClips[0]?.infoLines).toEqual(
      blocked.videoScripts[0]?.infoClips[0]?.infoLines,
    );
  } finally {
    engine.close();
    await f.close();
  }
}, 30000);
