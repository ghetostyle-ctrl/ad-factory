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
import { VideoProduction } from "../server/video-production";
import { CreativePlanSchema } from "../shared/creative-plan";
import type { Job } from "../shared/schema";
import { CreateProjectSchema, CreateSourceSchema } from "../shared/sources";
import { automationBrief, automationPolicy, automationRequest } from "./automation-fixture";
import { fixtureCreative, fixturePng, fixtureStrategy } from "./automation-http-fixture";

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
    videoScript: async (_job, hypothesis, number) => {
      expect(images).toBe(0);
      scripts++;
      return {
        value: {
          number,
          hypothesisId: hypothesis.id,
          title: `영상 ${number} 대본`,
          durationSec: 8,
          cuts: [
            {
              startSec: 0,
              endSec: 2,
              purpose: "hook",
              screenComposition: "첫 장면",
              onScreenText: "후킹",
              narration: "첫 문장",
              source: "approved_image",
            },
            {
              startSec: 2,
              endSec: 5,
              purpose: "solution",
              screenComposition: "사용 장면",
              onScreenText: "해결",
              narration: "둘째 문장",
              source: "veo_clip",
            },
            {
              startSec: 5,
              endSec: 8,
              purpose: "cta",
              screenComposition: "마무리",
              onScreenText: "확인하기",
              narration: "마지막 문장",
              source: "veo_clip",
            },
          ],
          flowPrompt: `Flow shot ${number}`,
          editInstructions: "컷별 자막과 내레이션을 맞춘다.",
        },
        model,
      };
    },
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
    const f = await fixture();
    const production = new AutomaticProduction(f.store, f.providers);
    let videos = 0;
    const videoProduction = new VideoProduction(f.store, async (task) => {
      videos++;
      expect(task.model).toBe("veo-3.1-lite-generate-preview");
      expect(task.prompt).toContain(`Flow shot ${videos}`);
      return {
        value: new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112]),
        model: { ...model, provider: "gemini" },
      };
    });
    const engine = new AutomationEngine(
      f.store,
      automationServices(f.store, { production, videoProduction }),
    );
    try {
      const job = f.fresh();
      engine.start(job.id, { mode: "creative", imageCount: 10, videoCount: 10 });
      await engine.tick();
      await Promise.all([...engine.active.values()].map((task) => task.promise));
      const result = f.store.get(job.id);
      expect(result.automation?.status).toBe("completed");
      expect(result.creativeVariants).toHaveLength(10);
      expect(f.images()).toBe(10);
      expect(f.scripts()).toBe(10);
      expect(result.videoScripts).toHaveLength(10);
      expect(
        result.artifacts.filter((asset) => asset.name.startsWith("video-script-")),
      ).toHaveLength(10);
      expect(videos).toBe(10);
      expect(result.artifacts.filter((asset) => asset.kind === "video")).toHaveLength(10);
      expect(result.staged).toBeNull();
    } finally {
      engine.close();
      await f.close();
    }
  });
  test("Veo does not receive an approved image whose file bytes changed", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const job = new AutomationEnrollment(f.store).start(f.fresh().id, {
        mode: "creative",
        imageCount: 1,
        videoCount: 1,
      });
      await new AutomaticProduction(f.store, f.providers).run(job.id, new AbortController().signal);
      const image = f.store.get(job.id).artifacts.find((asset) => asset.kind === "image");
      if (!image) throw new Error("Fixture image missing");
      await Bun.write(join(f.store.root, "artifacts", job.id, image.name), "changed bytes");
      const videos = new VideoProduction(f.store, async () => {
        calls++;
        throw new Error("Veo should not run");
      });
      await expect(videos.run(job.id, new AbortController().signal)).rejects.toThrow("변경");
      expect(calls).toBe(0);
    } finally {
      await f.close();
    }
  });
  test("a saved Veo operation resumes by polling without a second creation request", async () => {
    const f = await fixture();
    let starts = 0;
    let polls = 0;
    const videoProduction = new VideoProduction(f.store, async (task) => {
      if (!task.operationName) {
        starts++;
        task.onOperationName?.("operations/saved-fixture");
        throw new Error("Polling connection interrupted");
      }
      polls++;
      expect(task.operationName).toBe("operations/saved-fixture");
      return {
        value: new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112]),
        model: { ...model, provider: "gemini" },
      };
    });
    const engine = new AutomationEngine(
      f.store,
      automationServices(f.store, {
        production: new AutomaticProduction(f.store, f.providers),
        videoProduction,
      }),
    );
    try {
      const job = f.fresh();
      engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1 });
      await engine.tick();
      await Promise.all([...engine.active.values()].map((task) => task.promise));
      expect(f.store.get(job.id).automation?.status).toBe("attention");
      expect(f.store.get(job.id).automation?.videoOperation?.name).toBe("operations/saved-fixture");
      engine.resume(job.id);
      await engine.tick();
      await Promise.all([...engine.active.values()].map((task) => task.promise));
      expect(f.store.get(job.id).automation?.status).toBe("completed");
      expect(starts).toBe(1);
      expect(polls).toBe(1);
    } finally {
      engine.close();
      await f.close();
    }
  });
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
