import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AutomationEngine } from "../server/automation";
import { automationServices } from "../server/automation-services";
import { snapshotModels } from "../server/model-settings";
import { TEST_PROVIDER_BLOCKED } from "../server/render-pipeline";
import { VideoScriptService } from "../server/script-service";
import { SCRIPT_MAX_GENERATIONS, writeVideoScript } from "../server/script-writer";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import { pendingScriptApprovals, scriptNeedsApproval } from "../shared/script-approval";
import {
  VideoScriptReviewSchema,
  VideoScriptSchema,
  videoTargetSeconds,
} from "../shared/video-script";
import { httpFixture } from "./automation-http-fixture";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";

// AI 대본 품질 검토 루프: 규칙 검사를 통과한 대본을 검토 스텁이 revise 하면 그 이유를 피드백으로 다시 쓰고(최대 3회 생성),
// 마지막까지 revise 면 받아들이되 사용자 확인 필요(forced)로 기록한다. 유료 공급자는 전부 스텁(호출 수 기록).
// 검토 테스트용 광고안(카드뉴스 유무만 다르다)
function fixtureHypothesis(cardSlides: number) {
  return HypothesisSchema.parse({
    id: "concept-1",
    angle: "problem_solution",
    decisionRole: "need_awareness",
    targetAudience: "a",
    targetReason: "b",
    customerSituation: "c",
    problem: "d",
    message: "e",
    hook: "f",
    difference: "g",
    visualMechanism: "h",
    claimCitations: [{ sourceId: "s", quote: "q" }],
    referenceSourceIds: [],
    cardSlides: Array.from({ length: cardSlides }, (_, step) => ({
      headline: `Card ${step + 1}`,
      body: "b",
      imagePrompt: "p",
    })),
    creative: {
      concept: "c",
      headline: "h",
      primaryText: "p",
      description: "d",
      callToAction: "LEARN_MORE",
      imagePrompt: "i",
      rationale: "r",
      checks: [],
    },
  });
}
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
});
afterEach(async () => {
  engine.close();
  await f.close();
});
const reviewNames = (id: string) =>
  f.store
    .get(id)
    .artifacts.filter((asset) => asset.name.startsWith("video-script-review-"))
    .map((asset) => asset.name);

test("a forced revise causes exactly one regeneration with the review issues as feedback", async () => {
  f.control.scriptReview = "revise-once";
  const job = f.fresh();
  engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  expect(result.automation?.lastError).toBeNull();
  expect(result.automation?.status).toBe("completed");
  // 생성 2회(첫 생성 + 검토 수정 1회), 검토 2회
  expect(f.counts.script).toBe(2);
  expect(f.counts.scriptReview).toBe(2);
  expect(f.scriptFeedback[0]).toBeUndefined();
  expect(f.scriptFeedback[1]).toContain("AI 대본 검토 수정 요청");
  expect(f.scriptFeedback[1]).toContain("1번째 문장");
  expect(f.scriptFeedback[1]).toContain("퇴근하고 소파에 눕자마자");
  // 검토 산출물은 시도마다 하나씩, 저장된 요약은 마지막(통과) 검토
  expect(reviewNames(job.id)).toEqual([
    "video-script-review-1-1.json",
    "video-script-review-1-2.json",
  ]);
  const first = VideoScriptReviewSchema.parse(
    JSON.parse(
      await Bun.file(join(f.root, "artifacts", job.id, "video-script-review-1-1.json")).text(),
    ),
  );
  expect(first.status).toBe("revise");
  expect(result.renders[0]?.scriptReview).toMatchObject({
    attempt: 2,
    status: "pass",
    accepted: "pass",
    issues: [],
  });
  expect(result.artifacts.filter((asset) => asset.name === "video-script-1.json")).toHaveLength(1);
});

test("a picture-speech mismatch from the review is fed back with the sentence and cut indexes", async () => {
  f.control.scriptReview = "mismatch-once";
  const job = f.fresh();
  engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  expect(result.automation?.status).toBe("completed");
  expect(f.counts.script).toBe(2);
  // 피드백에 문장 번호(1부터)·컷 번호(0부터)·문제·고칠 점이 모두 들어간다
  expect(f.scriptFeedback[1]).toContain("2번째 문장(컷[2,3])");
  expect(f.scriptFeedback[1]).toContain("600밀리그램이 묶인 컷 화면에 없습니다");
  expect(f.scriptFeedback[1]).toContain("600mg 클로즈업 컷을 이 문장 범위에 넣거나");
  // 첫 검토 기록에는 컷 번호가 저장된다
  const first = VideoScriptReviewSchema.parse(
    JSON.parse(
      await Bun.file(join(f.root, "artifacts", job.id, "video-script-review-1-1.json")).text(),
    ),
  );
  expect(first.issues[0]).toMatchObject({ sentenceIndex: 1, cutIndexes: [2, 3] });
});

test("after three generations a still-revised script is flagged and waits for the user even in auto mode", async () => {
  f.control.scriptReview = "revise";
  const job = f.fresh();
  engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  expect(SCRIPT_MAX_GENERATIONS).toBe(3);
  expect(f.counts.script).toBe(3);
  expect(f.counts.scriptReview).toBe(3);
  expect(reviewNames(job.id)).toHaveLength(3);
  expect(result.renders[0]?.scriptReview).toMatchObject({
    attempt: 3,
    status: "revise",
    accepted: "forced",
  });
  expect(result.renders[0]?.scriptReview?.issues[0]?.sentenceIndex).toBe(0);
  expect(result.events.some((event) => event.message.includes("사용자 확인이 필요"))).toBe(true);
  // 자동 진행 정책이라도 AI 검토를 통과하지 못한 대본은 사람이 승인하기 전에는 유료 제작(내레이션 합성)을 시작하지 않는다
  expect(result.automation?.status).toBe("waiting");
  expect(result.automation?.phase).toBe("script");
  expect(result.automation?.lastError).toBeNull();
  expect(f.counts.voice).toBe(0);
  expect(scriptNeedsApproval(result, 1)).toBe(true);
  expect(pendingScriptApprovals(result)).toEqual([1]);
  // 승인하면 재시작 없이 내레이션 합성부터 이어간다
  new VideoScriptService(f.store, f.providers).approve(job.id, 1);
  expect(engine.wakeScripts(job.id)).toBe(true);
  await settle(engine);
  expect(f.store.get(job.id).automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
  // 생성은 더 늘지 않는다
  expect(f.counts.script).toBe(3);
});

test("a review feedback round and a rule violation round share the three-generation budget", async () => {
  f.control.scriptReview = "revise";
  let calls = 0;
  const job = f.fresh();
  const providers = {
    ...f.providers,
    videoScript: async (current: Parameters<NonNullable<typeof f.providers.videoScript>>[0]) => {
      calls++;
      const script = renderScript(1, "concept-1", videoTargetSeconds(current.id, 1));
      // 첫 생성은 규칙 위반(영문 나레이션), 그 뒤는 규칙 통과(검토는 계속 revise)
      return {
        value:
          calls === 1
            ? {
                ...script,
                voiceover: script.voiceover.map((voice, index) =>
                  index === 0 ? { ...voice, text: "Chong Kun Dang 확인" } : voice,
                ),
              }
            : script,
        model: {
          provider: "openai" as const,
          requestedModel: "x",
          effectiveModel: null,
          quality: null,
        },
      };
    },
  };
  const hypothesis = fixtureHypothesis(2);
  const result = await writeVideoScript({
    store: f.store,
    providers,
    id: job.id,
    number: 1,
    hypothesis,
    durationSec: videoTargetSeconds(job.id, 1),
    signal: new AbortController().signal,
  });
  expect(calls).toBe(3);
  // 규칙 위반은 검토를 부르지 않는다: 검토는 2·3번째 생성에만
  expect(f.counts.scriptReview).toBe(2);
  expect(result.review.accepted).toBe("forced");
  expect(result.script.voiceover[0]?.text).not.toContain("Chong");
});

test("the test runtime refuses to call a real script reviewer that was not injected", async () => {
  const job = f.fresh();
  const { reviewVideoScript: _omit, ...withoutReviewer } = f.providers;
  await expect(
    writeVideoScript({
      store: f.store,
      providers: withoutReviewer,
      id: job.id,
      number: 1,
      hypothesis: fixtureHypothesis(0),
      durationSec: 36,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: TEST_PROVIDER_BLOCKED });
  expect(f.counts.script).toBe(0);
});

test("the real reviewer sends a video_script_review json_schema request and parses the fixture reply", async () => {
  const http = httpFixture();
  try {
    const connection = {
      apiKey: "local-fixture-only",
      baseUrl: `http://127.0.0.1:${http.server.port}/openai/`,
    };
    const job = f.store.change(f.fresh().id, (draft) => {
      draft.executionModels = snapshotModels(f.root);
    });
    const script = {
      ...renderScript(1, "concept-1", 36),
      voicePersona: "storytelling" as const,
      fixedTitle: ["자료로 살펴보는", "제품 비교"],
      disclaimer: "연출된 상황입니다.",
    };
    const hypothesis = fixtureHypothesis(0);
    http.control.scriptReviseOnce = true;
    const signal = new AbortController().signal;
    const first = await reviewVideoScript({ job, script, hypothesis, signal }, connection);
    expect(first.value.status).toBe("revise");
    expect(first.value.issues[0]).toMatchObject({ sentenceIndex: 0, cutIndexes: [] });
    const second = await reviewVideoScript({ job, script, hypothesis, signal }, connection);
    expect(second.value).toEqual({ status: "pass", summary: "픽스처 대본 검토 통과", issues: [] });
    // 픽스처가 '말과 그림 불일치' 한 번을 강제하면 문장·컷 번호가 붙은 revise 가 온다
    http.control.scriptMismatchOnce = true;
    const mismatch = await reviewVideoScript({ job, script, hypothesis, signal }, connection);
    expect(mismatch.value.status).toBe("revise");
    expect(mismatch.value.issues[0]).toMatchObject({ sentenceIndex: 1, cutIndexes: [2, 3] });
    expect(mismatch.value.issues[0]?.problem).toContain("600밀리그램");
    const requests = http.requests.filter((item) => item.path === "/openai/responses");
    expect(requests).toHaveLength(3);
    const body = requests[0]?.body as {
      text: { format: { name: string; strict: boolean } };
      input: string;
    };
    expect(body.text.format.name).toBe("video_script_review");
    expect(body.text.format.strict).toBe(true);
    // 검토 프롬프트에는 문장↔컷 짝 표(문장·그 컷의 구도·자막·글줄)·가설 신호·사실이 들어가고 키는 들어가지 않는다
    const marker = "\nDATA:\n";
    const dataStart = body.input.indexOf(marker);
    expect(dataStart).toBeGreaterThanOrEqual(0);
    const reviewData: unknown = JSON.parse(body.input.slice(dataStart + marker.length));
    expect(reviewData).toMatchObject({
      voicePersona: "storytelling",
      fixedTitle: ["자료로 살펴보는", "제품 비교"],
      disclaimer: "연출된 상황입니다.",
      durationSec: 36,
      pairs: expect.arrayContaining([
        expect.objectContaining({
          sentenceIndex: 0,
          purpose: "hook",
          text: script.voiceover[0]?.text,
          cuts: expect.arrayContaining([
            expect.objectContaining({ cutIndex: 0, onScreenText: "이런 분 주목" }),
          ]),
        }),
        expect.objectContaining({
          cuts: expect.arrayContaining([
            expect.objectContaining({ cutIndex: 3, startSec: 5, endSec: 6, purpose: "pain" }),
          ]),
        }),
      ]),
    });
    expect(body.input).not.toContain("local-fixture-only");
  } finally {
    await http.server.stop(true);
  }
});

// --- needsFix 초안(2026-10-04): 3회 생성 뒤에도 hard 규칙이 남으면 attention 이 아니라 승인 대기로 들어간다 ---------------------
test("three generations with a hard problem save the best draft as needsFix and wait for the user instead of stopping", async () => {
  f.control.scriptRules = "latin-always";
  const job = f.fresh();
  engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  // 생성 3회·검토 0회, attention 이 아니라 waiting(phase script)
  expect(f.counts.script).toBe(3);
  expect(f.counts.scriptReview).toBe(0);
  expect(reviewNames(job.id)).toEqual([]);
  expect(result.automation?.status).toBe("waiting");
  expect(result.automation?.phase).toBe("script");
  expect(result.automation?.lastError).toBeNull();
  expect(result.automation?.nextRunAt).toBeNull();
  expect(result.status).toBe("review");
  expect(result.videoScripts).toHaveLength(1);
  expect(result.renders[0]?.scriptReview).toMatchObject({
    attempt: 0,
    status: "revise",
    accepted: "needsFix",
    generations: 3,
    issues: [],
  });
  expect(result.renders[0]?.scriptReview?.summary).toContain("고치거나 다시 쓰기");
  expect(result.renders[0]?.scriptReview?.hardProblems.length).toBeGreaterThan(0);
  expect(result.renders[0]?.scriptReview?.hardProblems[0]).toContain("영문이 있습니다");
  expect(pendingScriptApprovals(result)).toEqual([1]);
  expect(scriptNeedsApproval(result, 1)).toBe(true);
  expect(f.counts.voice).toBe(0);
  expect(result.events.some((event) => event.message.includes("고치거나 다시 써야"))).toBe(true);
  // 두 번째·세 번째 생성은 hard 피드백을 받았다
  expect(f.scriptFeedback[1]).toContain("영상 대본 규칙 위반");
  expect(f.scriptFeedback[1]).toContain("영문이 있습니다");
  expect(f.scriptFeedback[2]).toContain("영문이 있습니다");
});

test("the draft with the fewest hard problems is kept (second generation beats the first and third)", async () => {
  f.control.scriptRules = "latin-fewest-second";
  const job = f.fresh();
  engine.start(job.id, { mode: "creative", imageCount: 1, videoCount: 1, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  expect(f.counts.script).toBe(3);
  const script = result.videoScripts[0];
  expect(script?.voiceover[0]?.text).toBe("Hello 들어 있어요");
  expect(script?.voiceover[1]?.text).not.toBe("World 보여 드려요");
  expect(result.renders[0]?.scriptReview?.hardProblems).toHaveLength(1);
  expect(result.automation?.status).toBe("waiting");
});

test("a draft that cannot be stored (70+ cuts) is not a candidate and the writer still fails after three generations", async () => {
  const job = f.fresh();
  let generations = 0;
  const providers = {
    ...f.providers,
    videoScript: async () => {
      generations++;
      const script = renderScript(1, "concept-1", 36);
      return {
        value: { ...script, cuts: [...script.cuts, ...script.cuts, ...script.cuts] },
        model: {
          provider: "openai" as const,
          requestedModel: "x",
          effectiveModel: null,
          quality: null,
        },
      };
    },
  };
  await expect(
    writeVideoScript({
      store: f.store,
      providers,
      id: job.id,
      number: 1,
      hypothesis: fixtureHypothesis(2),
      durationSec: 36,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("저장 가능한 형태로 작성하지 못했습니다");
  expect(generations).toBe(3);
  expect(f.counts.scriptReview).toBe(0);
});

test("soft warnings are accepted into a pass review and stored with the repairs; the feedback lists hard before soft", async () => {
  let calls = 0;
  const feedbacks: (string | undefined)[] = [];
  const job = f.fresh();
  const providers = {
    ...f.providers,
    videoScript: async (
      current: Parameters<NonNullable<typeof f.providers.videoScript>>[0],
      _hypothesis: unknown,
      _number: number,
      _signal: AbortSignal,
      feedback?: string,
    ) => {
      calls++;
      feedbacks.push(feedback);
      const script = renderScript(1, "concept-1", videoTargetSeconds(current.id, 1));
      // 첫 생성: hard(영문) + soft(17자 자막); 두 번째: soft 만
      const soft = {
        ...script,
        cuts: script.cuts.map((cut, index) =>
          index === 0 ? { ...cut, onScreenText: "열일곱글자가넘는아주긴자막한줄입니다" } : cut,
        ),
      };
      return {
        value:
          calls === 1
            ? {
                ...soft,
                voiceover: soft.voiceover.map((voice, index) =>
                  index === 0 ? { ...voice, text: "Hello 들어 있어요" } : voice,
                ),
              }
            : soft,
        model: {
          provider: "openai" as const,
          requestedModel: "x",
          effectiveModel: null,
          quality: null,
        },
        repairs: ["픽스처 수리 1건"],
      };
    },
  };
  const result = await writeVideoScript({
    store: f.store,
    providers,
    id: job.id,
    number: 1,
    hypothesis: fixtureHypothesis(2),
    durationSec: videoTargetSeconds(job.id, 1),
    signal: new AbortController().signal,
  });
  expect(calls).toBe(2);
  expect(f.counts.scriptReview).toBe(1);
  expect(result.review).toMatchObject({ accepted: "pass", generations: 2, hardProblems: [] });
  expect(result.review.repairs).toEqual(["픽스처 수리 1건"]);
  expect(result.review.warnings.some((item) => item.includes("자막은 1줄, 한 줄 12자"))).toBe(true);
  // 두 번째 생성의 피드백: hard(영문)가 soft(자막)보다 앞
  const feedback = feedbacks[1] ?? "";
  expect(feedback).toContain("영문이 있습니다");
  expect(feedback).toContain("자막은 1줄, 한 줄 12자");
  expect(feedback.indexOf("영문이 있습니다")).toBeLessThan(
    feedback.indexOf("자막은 1줄, 한 줄 12자"),
  );
});

test("the real writer sends a nested video_script json_schema request, omits number/hypothesisId from DATA and repairs the fixture reply", async () => {
  const http = httpFixture();
  try {
    const connection = {
      apiKey: "local-fixture-only",
      baseUrl: `http://127.0.0.1:${http.server.port}/openai/`,
    };
    const job = f.store.change(f.fresh().id, (draft) => {
      draft.executionModels = snapshotModels(f.root);
    });
    const hypothesis = fixtureHypothesis(2);
    const written = await generateVideoScript(
      job,
      hypothesis,
      1,
      new AbortController().signal,
      undefined,
      connection,
    );
    expect(VideoScriptSchema.safeParse(written.value).success).toBe(true);
    expect(written.value.number).toBe(1);
    expect(written.value.hypothesisId).toBe(hypothesis.id);
    expect(written.value.durationSec).toBe(36);
    // 픽스처가 정지 이미지 컷에 붙인 글줄은 변환 중 수리된다
    expect(written.repairs).toContainEqual(expect.stringContaining("graphicLines 1줄 삭제"));
    expect(
      written.value.cuts.every(
        (cut) => cut.source === "motion_graphic" || cut.graphicLines.length === 0,
      ),
    ).toBe(true);
    const request = http.requests.find((item) => item.path === "/openai/responses");
    const body = request?.body as {
      max_output_tokens: number;
      text: {
        format: {
          name: string;
          strict: boolean;
          schema: {
            properties: {
              sentences: {
                items: { properties: { cuts: { items: { properties: Record<string, unknown> } } } };
              };
            };
          };
        };
      };
      input: string;
    };
    expect(body.text.format.name).toBe("video_script");
    expect(body.text.format.strict).toBe(true);
    expect(body.max_output_tokens).toBe(12000);
    expect(
      Object.keys(
        body.text.format.schema.properties.sentences.items.properties.cuts.items.properties,
      ),
    ).toContain("len");
    const data = body.input.slice(body.input.indexOf("\nDATA:\n"));
    expect(data).toContain('"durationTarget":' + String(videoTargetSeconds(job.id, 1)));
    expect(data).not.toContain('"number":');
    expect(data).not.toContain('"hypothesisId"');
    expect(
      body.text.format.schema.properties.sentences.items.properties.cuts.items.properties["len"],
    ).toMatchObject({ type: "number", minimum: 0.5, maximum: 60 });
    expect(body.input).not.toContain("local-fixture-only");
  } finally {
    await http.server.stop(true);
  }
});
