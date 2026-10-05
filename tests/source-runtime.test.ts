import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { AutomationGuard, contentDigest, scopeDigest } from "../server/automation-guard";
import { AutomaticProduction, type ProductionProviders } from "../server/automation-production";
import { automationServices } from "../server/automation-services";
import { evidencePack } from "../server/evidence-pack";
import { saveModelSettings } from "../server/model-settings";
import { Pipeline } from "../server/pipeline";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";
import { CreativePlanSchema } from "../shared/creative-plan";
import type { Job } from "../shared/schema";
import { CreateProjectSchema, CreateSourceSchema } from "../shared/sources";
import { videoTargetSeconds } from "../shared/video-script";
import { automationBrief, automationPolicy, automationRequest } from "./automation-fixture";
import { fixtureCreative, fixturePng, fixtureStrategy } from "./automation-http-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";
import { longVideoScript } from "./video-script-fixture";

const model = {
  provider: "openai",
  requestedModel: "fixture-text",
  effectiveModel: "fixture-text",
  quality: null,
} as const;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-runtime-"));
  const store = new JobStore(root);
  const projects = new ProjectStore(store.db);
  const project = projects.createProject(
    CreateProjectSchema.parse({ name: "Local source fixture" }),
  );
  const source = projects.addSource(
    project.id,
    CreateSourceSchema.parse({
      kind: "product_fact",
      title: "Documented fact",
      content: automationBrief.productDescription,
    }),
  );
  saveModelSettings(root, {
    textProvider: "openai",
    textModel: "fixture-text",
    codexModel: null,
    imageModel: "gpt-image-2",
    imageQuality: "high",
    ttsProvider: "typecast",
    ttsSelection: "auto",
    ttsVoiceId: null,
    ttsTempo: 1,
  });
  const fresh = () => {
    const job = store.create({ ...automationBrief, projectId: project.id });
    return store.change(job.id, (draft) => {
      draft.accountId = "act_123";
      draft.selection = { accountId: "act_123", pageId: "456" };
    });
  };
  const plan = (job: Job) => {
    if (!job.sourceSnapshot) throw new Error("Fixture snapshot missing");
    const imageCount =
      job.automation?.policy.mode === "creative" ? (job.automation.policy.imageCount ?? 3) : 3;
    const angles = ["problem_solution", "usage_context", "objection_answer"] as const;
    return CreativePlanSchema.parse({
      sourceDigest: job.sourceSnapshot.digest,
      sourceCoverage: evidencePack(job.sourceSnapshot).coverage,
      referenceAnalyses: [],
      diversityRationale: "Three distinct contexts",
      limitations: ["Synthetic fixture only"],
      hypotheses: Array.from({ length: imageCount }, (_, index) => ({
        id: `concept-${index + 1}`,
        angle: angles[index % angles.length],
        targetAudience: `Audience ${index}`,
        targetReason: `Source fact supports message for audience ${index}`,
        customerSituation: `Situation ${index}`,
        problem: `Problem ${index}`,
        message: `Message ${index}`,
        hook: `Hook ${index}`,
        difference: `Different mechanism ${index}`,
        visualMechanism: `Visual ${index}`,
        claimCitations: [{ sourceId: source.id, quote: source.content }],
        referenceSourceIds: [],
        creative: {
          ...fixtureCreative,
          concept: `Concept ${index}`,
          imagePrompt: `Prompt ${index}`,
        },
      })),
    });
  };
  let images = 0;
  let scripts = 0;
  const providers: ProductionProviders = {
    strategy: async () => ({ value: fixtureStrategy, model }),
    creative: async () => ({ value: fixtureCreative, model }),
    plan: async (job) => ({ value: plan(job), model }),
    videoScript: async (job, hypothesis, number) => {
      expect(images).toBe(0);
      scripts++;
      return {
        value: longVideoScript(number, hypothesis.id, videoTargetSeconds(job.id, number)),
        model,
      };
    },
    reviewVideoScript: async () => ({
      value: { status: "pass", summary: "픽스처 대본 검토 통과", issues: [] },
      model,
    }),
    image: async () => {
      images++;
      return { value: new Uint8Array(Buffer.from(fixturePng, "base64")), model };
    },
    review: async () => ({
      value: {
        status: "pass",
        summary: "Fixture pixels reviewed",
        issues: [],
        revisionPrompt: null,
      },
      model,
    }),
  };
  return {
    store,
    projects,
    project,
    source,
    fresh,
    providers,
    images: () => images,
    scripts: () => scripts,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("source runtime boundaries", () => {
  test("freezes selected facts when the project library changes", async () => {
    const f = await fixture();
    try {
      const job = f.fresh();
      f.projects.updateSource(
        f.project.id,
        f.source.id,
        CreateSourceSchema.parse({
          kind: "product_fact",
          title: f.source.title,
          content: "Updated product evidence",
        }),
      );
      expect(f.store.get(job.id).sourceSnapshot?.digest).toBe(job.sourceSnapshot?.digest);
      expect(f.store.get(job.id).sourceSnapshot?.sources[0]?.content).toBe(f.source.content);
    } finally {
      await f.close();
    }
  });
  test("rejects an operating period extending beyond frozen offer expiry", async () => {
    const f = await fixture();
    try {
      f.projects.addSource(
        f.project.id,
        CreateSourceSchema.parse({
          kind: "offer",
          title: "Expiring offer",
          content: "Offer valid for one hour",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(() =>
        new AutomationEnrollment(f.store).start(f.fresh().id, automationPolicy()),
      ).toThrow("유효기간");
    } finally {
      await f.close();
    }
  });
  test("rejects legacy manual run upload and analytics for source jobs", async () => {
    const f = await fixture();
    const engine = new AutomationEngine(f.store);
    try {
      const job = f.fresh();
      const app = createApp(f.store, new Pipeline(f.store), engine);
      for (const action of ["run", "upload", "analyze"]) {
        const response = await app.request(automationRequest(`${job.id}/${action}`, {}));
        expect(response.status).toBe(409);
      }
      expect(f.store.get(job.id).artifacts).toHaveLength(0);
    } finally {
      engine.close();
      await f.close();
    }
  });
  test("produces three reviewed creatives and binds approved plan against later edits", async () => {
    const f = await fixture();
    try {
      const job = new AutomationEnrollment(f.store).start(f.fresh().id, automationPolicy());
      await new AutomaticProduction(f.store, f.providers).run(job.id, new AbortController().signal);
      const produced = f.store.get(job.id);
      expect(produced.creativeVariants.filter((item) => item.reviewStatus === "pass")).toHaveLength(
        3,
      );
      expect(f.images()).toBe(3);
      expect(produced.automation?.approvedPlanDigest).toBe(
        contentDigest(JSON.stringify(produced.creativePlan)),
      );
      f.store.change(job.id, (draft) => {
        const first = draft.creativeVariants[0];
        if (first) first.creative.headline = "Tampered copy";
      });
      expect(() =>
        new AutomationGuard(f.store).check(job.id, new AbortController().signal),
      ).toThrow("기획");
    } finally {
      await f.close();
    }
  });
  test("project creative automation finishes three images without ad account or Meta stage", async () => {
    const f = await fixture();
    const production = new AutomaticProduction(f.store, f.providers);
    const engine = new AutomationEngine(f.store, automationServices(f.store, { production }));
    try {
      const job = f.store.create({
        ...automationBrief,
        projectId: f.project.id,
        dailyBudget: null,
      });
      engine.start(job.id, { mode: "creative" });
      await engine.tick();
      await Promise.all([...engine.active.values()].map((task) => task.promise));
      const result = f.store.get(job.id);
      expect(result.automation?.status).toBe("completed");
      expect(
        result.creativeVariants.filter((variant) => variant.reviewStatus === "pass"),
      ).toHaveLength(3);
      expect(f.images()).toBe(3);
      expect(result.staged).toBeNull();
      expect(result.accountId).toBeNull();
    } finally {
      engine.close();
      await f.close();
    }
  });
  test("project creative automation honors selected ten-image and ten-video limits", async () => {
    // 영상은 클립 단위: 영상마다 veoClips 수(longVideoScript 는 A 하나)만큼 Veo 생성 요청, 프롬프트에 clip.prompt 포함.
    // 그래픽·조립은 스텁(ffmpeg 호출 없음)이라 완성본 없이 클립까지만 센다.
    const r = await renderRuntimeFixture({
      stubRender: true,
      clipReview: false,
      script: (job, hypothesisId, number) =>
        longVideoScript(number, hypothesisId, videoTargetSeconds(job.id, number)),
    });
    const engine = new AutomationEngine(
      r.store,
      automationServices(r.store, { production: r.production, renderPipeline: r.renderPipeline }),
    );
    try {
      const job = r.fresh();
      engine.start(job.id, {
        mode: "creative",
        imageCount: 10,
        videoCount: 10,
        scriptApproval: "auto",
      });
      await settle(engine);
      const result = r.store.get(job.id);
      expect(result.automation?.lastError).toBeNull();
      expect(result.automation?.status).toBe("completed");
      expect(result.creativeVariants).toHaveLength(10);
      expect(result.videoScripts).toHaveLength(10);
      expect(
        result.artifacts.filter((asset) => /^video-script-\d+\.json$/.test(asset.name)),
      ).toHaveLength(10);
      // AI 대본 검토 기록도 영상마다 하나씩
      expect(
        result.artifacts.filter((asset) => /^video-script-review-\d+-1\.json$/.test(asset.name)),
      ).toHaveLength(10);
      expect(r.counts.veoCreate).toBe(10);
      expect(r.counts.veoAwait).toBe(10);
      expect(r.counts.startImage).toBe(10);
      expect(r.counts.voice).toBe(
        result.videoScripts.reduce((sum, script) => sum + script.voiceover.length, 0),
      );
      for (const prompt of r.veoPrompts) expect(prompt).toContain("Portrait product scene");
      expect(result.artifacts.filter((asset) => asset.kind === "video")).toHaveLength(10);
      expect(result.renders).toHaveLength(10);
      expect(result.renders.every((render) => render.clips.A?.name)).toBe(true);
      expect(result.staged).toBeNull();
    } finally {
      engine.close();
      await r.close();
    }
  }, 120_000);
  test("Veo does not receive an approved image whose file bytes changed", async () => {
    const r = await renderRuntimeFixture({
      stubRender: true,
      clipReview: false,
      script: (job, hypothesisId, number) =>
        longVideoScript(number, hypothesisId, videoTargetSeconds(job.id, number)),
    });
    try {
      const job = new AutomationEnrollment(r.store).start(r.fresh().id, {
        mode: "creative",
        imageCount: 1,
        videoCount: 1,
        scriptApproval: "auto",
      });
      await r.production.run(job.id, new AbortController().signal);
      const image = r.store.get(job.id).artifacts.find((asset) => asset.kind === "image");
      if (!image) throw new Error("Fixture image missing");
      await Bun.write(join(r.store.root, "artifacts", job.id, image.name), "changed bytes");
      await expect(r.renderPipeline.run(job.id, new AbortController().signal)).rejects.toThrow(
        "변경",
      );
      expect(r.counts.startImage).toBe(0);
      expect(r.counts.veoCreate).toBe(0);
    } finally {
      await r.close();
    }
  }, 60_000);
  test("a saved Veo operation resumes by polling without a second creation request", async () => {
    const r = await renderRuntimeFixture({
      stubRender: true,
      clipReview: false,
      script: (job, hypothesisId, number) =>
        longVideoScript(number, hypothesisId, videoTargetSeconds(job.id, number)),
    });
    const engine = new AutomationEngine(
      r.store,
      automationServices(r.store, { production: r.production, renderPipeline: r.renderPipeline }),
    );
    try {
      r.control.awaitError = new Error("Polling connection interrupted");
      const job = r.fresh();
      engine.start(job.id, {
        mode: "creative",
        imageCount: 1,
        videoCount: 1,
        scriptApproval: "auto",
      });
      await settle(engine);
      const stopped = r.store.get(job.id);
      expect(stopped.automation?.status).toBe("attention");
      expect(stopped.automation?.operation).toBe("clips");
      expect(stopped.renders[0]?.clips.A?.operation?.name).toBe("operations/fixture-1");
      r.control.awaitError = null;
      engine.resume(job.id);
      await settle(engine);
      expect(r.store.get(job.id).automation?.status).toBe("completed");
      expect(r.counts.veoCreate).toBe(1);
      expect(r.counts.veoAwait).toBe(2);
      expect(r.store.get(job.id).renders[0]?.clips.A?.name).toBe("clip-1-A-1.mp4");
    } finally {
      engine.close();
      await r.close();
    }
  }, 60_000);
  test("stops after one correction of a rejected concept", async () => {
    const f = await fixture();
    try {
      const job = new AutomationEnrollment(f.store).start(f.fresh().id, automationPolicy());
      const production = new AutomaticProduction(f.store, {
        ...f.providers,
        review: async () => ({
          value: {
            status: "revise",
            summary: "Pixels require correction",
            issues: ["Unreadable pixels"],
            revisionPrompt: "Replacement concept scene",
          },
          model,
        }),
      });
      await expect(production.run(job.id, new AbortController().signal)).rejects.toThrow(
        "수정 1회",
      );
      expect(f.images()).toBe(2);
      expect(f.store.get(job.id).staged).toBeNull();
    } finally {
      await f.close();
    }
  });
  test("preserves the authorized legacy scope digest when no project was selected", async () => {
    const f = await fixture();
    try {
      const job = f.store.create(automationBrief);
      const { projectId: _projectId, ...legacyBrief } = automationBrief;
      const policy = automationPolicy();
      expect(scopeDigest(job, policy)).toBe(
        contentDigest(
          JSON.stringify({
            brief: legacyBrief,
            selection: null,
            accountId: null,
            models: null,
            policy,
          }),
        ),
      );
    } finally {
      await f.close();
    }
  });
});
