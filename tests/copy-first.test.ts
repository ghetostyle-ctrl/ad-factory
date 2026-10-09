import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { formatScriptView } from "../scripts/script-cli";
import { AutomationEnrollment } from "../server/automation-enrollment";
import type { ProductionProviders } from "../server/automation-production";
import {
  acceptExternalCopy,
  COPY_MAX_GENERATIONS,
  copyArtifactName,
  generateVideoCopy,
  pinToCopy,
  writeVideoCopy,
} from "../server/copy-writer";
import { renderStateOf } from "../server/render-state-helpers";
import { ScriptRewriteSchema, VideoScriptService } from "../server/script-service";
import { writeVideoScript } from "../server/script-writer";
import { prepareVideoPlanning } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import type { CopyLine } from "../shared/video-script";
import {
  FIXTURE_COPY,
  FIXTURE_COPY_OVERLONG,
  planningHttpFixture,
} from "./video-planning-http-fixture";
import { planningModel, planningPipelineFixture } from "./video-planning-pipeline-fixture";

// 카피 먼저 흐름(2026-10-08): 혼합형 정책의 새 대본은 편지 1(카피) → 편지 2(장면) 순서로 쓴다. 유료 호출 없이 로컬 HTTP 픽스처로 확인한다.
const fixtures: ReturnType<typeof planningHttpFixture>[] = [];
function setup() {
  const fixture = planningHttpFixture();
  fixtures.push(fixture);
  // 설명 장면(I1~I3)은 Flow 모드에서만 허용되므로 새 작업 기본값대로 Flow 로 승인한다.
  new AutomationEnrollment(fixture.store).start(fixture.job.id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
    clipMode: "flow",
  });
  return fixture;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
type Providers = Pick<
  ProductionProviders,
  "videoPlanning" | "videoScript" | "reviewVideoScript" | "videoCopy"
>;
// 실제 기획·카피·대본·검토 함수를 그대로 쓰되 연결만 로컬 HTTP 픽스처로 돌린다.
function providersFor(
  fixture: ReturnType<typeof planningHttpFixture>,
  options: { readonly copy?: boolean } = {},
): Providers {
  return {
    videoPlanning: (task) => prepareVideoPlanning(task, fixture.connection),
    ...(options.copy === false
      ? {}
      : { videoCopy: (task) => generateVideoCopy(task, fixture.connection) }),
    videoScript: (job, hypothesis, number, signal, feedback, _connection, planning, scene) =>
      generateVideoScript(
        job,
        hypothesis,
        number,
        signal,
        feedback,
        fixture.connection,
        planning,
        scene,
      ),
    reviewVideoScript: (task) => reviewVideoScript(task, fixture.connection),
  };
}
function write(
  fixture: ReturnType<typeof planningHttpFixture>,
  providers: Providers,
  extra: { readonly externalCopy?: readonly CopyLine[]; readonly userFeedback?: string } = {},
) {
  return writeVideoScript({
    store: fixture.store,
    id: fixture.job.id,
    number: 1,
    hypothesis: fixture.hypothesis,
    durationSec: 36,
    signal: fixture.task.signal,
    providers,
    ...extra,
  });
}
const count = (fixture: ReturnType<typeof planningHttpFixture>, name: string) =>
  fixture.requests.filter((request) => request.name === name).length;
const names = (fixture: ReturnType<typeof planningHttpFixture>) =>
  fixture.requests.map((request) => request.name);

test("letter 1 writes the copy, letter 2 receives it as fixed input, and the model's changed sentences are restored", async () => {
  // Given
  const fixture = setup();
  // When
  const result = await write(fixture, providersFor(fixture));
  // Then: 기획 → 카피 교정 → 카피(편지 1) → 장면(편지 2) → 검토. 유료 호출은 카피 1 + 장면 1 + 검토 1.
  expect(names(fixture)).toEqual([
    "video_planning",
    "video_copy_editing",
    "video_copy",
    "video_script",
    "video_script_review",
  ]);
  // 저장 대본의 음성 글·사슬 단계가 카피와 같고 흐름 표시가 붙는다.
  expect(result.script.flow).toBe("copy_first");
  expect(result.script.voiceover.map((line) => line.text)).toEqual(
    FIXTURE_COPY.lines.map((line) => line.text),
  );
  expect(result.script.voiceover.map((line) => line.chainStep)).toEqual(
    FIXTURE_COPY.lines.map((line) => line.chainStep),
  );
  // 모델이 8문장을 모두 바꿔 돌려줬으므로 8건 모두 되돌렸고, 카피 회차가 repairs 맨 앞에 있다.
  expect(result.review.repairs[0]).toContain("카피 먼저: 카피 1회 작성");
  for (let index = 1; index <= FIXTURE_COPY.lines.length; index++)
    expect(result.review.repairs).toContain(`${index}번째 문장을 카피 원문으로 되돌림`);
  // 바뀐 글에 없는 어절의 콜아웃은 뺀다("아침마다"는 카피 1번째 문장에 없고 "가볍게"는 7번째에 있다).
  expect(result.review.repairs.some((item) => item.includes("콜아웃 '아침 고민' 제거"))).toBe(true);
  expect(result.script.voiceover[6]?.callouts.map((callout) => callout.word)).toEqual(["가볍게"]);
  expect(result.script.voiceover[0]?.callouts).toEqual([]);
  // 카피는 목표(기획 54초)보다 짧아 경고로 남고 막지 않는다. 규칙·검토는 통과한다.
  expect(result.review.warnings.some((item) => item.startsWith("카피: "))).toBe(true);
  expect(result.review.accepted).toBe("pass");
  expect(result.review.hardProblems).toEqual([]);
  expect(result.review.instructionsDigest.length).toBeGreaterThan(0);
  // 편지 1 의 프롬프트는 카피 지시 + 예시 + 사실·후기 DATA, 편지 2 의 DATA 는 확정 문장(copyLines)을 싣고 기획의 카피 초안은 뺀다.
  const copyRequest = fixture.requests.find((request) => request.name === "video_copy");
  expect(copyRequest?.strict).toBe(true);
  expect(copyRequest?.prompt).toContain("You are a Korean ad copywriter");
  expect(copyRequest?.prompt).toContain("EXAMPLE (shape only");
  expect(Object.keys(copyRequest?.data ?? {})).toEqual(
    expect.arrayContaining(["facts", "voices", "hypothesis", "durationSec", "planning"]),
  );
  expect(JSON.stringify(copyRequest?.data["planning"])).not.toContain("scenePlan");
  const sceneRequest = fixture.requests.find((request) => request.name === "video_script");
  expect(sceneRequest?.prompt).toContain("the sentences are FIXED (DATA.copyLines");
  expect(sceneRequest?.data["copyLines"]).toEqual(FIXTURE_COPY.lines);
  expect(sceneRequest?.data["infoClipsAllowed"]).toBe(true);
  expect(sceneRequest?.data["planning"]).toMatchObject({ visualPolicy: "hybrid_explainer_v1" });
  expect(JSON.stringify(sceneRequest?.data["planning"])).not.toContain("가방을 닫기 전에");
  // 산출물 video-copy-1-1.json 에 카피와 판정이 남는다.
  const artifacts = fixture.store.get(fixture.job.id).artifacts.map((item) => item.name);
  expect(artifacts).toContain("video-copy-1-1.json");
  const saved = await Bun.file(
    join(fixture.store.root, "artifacts", fixture.job.id, "video-copy-1-1.json"),
  ).json();
  expect(saved).toMatchObject({ external: false, hard: [], lines: FIXTURE_COPY.lines });
  expect(saved.estimatedSec).toBeGreaterThanOrEqual(30);
  expect(saved.estimatedSec).toBeLessThanOrEqual(60);
});

test("a copy that reads over 60 seconds is rewritten by letter 1 only, with the estimated seconds in the feedback", async () => {
  // Given: 첫 카피 요청 한 번은 너무 긴 카피(추정 60초 초과)를 돌려준다.
  const fixture = setup();
  fixture.control.copyOverlongOnce = true;
  // When
  const result = await write(fixture, providersFor(fixture));
  // Then: 유료 호출 = 카피 2 + 장면 1 + 검토 1(기획 2는 별도).
  expect(count(fixture, "video_copy")).toBe(2);
  expect(count(fixture, "video_script")).toBe(1);
  expect(count(fixture, "video_script_review")).toBe(1);
  const [first, second] = fixture.requests.filter((request) => request.name === "video_copy");
  expect(first?.prompt).not.toContain("REWRITE THE SENTENCES");
  expect(second?.prompt).toContain("REWRITE THE SENTENCES AND FIX THESE ISSUES");
  expect(second?.prompt).toContain("추정 발화 시간은 약");
  // 두 번째(통과) 카피가 장면에 들어가고 산출물은 회차별로 남는다.
  expect(result.review.repairs[0]).toContain("카피 먼저: 카피 2회 작성");
  expect(result.script.voiceover.map((line) => line.text)).toEqual(
    FIXTURE_COPY.lines.map((line) => line.text),
  );
  const artifacts = fixture.store.get(fixture.job.id).artifacts.map((item) => item.name);
  expect(artifacts).toContain("video-copy-1-1.json");
  expect(artifacts).toContain("video-copy-1-2.json");
  const firstSaved = await Bun.file(
    join(fixture.store.root, "artifacts", fixture.job.id, "video-copy-1-1.json"),
  ).json();
  expect(firstSaved.hard.length).toBeGreaterThan(0);
  expect(firstSaved.estimatedSec).toBeGreaterThan(60);
  expect(result.review.hardProblems).toEqual([]);
  expect(result.review.accepted).toBe("pass");
});

test("an external copy skips letter 1 entirely and still fixes the sentences in letter 2", async () => {
  // Given
  const fixture = setup();
  // When
  const result = await write(fixture, providersFor(fixture), {
    externalCopy: FIXTURE_COPY.lines,
  });
  // Then: video_copy 요청 0건.
  expect(count(fixture, "video_copy")).toBe(0);
  expect(names(fixture)).toEqual([
    "video_planning",
    "video_copy_editing",
    "video_script",
    "video_script_review",
  ]);
  expect(result.script.flow).toBe("copy_first");
  expect(result.script.voiceover.map((line) => line.text)).toEqual(
    FIXTURE_COPY.lines.map((line) => line.text),
  );
  expect(result.review.repairs[0]).toContain("카피 먼저: 외부 카피 입력");
  expect(result.review.accepted).toBe("pass");
  // 외부 카피도 산출물로 남는다(external: true).
  const saved = await Bun.file(
    join(fixture.store.root, "artifacts", fixture.job.id, "video-copy-1-1.json"),
  ).json();
  expect(saved.external).toBe(true);
});

test("other policies and script-only providers keep the one-shot flow with no copy request", async () => {
  // Given: (1) immersive 기획 — 카피 공급자가 주입돼 있어도 쓰지 않는다. (2) 혼합형이지만 대본 공급자만 주입(예전 한 응답 스텁 방식).
  const immersive = setup();
  const planned = await prepareVideoPlanning(immersive.task, immersive.connection);
  const immersivePlanning = {
    ...planned.value,
    visualPolicy: "immersive_explanations_v1" as const,
  };
  immersive.requests.length = 0;
  // When
  const a = await write(immersive, {
    ...providersFor(immersive),
    videoPlanning: async () => ({ value: immersivePlanning, model: planningModel }),
  });
  const hybrid = setup();
  const b = await write(hybrid, providersFor(hybrid, { copy: false }));
  // Then
  expect(count(immersive, "video_copy")).toBe(0);
  expect(a.script.flow).toBe("");
  expect(a.script.planning?.visualPolicy).toBe("immersive_explanations_v1");
  expect(count(hybrid, "video_copy")).toBe(0);
  expect(b.script.flow).toBe("");
  expect(b.script.planning?.visualPolicy).toBe("hybrid_explainer_v1");
  expect(
    hybrid.requests.find((request) => request.name === "video_script")?.data["copyLines"],
  ).toBeUndefined();
});

test("a scene response with the wrong sentence count is rejected and only letter 2 is retried", async () => {
  // Given: 첫 장면 응답이 마지막 문장을 빼고 돌아온다(7문장 ≠ 카피 8문장).
  const fixture = setup();
  fixture.control.sceneDropLastOnce = true;
  // When
  const result = await write(fixture, providersFor(fixture));
  // Then: 카피 1 + 장면 2 + 검토 1. 카피는 다시 쓰지 않는다.
  expect(count(fixture, "video_copy")).toBe(1);
  expect(count(fixture, "video_script")).toBe(2);
  expect(count(fixture, "video_script_review")).toBe(1);
  const retry = fixture.requests.filter((request) => request.name === "video_script")[1];
  expect(retry?.prompt).toContain("장면 응답의 문장이 7개인데 카피는 8개입니다");
  expect(result.script.voiceover).toHaveLength(FIXTURE_COPY.lines.length);
  expect(result.review.accepted).toBe("pass");
});

test("a copy that still breaks the rules after three tries is recorded in the review and needs a fix", async () => {
  // Given: 카피 응답이 계속 60초를 넘는다.
  const fixture = setup();
  fixture.replies.copy = FIXTURE_COPY_OVERLONG;
  // When
  const result = await write(fixture, providersFor(fixture));
  // Then: 카피를 COPY_MAX_GENERATIONS 번 쓰고 hard 가 가장 적은 카피로 장면까지 진행하지만 검토 기록에 카피 hard 를 올린다.
  expect(COPY_MAX_GENERATIONS).toBe(3);
  expect(count(fixture, "video_copy")).toBe(3);
  expect(result.review.accepted).toBe("needsFix");
  expect(result.review.status).toBe("revise");
  expect(result.review.repairs[0]).toContain("카피 먼저: 카피 3회 작성");
  expect(result.review.hardProblems.some((item) => item.startsWith("카피: "))).toBe(true);
  expect(result.script.flow).toBe("copy_first");
});

test("pinToCopy restores wording and chain steps, drops dangling callouts, and refuses a different sentence count", () => {
  // Given
  const copy: CopyLine[] = [
    { chainStep: "pain", text: "뭘 사도 똑같아 보이죠." },
    { chainStep: "cta", text: "오늘 비교해 보세요." },
  ];
  const item = (text: string, chainStep: string, words: string[]) => ({
    text,
    chainStep,
    callouts: words.map((word) => ({ word, text: `${word} 표시` })),
  });
  // When
  const same = pinToCopy(
    [item(copy[0]?.text ?? "", "pain", ["똑같아"]), item("x", "bridge", [])],
    copy,
  );
  const changed = pinToCopy(
    [item("다른 말이에요.", "bridge", ["다른", "보이죠."]), item(copy[1]?.text ?? "", "cta", [])],
    copy,
  );
  const fewer = pinToCopy([item("하나뿐이에요.", "pain", [])], copy);
  // Then
  expect(same.repairs).toEqual(["2번째 문장을 카피 원문으로 되돌림"]);
  expect(same.items[0]?.callouts).toHaveLength(1);
  expect(changed.items.map((line) => [line.text, line.chainStep])).toEqual(
    copy.map((line) => [line.text, line.chainStep]),
  );
  expect(changed.repairs).toEqual([
    "1번째 문장을 카피 원문으로 되돌림",
    "1번째 문장 콜아웃 '다른 표시' 제거(어절 \"다른\"이 카피 원문에 없음)",
  ]);
  // "보이죠." 는 문장부호를 떼면 새 글에 있는 어절이라 남는다.
  expect(changed.items[0]?.callouts.map((callout) => callout.word)).toEqual(["보이죠."]);
  expect(fewer.hard[0]).toContain("장면 응답의 문장이 1개인데 카피는 2개입니다");
  expect(fewer.items).toHaveLength(1);
});

test("writeVideoCopy keeps the fewest-hard copy when every try breaks a rule, and saves one artifact per try", async () => {
  // Given: 공급자가 매번 너무 긴 카피를 돌려준다(HTTP 없이 스텁).
  const fixture = setup();
  let calls = 0;
  const feedbacks: (string | undefined)[] = [];
  // When
  const outcome = await writeVideoCopy({
    store: fixture.store,
    id: fixture.job.id,
    number: 1,
    hypothesis: fixture.hypothesis,
    durationSec: 36,
    signal: fixture.task.signal,
    planning: undefined,
    provider: async (task) => {
      calls++;
      feedbacks.push(task.feedback);
      return { lines: FIXTURE_COPY_OVERLONG.lines, model: planningModel };
    },
  });
  // Then
  expect(calls).toBe(COPY_MAX_GENERATIONS);
  expect(feedbacks[0]).toBeUndefined();
  expect(feedbacks[1]).toContain("카피 규칙 위반");
  expect(outcome.attempts).toBe(COPY_MAX_GENERATIONS);
  expect(outcome.hard.length).toBeGreaterThan(0);
  const artifacts = fixture.store.get(fixture.job.id).artifacts.map((item) => item.name);
  for (let attempt = 1; attempt <= COPY_MAX_GENERATIONS; attempt++)
    expect(artifacts).toContain(copyArtifactName(1, attempt));
  // 외부 카피는 호출 없이 판정만 하고 다음 번호로 저장한다.
  const external = await acceptExternalCopy({
    store: fixture.store,
    id: fixture.job.id,
    number: 1,
    lines: FIXTURE_COPY.lines,
    context: { durationTargetSec: 36, facts: [] },
  });
  expect(external.attempts).toBe(0);
  expect(external.hard).toEqual([]);
  expect(fixture.store.get(fixture.job.id).artifacts.map((item) => item.name)).toContain(
    copyArtifactName(1, COPY_MAX_GENERATIONS + 1),
  );
});

test("the rewrite body accepts an external copy without feedback, rejects an empty body, and the service refuses a copy that breaks the rules before any paid call", async () => {
  // Given
  expect(ScriptRewriteSchema.safeParse({}).success).toBe(false);
  expect(ScriptRewriteSchema.safeParse({ feedback: "도입을 바꿔 주세요" }).success).toBe(true);
  const parsed = ScriptRewriteSchema.parse({ copy: FIXTURE_COPY.lines });
  expect(parsed.feedback).toBe("");
  expect(parsed.copy).toHaveLength(FIXTURE_COPY.lines.length);
  expect(ScriptRewriteSchema.safeParse({ copy: FIXTURE_COPY.lines.slice(0, 3) }).success).toBe(
    false,
  );
  const f = planningPipelineFixture();
  let providerCalls = 0;
  const service = new VideoScriptService(f.store, {
    videoPlanning: async () => {
      providerCalls++;
      return { value: f.planning, model: planningModel };
    },
    videoCopy: async () => {
      providerCalls++;
      return { lines: [...FIXTURE_COPY.lines], model: planningModel };
    },
    videoScript: async () => {
      providerCalls++;
      return { value: f.script, model: planningModel };
    },
    reviewVideoScript: async () => {
      providerCalls++;
      return { value: { status: "pass", summary: "", issues: [] }, model: planningModel };
    },
  });
  try {
    // When: 순서를 거스르고 너무 긴 카피
    const failure = await service
      .rewrite(f.job.id, 1, "", f.input.signal, FIXTURE_COPY_OVERLONG.lines.toReversed())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Then: 400 copy_rules 로 문제 목록을 돌려주고 모델은 부르지 않는다.
    expect(failure).toMatchObject({ code: "copy_rules", status: 400 });
    expect(String((failure as Error).message)).toContain("추정 발화");
    expect(providerCalls).toBe(0);
  } finally {
    await f.close();
  }
});

test("the service applies the copy rules to a copy-first script's sentences as well as the scene rules", async () => {
  // Given: 흐름 표시가 copy_first 인 저장 대본(문장에 사슬 단계가 없어 카피 규칙의 '빠진 단계'에 걸린다).
  const f = planningPipelineFixture();
  const service = new VideoScriptService(f.store, {});
  try {
    const before = service.view(f.job.id, 1);
    f.store.change(f.job.id, (draft) => {
      const script = draft.videoScripts[0];
      if (!script) throw new TypeError("fixture script missing");
      script.flow = "copy_first";
      script.voiceover = script.voiceover.map((line, index) => ({
        ...line,
        chainStep: index === 0 ? "pain" : line.chainStep,
      }));
    });
    // When
    const after = service.view(f.job.id, 1);
    // Then: 예전 흐름(flow "")은 카피 규칙을 보지 않고, copy_first 는 본다.
    expect(before.rules.hard.some((item) => item.includes("빠진 단계"))).toBe(false);
    expect(after.script.flow).toBe("copy_first");
    expect(after.rules.hard.some((item) => item.includes("빠진 단계"))).toBe(true);
  } finally {
    await f.close();
  }
});

test("the CLI show output names the copy-first flow with the copy tries and the restored sentence count", () => {
  // Given: 카피 먼저 흐름 대본과 그 검토 기록(repairs 에 카피 회차·되돌린 문장).
  const f = planningPipelineFixture();
  const service = new VideoScriptService(f.store, {});
  try {
    f.store.change(f.job.id, (draft) => {
      const script = draft.videoScripts[0];
      if (!script) throw new TypeError("fixture script missing");
      script.flow = "copy_first";
      renderStateOf(draft, 1).scriptReview = {
        attempt: 1,
        status: "pass",
        summary: "검토 통과",
        issues: [],
        accepted: "pass",
        repairs: [
          "카피 먼저: 카피 2회 작성(추정 32.6초)",
          "1번째 문장을 카피 원문으로 되돌림",
          "3번째 문장을 카피 원문으로 되돌림",
        ],
        warnings: [],
        hardProblems: [],
        generations: 1,
        instructionsDigest: "",
        instructionsLoadedAt: "",
      };
    });
    // When
    const lines = formatScriptView(service.view(f.job.id, 1));
    // Then
    expect(lines).toContain(
      "흐름: 카피 먼저 · 카피 2회 작성(추정 32.6초) · 카피 원문으로 되돌린 문장 2개",
    );
  } finally {
    f.store.close();
  }
});
