import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifacts } from "../server/artifacts";
import { JobStore } from "../server/store";
import { CreateJobSchema } from "../shared/schema";

export const brief = {
  name: "경계 테스트",
  productUrl: "https://example.com/product",
  productDescription: "실제 상품에 대해 사용자가 제공한 확인 가능한 정보입니다.",
  audience: "대한민국 성인 고객",
  objective: "traffic",
  dailyBudget: 10000,
  currency: "KRW",
  country: "KR",
} as const;
const roots: string[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(): Promise<JobStore> {
  const root = await mkdtemp(join(tmpdir(), "studio-test-"));
  roots.push(root);
  const store = new JobStore(root);
  stores.push(store);
  return store;
}
describe("input and persistence boundaries", () => {
  test("rejects unknown fields, negative budgets, and unsafe URL schemes", () => {
    expect(CreateJobSchema.safeParse({ ...brief, dailyBudget: -1 }).success).toBe(false);
    expect(CreateJobSchema.safeParse({ ...brief, productUrl: "file:///secret" }).success).toBe(
      false,
    );
    expect(CreateJobSchema.safeParse({ ...brief, status: "completed" }).success).toBe(false);
    expect(CreateJobSchema.parse({ ...brief, dailyBudget: null }).dailyBudget).toBeNull();
  });
  test("project jobs let the planner derive product analysis and ad-specific audiences", () => {
    const automatic = {
      ...brief,
      projectId: crypto.randomUUID(),
      productDescription: "",
      audience: "",
    };
    expect(CreateJobSchema.safeParse(automatic).success).toBe(true);
    expect(CreateJobSchema.safeParse({ ...automatic, projectId: null }).success).toBe(false);
  });
  test("persists a real brief and recovers interrupted jobs as blocked", async () => {
    const store = await setup();
    const job = store.create(CreateJobSchema.parse(brief));
    store.change(job.id, (draft) => {
      draft.status = "running";
    });
    const second = new JobStore(store.root);
    stores.push(second);
    expect(second.get(job.id).status).toBe("blocked");
    expect(second.get(job.id).productDescription).toBe(brief.productDescription);
  });
  test("only serves registered contained artifact paths", async () => {
    const store = await setup();
    const job = store.create(CreateJobSchema.parse(brief));
    const assets = new Artifacts(store);
    expect(() => assets.path(job.id, "../studio.sqlite")).toThrow();
    expect(() => assets.path(job.id, "C:\\secret.txt")).toThrow();
    await assets.save(job.id, {
      name: "strategy.json",
      kind: "json",
      agentId: "strategy",
      content: '{"fact":true}',
    });
    expect(await (await assets.read(job.id, "strategy.json")).text()).toBe('{"fact":true}');
    await expect(assets.read(job.id, "missing.txt")).rejects.toThrow();
  });
});
