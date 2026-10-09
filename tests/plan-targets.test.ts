import { expect, test } from "bun:test";
import type { evidencePack } from "../server/evidence-pack";
import { validatePlanTargets } from "../server/source-evidence";
import type { CreativePlan } from "../shared/creative-plan";
import { CreateSourceSchema } from "../shared/sources";
import {
  VIDEO_LONG_MIN_SEC,
  VIDEO_MAX_SEC,
  VIDEO_MIN_SEC,
  VIDEO_SHORT_MAX_SEC,
  videoTargetSeconds,
  videoVariantIndex,
} from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";

const FACT = "fact-1";
const pack = {
  facts: [{ id: FACT }],
  voices: [{ id: "voice-1" }],
  references: [{ id: "ref-1" }],
} as unknown as ReturnType<typeof evidencePack>;

function plan(): CreativePlan {
  return structuredClone(sourcePlanResponse(FACT)) as unknown as CreativePlan;
}

function rejects(mutate: (value: CreativePlan) => void, message: string | RegExp) {
  const value = plan();
  mutate(value);
  expect(() => validatePlanTargets(value, pack, 3)).toThrow(message);
}

test("a plan with one target per concept and process-shaped solution paths passes", () => {
  expect(() => validatePlanTargets(plan(), pack, 3)).not.toThrow();
});

test("plans saved before targets existed are accepted unchanged", () => {
  const value = plan();
  delete value.fragments;
  delete value.targets;
  for (const hypothesis of value.hypotheses) {
    delete hypothesis.targetId;
    delete hypothesis.entryPoint;
    delete hypothesis.solutionPath;
  }
  expect(() => validatePlanTargets(value, pack, 3)).not.toThrow();
});

test("the flow is the default for the target's experience, checked only by its own required stages", () => {
  // 실패 경험 타겟을 기준 선점으로 풀어도 거부하지 않지만, 기준 선점에 필요한 기준 단계는 있어야 한다.
  rejects((value) => {
    const first = value.hypotheses[0];
    if (first?.solutionPath) first.solutionPath.flow = "criteria_first";
  }, /과정이 빠졌습니다/);
  const ok = plan();
  const first = ok.hypotheses[0];
  if (first?.solutionPath)
    first.solutionPath = { ...(ok.hypotheses[1]?.solutionPath ?? first.solutionPath) };
  expect(() => validatePlanTargets(ok, pack, 3)).not.toThrow();
});

test("a solution that jumps straight to a result is rejected", () => {
  rejects((value) => {
    const path = value.hypotheses[1]?.solutionPath;
    if (path) path.steps = path.steps.filter((step) => step.stage !== "mechanism");
    const first = path?.steps[0];
    if (path && first) path.steps.push({ ...first, stage: "outcome" });
  }, /과정이 빠졌습니다/);
});

test("how our product solves it must cite product facts", () => {
  rejects((value) => {
    const step = value.hypotheses[1]?.solutionPath?.steps.find(
      (item) => item.stage === "mechanism",
    );
    if (step) Object.assign(step, { basis: "general_knowledge", sourceIds: [] });
  }, /제품 사실\(FACTS\) 인용/);
});

test("steps out of order are rejected", () => {
  rejects((value) => {
    value.hypotheses[1]?.solutionPath?.steps.reverse();
  }, /순서/);
});

test("fragments must cite sources that match their origin", () => {
  rejects((value) => {
    const fragment = value.fragments?.[0];
    if (fragment) Object.assign(fragment, { origin: "customer_review", sourceIds: ["ref-1"] });
  }, /출처/);
  const ok = plan();
  const fragment = ok.fragments?.[0];
  if (fragment) Object.assign(fragment, { origin: "reference_video", sourceIds: ["ref-1"] });
  expect(() => validatePlanTargets(ok, pack, 3)).not.toThrow();
});

test("concepts reuse a target only with a different entry point", () => {
  rejects((value) => {
    for (const hypothesis of value.hypotheses.slice(1)) {
      hypothesis.targetId = "t2";
      hypothesis.entryPoint = "doubt";
    }
  }, /다른 타겟/);
  // 타겟이 광고안보다 적을 때만 같은 타겟을 다른 진입점으로 다시 쓸 수 있다.
  const ok = plan();
  ok.targets = ok.targets?.filter((target) => target.id !== "t3");
  const last = ok.hypotheses[2];
  const second = ok.hypotheses[1];
  if (last) last.targetId = "t2";
  // 타겟을 바꾸면 사슬의 결과도 그 타겟 조각의 욕망을 되받아야 한다.
  if (last?.chain && second?.chain) last.chain.outcome = second.chain.outcome;
  expect(() => validatePlanTargets(ok, pack, 3)).not.toThrow();
});

test("a hypothesis that points to a missing target is rejected", () => {
  rejects((value) => {
    if (value.hypotheses[2]) value.hypotheses[2].targetId = "t9";
  }, /타겟 1개/);
});

test("the first video of a concept is the short version and later ones are long", () => {
  for (let number = 1; number <= 30; number++) {
    const short = videoTargetSeconds(`job-${number}`, number, 0);
    const long = videoTargetSeconds(`job-${number}`, number, 1);
    expect(short).toBeGreaterThanOrEqual(VIDEO_MIN_SEC);
    expect(short).toBeLessThanOrEqual(VIDEO_SHORT_MAX_SEC);
    expect(long).toBeGreaterThanOrEqual(VIDEO_LONG_MIN_SEC);
    expect(long).toBeLessThanOrEqual(VIDEO_MAX_SEC);
  }
  const scripts = [
    { number: 1, hypothesisId: "h1" },
    { number: 2, hypothesisId: "h2" },
    { number: 3, hypothesisId: "h1" },
  ];
  expect(videoVariantIndex(scripts, 1, "h1")).toBe(0);
  expect(videoVariantIndex(scripts, 3, "h1")).toBe(1);
  expect(videoVariantIndex(scripts, 4, "h1")).toBe(2);
  expect(videoVariantIndex(scripts, 4, "h3")).toBe(0);
});

test("only customer reviews can say whose review they are, and old sources stay unchanged", () => {
  const base = { title: "후기 하나", content: "기름 먹기 힘들어서 캡슐로 바꿨어요" };
  expect(
    CreateSourceSchema.parse({ ...base, kind: "review", reviewOf: "competitor" }).reviewOf,
  ).toBe("competitor");
  expect(
    CreateSourceSchema.safeParse({ ...base, kind: "product_fact", reviewOf: "own" }).success,
  ).toBe(false);
  expect(Object.hasOwn(CreateSourceSchema.parse({ ...base, kind: "review" }), "reviewOf")).toBe(
    false,
  );
});

// 설득 사슬(사용자 결정 2026-10-06): 해결이 고통을 실제로 없애는지, 우리 상품이어야만 하는지, 결과가 고객의 말인지.
test("a chain whose solution fits any product is rejected", () => {
  rejects((value) => {
    const chain = value.hypotheses[0]?.chain;
    if (chain) chain.exclusivity = "any_product";
  }, /아무 제품에나 맞는 말/);
});

test("the reason why (⑥) must be a cited product fact", () => {
  rejects((value) => {
    const chain = value.hypotheses[0]?.chain;
    if (chain)
      chain.reasonWhy = { content: "Because it is convenient", basis: "inferred", sourceIds: [] };
  }, /가능한 이유\(⑥\)/);
  rejects((value) => {
    const chain = value.hypotheses[0]?.chain;
    if (chain) chain.productFact = { ...chain.productFact, sourceIds: [] };
  }, /우리 상품의 사실\(⑤\)/);
});

test("the outcome must reuse the customer's own desire or pain words", () => {
  rejects((value) => {
    const chain = value.hypotheses[0]?.chain;
    if (chain)
      chain.outcome = { content: "Wakes up feeling confident", basis: "inferred", sourceIds: [] };
  }, /욕망·고통 낱말을 되받지/);
});

test("targets need a fit score and concepts must use the highest-scoring targets", () => {
  rejects((value) => {
    const target = value.targets?.[0];
    if (target) delete target.fit;
  }, /fit\(painStrength/);
  rejects((value) => {
    // t1 이 가장 낮은 점수가 되면 t1 을 쓰는 광고안은 거부된다(타겟 4개 중 상위 3개만).
    const first = value.targets?.[0];
    if (!first?.fit) return;
    value.targets?.push({
      ...structuredClone(first),
      id: "t4",
      fit: { ...first.fit, productAnswer: 5 },
    });
    first.fit = { ...first.fit, productAnswer: 1 };
  }, /점수가 낮은 타겟/);
});

test("a target whose fragments show a failed attempt must be tried_failed", () => {
  rejects((value) => {
    const fragment = value.fragments?.[1];
    const target = value.targets?.[1];
    if (fragment) fragment.failedAttempt = "Tried a bigger cup";
    if (target) target.experience = "first_time";
  }, /tried_failed/);
});

test("plans without chains keep the old checks only", () => {
  const value = plan();
  for (const hypothesis of value.hypotheses) delete hypothesis.chain;
  for (const target of value.targets ?? []) delete target.fit;
  expect(() => validatePlanTargets(value, pack, 3)).not.toThrow();
});

test("the reason why (⑥) must add a product detail that ⑤ did not say", () => {
  rejects((value) => {
    const chain = value.hypotheses[0]?.chain;
    if (chain) chain.reasonWhy = { ...chain.reasonWhy, content: chain.productFact.content };
  }, /⑤\)을 되풀이/);
});
