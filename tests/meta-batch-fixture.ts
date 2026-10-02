import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Artifacts } from "../server/artifacts";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { contentDigest } from "../server/automation-guard";
import { automationServices } from "../server/automation-services";
import { Intelligence } from "../server/intelligence";
import { MetaClient } from "../server/meta-client";
import { MetaStager } from "../server/meta-stage";
import { saveModelSettings } from "../server/model-settings";
import { JobStore } from "../server/store";
import { CreativeSchema } from "../shared/planning";
import { CreateJobSchema } from "../shared/schema";

export const batchCreative = CreativeSchema.parse({
  concept: "Local batch fixture",
  headline: "Fixture headline",
  primaryText: "Documented facts",
  description: "Fixture product",
  callToAction: "LEARN_MORE",
  imagePrompt: "Local image fixture",
  rationale: "Fixture only",
  checks: [],
});
const record = z.record(z.string(), z.unknown());
type RecordedRequest = {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
};

export function batchHttpFixture() {
  const requests: RecordedRequest[] = [];
  const remote = new Map<string, Record<string, unknown>>();
  const control: {
    failCreative: number;
    drift: "copy" | "image" | null;
    adSpend: Record<string, number>;
    emptyAd: string | null;
  } = {
    failCreative: 0,
    drift: null,
    adSpend: { "3001": 4, "3002": 6, "3003": 10 },
    emptyAd: null,
  };
  let imageCount = 0;
  let creativeCount = 0;
  let adCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? record.parse(await request.json()) : {};
      requests.push({ path, method: request.method, body });
      if (path === "/openai/responses")
        return Response.json({
          model: body["model"],
          status: "completed",
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "Observed local fixture metrics",
                    observations: ["Measured fixture responses"],
                    hypotheses: [],
                    recommendations: [],
                    limitations: ["Local fixture only"],
                  }),
                },
              ],
            },
          ],
        });
      if (path === "/meta/me/adaccounts")
        return Response.json({
          data: [{ id: "act_123", name: "LOCAL BATCH FIXTURE ONLY", currency: "USD" }],
        });
      if (path.endsWith("/insights")) {
        const id = path.split("/")[2] ?? "";
        return Response.json({
          data:
            id === control.emptyAd
              ? []
              : [
                  {
                    spend: String(id === "1001" ? 20 : (control.adSpend[id] ?? 0)),
                    impressions: id === "1001" ? "1000" : "200",
                    clicks: id === "1001" ? "20" : "4",
                    date_start: "2026-09-24",
                    date_stop: "2026-09-24",
                    actions: [],
                    action_values: [],
                  },
                ],
        });
      }
      if (request.method === "POST") {
        if (path.endsWith("/adimages"))
          return Response.json({
            images: { fixture: { hash: `image-hash-${++imageCount}` } },
          });
        if (/\/meta\/\d+$/.test(path)) {
          remote.set(path, { ...remote.get(path), status: body["status"] });
          return Response.json({ success: true });
        }
        let id: string;
        if (path.endsWith("/campaigns")) id = "1001";
        else if (path.endsWith("/adsets")) id = "1002";
        else if (path.endsWith("/adcreatives")) {
          creativeCount++;
          if (creativeCount === control.failCreative)
            return Response.json({ error: "Local creative failure" }, { status: 503 });
          id = String(2000 + creativeCount);
        } else if (path.endsWith("/ads")) id = String(3000 + ++adCount);
        else return Response.json({ error: "Unmapped fixture write" }, { status: 404 });
        remote.set(`/meta/${id}`, body);
        return Response.json({ id });
      }
      const item = remote.get(path);
      if (!item) return Response.json({ error: "Unmapped fixture read" }, { status: 404 });
      if (path === "/meta/1001")
        return Response.json({ ...item, account_id: "123", spend_cap: String(item["spend_cap"]) });
      if (path === "/meta/1002")
        return Response.json({ ...item, daily_budget: String(item["daily_budget"]) });
      if (path === "/meta/2003" && control.drift) {
        const story = record.parse(item["object_story_spec"]);
        const link = record.parse(story["link_data"]);
        return Response.json({
          ...item,
          object_story_spec: {
            ...story,
            link_data: {
              ...link,
              ...(control.drift === "copy"
                ? { message: "Unreviewed copy" }
                : { image_hash: "unreviewed-image" }),
            },
          },
        });
      }
      if (/\/meta\/300[123]$/.test(path)) {
        const creative = z.object({ creative_id: z.string() }).parse(item["creative"]);
        return Response.json({
          ...item,
          creative: { id: creative.creative_id },
          effective_status: item["status"],
        });
      }
      return Response.json(item);
    },
  });
  return { server, requests, control, remote };
}

export async function batchFixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-meta-batch-"));
  const store = new JobStore(root);
  saveModelSettings(root, {
    textProvider: "openai",
    textModel: "fixture-text",
    codexModel: null,
    imageModel: "gpt-image-2.5-sunburst",
    imageQuality: "high",
    ttsProvider: "typecast",
    ttsSelection: "auto",
    ttsVoiceId: null,
    ttsTempo: 1,
  });
  const http = batchHttpFixture();
  const clientFactory = () =>
    new MetaClient("local-fixture-only", `http://127.0.0.1:${http.server.port}/meta/`, 1000);
  const assets = new Artifacts(store);
  const stager = new MetaStager(store, assets, clientFactory);
  const intelligence = new Intelligence(root, {
    apiKey: "local-fixture-only",
    baseUrl: `http://127.0.0.1:${http.server.port}/openai/`,
  });
  const services = automationServices(store, { clientFactory, intelligence });
  const fresh = store.create(
    CreateJobSchema.parse({
      name: "Local three-ad fixture",
      productUrl: "https://example.com",
      productDescription: "Documented facts for a local fixture product.",
      audience: "Adult fixture audience",
      objective: "traffic",
      dailyBudget: 10,
      currency: "USD",
      country: "US",
    }),
  );
  store.change(fresh.id, (draft) => {
    draft.accountId = "act_123";
    draft.selection = { accountId: "act_123", pageId: "456" };
  });
  const policy = {
    mode: "activate",
    maxTotalSpend: 100,
    endAt: new Date(Date.now() + 86400000).toISOString(),
    analysisIntervalMinutes: 15,
  } as const;
  new AutomationEnrollment(store).start(fresh.id, policy);
  for (const index of [1, 2, 3]) {
    const creative = {
      ...batchCreative,
      headline: `Reviewed headline ${index}`,
      primaryText: `Reviewed copy ${index}`,
    };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, index]);
    const asset = await assets.save(fresh.id, {
      name: `variant-${index}.png`,
      kind: "image",
      agentId: "production",
      content: bytes,
    });
    store.change(fresh.id, (draft) => {
      draft.creativeVariants.push({
        id: `hypothesis-${index}`,
        creative,
        imageAttempts: 1,
        approvedImageId: asset.id,
        cardImageIds: [],
        approvedImageDigest: contentDigest(bytes),
        approvedCreativeDigest: contentDigest(JSON.stringify(creative)),
        reviewStatus: "pass",
      });
    });
  }
  const stage = async () => {
    await stager.stage(store.get(fresh.id), batchCreative, new AbortController().signal);
    return store.change(fresh.id, (draft) => {
      draft.status = "review";
    });
  };
  const close = async () => {
    await http.server.stop(true);
    store.close();
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    store,
    assets,
    stager,
    services,
    clientFactory,
    policy,
    job: store.get(fresh.id),
    stage,
    close,
    ...http,
  };
}
