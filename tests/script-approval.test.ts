import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatScriptView, runScriptCli } from "../scripts/script-cli";
import { createApp } from "../server/app";
import { AutomationEngine } from "../server/automation";
import { scopeDigest } from "../server/automation-guard";
import { automationServices } from "../server/automation-services";
import { env } from "../server/config";
import { Pipeline } from "../server/pipeline";
import { AutomationPolicySchema } from "../shared/automation";
import {
  pendingScriptApprovals,
  scriptApprovalMode,
  scriptApprovalReady,
  scriptApproved,
} from "../shared/script-approval";
import { EMPTY_CLIP_PLAN, VideoScriptSchema } from "../shared/video-script";
import { renderScript } from "./render-fixture";
import { renderRuntimeFixture, settle } from "./render-runtime-fixture";

// 대본 승인 게이트(사용자 결정 2026-10-04): 대본이 쓰이고 AI 검토까지 끝난 뒤, 첫 유료 단계(내레이션 합성) 전에
// 사용자가 승인하지 않으면 Flow 모드와 같은 '대기'로 멈춘다. 확인·수정·승인·다시 쓰기는 같은 출처 API·CLI 로 한다.
// 유료 공급자는 전부 스텁(호출 수 기록), 그래픽·조립은 스텁(ffmpeg 호출 없음). 완성본까지 가는 테스트만 ffmpeg 가 필요하다.
const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));
if (!hasFfmpeg) console.log("미검증: ffmpeg 가 없어 완성본까지 가는 승인 테스트를 건너뜁니다.");
// 승인 뒤 내레이션→정지 이미지→조립까지 실제 엔진을 돌리므로 전체 스위트 부하에서 5초 기본 한도를 넘길 수 있다.
setDefaultTimeout(60_000);
const origin = `http://127.0.0.1:${env.PORT}`;
const policy = { mode: "creative", imageCount: 1, videoCount: 1 } as const;
let f: Awaited<ReturnType<typeof renderRuntimeFixture>>;
let engine: AutomationEngine;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  f = await renderRuntimeFixture({ stubRender: true, clipReview: false });
  engine = new AutomationEngine(
    f.store,
    automationServices(f.store, { production: f.production, renderPipeline: f.renderPipeline }),
  );
  app = createApp(f.store, new Pipeline(f.store), engine);
});
afterEach(async () => {
  engine.close();
  await f.close();
});
const paid = () => ({
  voice: f.counts.voice,
  startImage: f.counts.startImage,
  still: f.counts.still,
  veoCreate: f.counts.veoCreate,
});
function request(
  path: string,
  init: { method?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`${origin}/api/jobs/${path}`, {
        method: init.method ?? "GET",
        headers: {
          Origin: init.origin ?? origin,
          "Content-Type": "application/json",
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    ),
  );
}
async function errorOf(response: Response) {
  return (await response.json()) as { error: string; code?: string };
}
async function view(id: string) {
  const response = await request(`${id}/videos/1/script`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    approved: boolean;
    approvalMode: string;
    pending: number[];
    synthesized: boolean;
    approval: { approvedAt: string; scriptDigest: string } | null;
    review: {
      status: string;
      attempt: number;
      accepted: string;
      hardProblems?: string[];
      repairs?: string[];
    } | null;
    rules?: { hard: string[]; soft: string[] };
    script: unknown;
  };
}
// 대본이 쓰이고 승인을 기다리는 상태까지 돌린다
async function waitingJob() {
  const job = f.fresh();
  engine.start(job.id, policy);
  await settle(engine);
  return job.id;
}

test("policy accepts scriptApproval, defaults to required and is covered by the scope digest", () => {
  const job = f.fresh();
  expect(scriptApprovalMode(job)).toBe("required");
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", videoCount: 1, scriptApproval: "auto" })
      .success,
  ).toBe(true);
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", videoCount: 1, scriptApproval: "later" })
      .success,
  ).toBe(false);
  const required = AutomationPolicySchema.parse(policy);
  const auto = AutomationPolicySchema.parse({ ...policy, scriptApproval: "auto" });
  expect(scopeDigest(job, required)).not.toBe(scopeDigest(job, auto));
  // 예전 정책(scriptApproval 없음)의 범위 해시는 그대로다
  expect(scopeDigest(job, required)).toBe(
    scopeDigest(
      job,
      AutomationPolicySchema.parse({ mode: "creative", imageCount: 1, videoCount: 1 }),
    ),
  );
});

test("with the default policy the engine writes and reviews the script, then waits before any paid render call", async () => {
  const id = await waitingJob();
  const job = f.store.get(id);
  expect(job.videoScripts).toHaveLength(1);
  expect(f.counts.scriptReview).toBe(1);
  // 대기는 실패가 아니다: waiting + 예약 없음 + 오류 없음 + phase script
  expect(job.automation?.status).toBe("waiting");
  expect(job.automation?.nextRunAt).toBeNull();
  expect(job.automation?.lastError).toBeNull();
  expect(job.automation?.phase).toBe("script");
  expect(job.automation?.operation).toBeNull();
  expect(job.status).toBe("review");
  expect(job.result).toBe("영상 대본 1개를 확인하고 승인해 주세요");
  expect(pendingScriptApprovals(job)).toEqual([1]);
  expect(scriptApprovalReady(job)).toBe(false);
  // 유료 제작 단계는 하나도 돌지 않았다
  expect(paid()).toEqual({ voice: 0, startImage: 0, still: 0, veoCreate: 0 });
  expect(job.renders[0]?.scriptApproval).toBeNull();
  expect(job.renders[0]?.scriptReview).toMatchObject({ status: "pass", accepted: "pass" });
  // 대기 중에는 엔진이 다시 돌아도(수동 재확인 포함) 유료 호출이 없다
  engine.resume(id);
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(paid()).toEqual({ voice: 0, startImage: 0, still: 0, veoCreate: 0 });
  const current = await view(id);
  expect(current.approved).toBe(false);
  expect(current.approvalMode).toBe("required");
  expect(current.pending).toEqual([1]);
  expect(current.synthesized).toBe(false);
  expect(VideoScriptSchema.safeParse(current.script).success).toBe(true);
});

test("approving through the API wakes the engine and the run continues without a restart", async () => {
  const id = await waitingJob();
  const approved = await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} });
  expect(approved.status).toBe(200);
  const body = (await approved.json()) as { approved: boolean; pending: number[] };
  expect(body.approved).toBe(true);
  expect(body.pending).toEqual([]);
  expect(scriptApproved(f.store.get(id), 1)).toBe(true);
  // wakeScripts 가 곧바로 큐에 넣고 엔진이 집어 간다(재시작·수동 재개 없음)
  expect(["queued", "running"]).toContain(f.store.get(id).automation?.status ?? "");
  await settle(engine);
  const job = f.store.get(id);
  expect(job.automation?.lastError).toBeNull();
  expect(job.automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
  expect(f.counts.veoCreate).toBe(4);
  expect(job.events.some((event) => event.message.includes("대본이 모두 승인되어"))).toBe(true);
  // 다른 출처의 승인 요청은 거부된다
  const other = f.fresh();
  expect(
    (
      await request(`${other.id}/videos/1/script/approve`, {
        method: "POST",
        body: {},
        origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
});

test("editing validates the narration rules, recomputes cut narration, resets approval and overwrites the artifact", async () => {
  const id = await waitingJob();
  // 영문 나레이션은 400 + 문제 목록
  const latin = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: { voiceover: [{ index: 0, text: "Chong Kun Dang 600mg 확인" }] },
  });
  expect(latin.status).toBe(400);
  const latinError = await errorOf(latin);
  expect(latinError.code).toBe("script_rules");
  expect(latinError.error).toContain("영문이 있습니다");
  // 메모 표기·너무 짧은 문장도 거부
  const memo = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: {
      voiceover: [
        { index: 1, text: "예: 종근당 상품명이 근거" },
        { index: 2, text: "네." },
      ],
    },
  });
  expect(memo.status).toBe(400);
  expect((await errorOf(memo)).error).toContain("메모·출처 표기");
  // 말과 그림 규칙: 1번째 문장(컷 0~1)이 화면에 없는 숫자를 말하면 어느 문장·어느 컷인지 한국어로 알려 준다
  const number = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: { voiceover: [{ index: 0, text: "하루 600밀리그램이면 충분해요" }] },
  });
  expect(number.status).toBe(400);
  const numberError = await errorOf(number);
  expect(numberError.code).toBe("script_rules");
  expect(numberError.error).toContain("1번째 문장");
  expect(numberError.error).toContain("숫자 600가 묶인 컷[0~1]의 화면");
  // 없는 문장 번호·형식 오류
  expect(
    (
      await request(`${id}/videos/1/script`, {
        method: "PUT",
        body: { voiceover: [{ index: 39, text: "없는 문장이에요" }] },
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(`${id}/videos/1/script`, { method: "PUT", body: { voiceover: "x" } })).status,
  ).toBe(400);
  // 거부된 편집은 아무것도 바꾸지 않는다
  expect(f.store.get(id).videoScripts[0]?.voiceover[0]?.text).not.toContain("Chong");
  // 승인 뒤 정상 편집 → 저장 + 승인 해제 + 컷 내레이션 재계산.
  // (API 승인은 곧바로 제작을 깨우므로 여기서는 엔진을 깨우지 않는 서비스 승인으로 '승인된 대본'을 만든다)
  engine.services.scripts.approve(id, 1);
  expect(scriptApproved(f.store.get(id), 1)).toBe(true);
  const edited = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: {
      voiceover: [{ index: 0, text: "다리가 붓는 분이라면 꼭 보세요" }],
      captions: [{ cutIndex: 0, onScreenText: "다리 붓는 분" }],
    },
  });
  expect(edited.status).toBe(200);
  const after = f.store.get(id);
  const script = after.videoScripts[0];
  expect(script?.voiceover[0]?.text).toBe("다리가 붓는 분이라면 꼭 보세요");
  // 글만 바꾸고 컷 범위·목적은 그대로다. 시간은 컷(0~1, 0~3초)에서 다시 유도하고 17자(≤ 3초 × 6.5)라 늘어나지 않는다
  expect(script?.voiceover[0]).toMatchObject({
    fromCut: 0,
    toCut: 1,
    purpose: "hook",
    startSec: 0,
    endSec: 3,
  });
  expect(script?.cuts[0]?.onScreenText).toBe("다리 붓는 분");
  expect(script?.cuts[0]?.narration).toContain("다리가 붓는 분이라면 꼭 보세요");
  expect(after.renders[0]?.scriptApproval).toBeNull();
  expect(scriptApproved(after, 1)).toBe(false);
  expect((await view(id)).approved).toBe(false);
  // 산출물은 같은 이름으로 덮어쓴다(목록 중복 없음)
  expect(after.artifacts.filter((asset) => asset.name === "video-script-1.json")).toHaveLength(1);
  const saved = VideoScriptSchema.parse(
    JSON.parse(await Bun.file(join(f.root, "artifacts", id, "video-script-1.json")).text()),
  );
  expect(saved.voiceover[0]?.text).toBe("다리가 붓는 분이라면 꼭 보세요");
  // 편집은 유료 호출을 만들지 않는다
  expect(f.counts.script).toBe(1);
  expect(f.counts.scriptReview).toBe(1);
  // 승인이 풀린 채 엔진이 돌면 다시 대기한다(내레이션 합성 0회)
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(f.counts.voice).toBe(0);
});

// 장면 계획(2026-10-06 R7): 편집은 글만 바꾸고 콜아웃·컷 goal/phase·클립 plan·subjects 를 보존한다. 콜아웃이 붙은 어절이
// 새 문장에서 사라지면 저장 전에 어느 콜아웃인지 알려 준다(픽스처는 마지막 문장에 라벨 콜아웃이 있다).
test("editing keeps the scene plan and refuses a sentence edit that drops a callout word", async () => {
  const id = await waitingJob();
  const before = VideoScriptSchema.parse(f.store.get(id).videoScripts[0]);
  const last = before.voiceover.length - 1;
  const callout = before.voiceover[last]?.callouts[0];
  if (!callout) throw new Error("픽스처의 마지막 문장에 콜아웃이 있어야 합니다.");
  expect(before.veoClips.length).toBeGreaterThan(0);
  expect(before.subjects.length).toBeGreaterThan(0);
  const dropped = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: { voiceover: [{ index: last, text: "지금 바로 보세요" }] },
  });
  expect(dropped.status).toBe(400);
  const droppedError = await errorOf(dropped);
  expect(droppedError.code).toBe("script_rules");
  expect(droppedError.error).toContain(
    `${last + 1}번째 문장 콜아웃 '${callout.text}'의 단어가 문장에 없습니다`,
  );
  expect(droppedError.error).toContain(`"${callout.word}"`);
  expect(f.store.get(id).videoScripts[0]?.voiceover[last]?.text).toBe(before.voiceover[last]?.text);
  // 어절을 남긴 편집과 다른 문장·자막 편집은 통과하고 장면 계획 필드는 그대로다
  const kept = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: {
      voiceover: [
        { index: 0, text: "다리가 붓는 분이라면 꼭 보세요" },
        { index: last, text: `${callout.word} 보세요` },
      ],
      captions: [{ cutIndex: 0, onScreenText: "다리 붓는 분" }],
    },
  });
  expect(kept.status).toBe(200);
  const after = VideoScriptSchema.parse(f.store.get(id).videoScripts[0]);
  expect(after.voiceover[last]?.text).toBe(`${callout.word} 보세요`);
  expect(after.voiceover.map((voice) => voice.callouts)).toEqual(
    before.voiceover.map((voice) => voice.callouts),
  );
  expect(after.cuts.map((cut) => [cut.goal, cut.phase])).toEqual(
    before.cuts.map((cut) => [cut.goal, cut.phase]),
  );
  expect(after.cuts.every((cut) => cut.goal !== "")).toBe(true);
  expect(after.veoClips.map((clip) => clip.plan)).toEqual(before.veoClips.map((clip) => clip.plan));
  expect(after.subjects).toEqual(before.subjects);
  // 조회 응답에도 장면 계획이 그대로 나간다
  const shown = VideoScriptSchema.parse((await view(id)).script);
  expect(shown.subjects).toEqual(before.subjects);
  expect(shown.voiceover[last]?.callouts).toEqual(before.voiceover[last]?.callouts);
  expect(shown.veoClips[0]?.plan).toEqual(before.veoClips[0]?.plan);
  // 편집은 유료 호출을 만들지 않는다
  expect(f.counts.script).toBe(1);
});

test("after narration synthesis an edit or rewrite is refused with 409 and reset is suggested", async () => {
  const id = await waitingJob();
  expect(
    (await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} })).status,
  ).toBe(200);
  await settle(engine);
  const job = f.store.get(id);
  expect(job.renders[0]?.voice).not.toBeNull();
  expect((await view(id)).synthesized).toBe(true);
  const edit = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: { captions: [{ cutIndex: 0, onScreenText: "늦은 수정" }] },
  });
  expect(edit.status).toBe(409);
  const error = await errorOf(edit);
  expect(error.code).toBe("script_synthesized");
  expect(error.error).toContain("초기화");
  const rewrite = await request(`${id}/videos/1/script/rewrite`, {
    method: "POST",
    body: { feedback: "더 짧게" },
  });
  expect(rewrite.status).toBe(409);
  expect((await errorOf(rewrite)).code).toBe("script_synthesized");
  expect(f.counts.script).toBe(1);
});

test("rewrite with feedback regenerates with the feedback, runs the verifier and review, saves the next review attempt and resets approval", async () => {
  const id = await waitingJob();
  // 승인된 대본도 실행 전이면 다시 쓸 수 있고, 다시 쓰면 승인이 풀린다(엔진을 깨우지 않는 서비스 승인)
  engine.services.scripts.approve(id, 1);
  expect(scriptApproved(f.store.get(id), 1)).toBe(true);
  expect(
    (await request(`${id}/videos/1/script/rewrite`, { method: "POST", body: { feedback: "" } }))
      .status,
  ).toBe(400);
  const response = await request(`${id}/videos/1/script/rewrite`, {
    method: "POST",
    body: { feedback: "브랜드 이름을 더 일찍 말하고 문장을 짧게" },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    approved: boolean;
    review: { attempt: number; status: string } | null;
  };
  expect(body.approved).toBe(false);
  expect(body.review).toMatchObject({ attempt: 2, status: "pass" });
  expect(f.counts.script).toBe(2);
  expect(f.counts.scriptReview).toBe(2);
  expect(f.scriptFeedback[1]).toContain("USER FEEDBACK");
  expect(f.scriptFeedback[1]).toContain("브랜드 이름을 더 일찍 말하고 문장을 짧게");
  const job = f.store.get(id);
  expect(job.artifacts.some((asset) => asset.name === "video-script-review-1-2.json")).toBe(true);
  expect(job.renders[0]?.scriptApproval).toBeNull();
  expect(job.events.some((event) => event.message.includes("다시 썼습니다"))).toBe(true);
  // 승인이 풀렸으니 엔진은 다시 기다리고, 승인하면 이어간다
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(f.counts.voice).toBe(0);
  expect(
    (await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} })).status,
  ).toBe(200);
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
});

test("auto mode skips the gate entirely and the view says so", async () => {
  const job = f.fresh();
  engine.start(job.id, { ...policy, scriptApproval: "auto" });
  await settle(engine);
  const result = f.store.get(job.id);
  expect(result.automation?.status).toBe("completed");
  expect(result.renders[0]?.scriptApproval).toBeNull();
  expect(result.renders[0]?.scriptReview?.status).toBe("pass");
  expect(pendingScriptApprovals(result)).toEqual([]);
  const current = await view(job.id);
  expect(current.approvalMode).toBe("auto");
  expect(current.pending).toEqual([]);
  // 없는 영상 번호·범위 밖 번호
  expect((await request(`${job.id}/videos/2/script`)).status).toBe(404);
  expect((await request(`${job.id}/videos/11/script`)).status).toBe(400);
  // 소재 제작 작업이 아니면 409
  const plain = f.fresh();
  expect((await request(`${plain.id}/videos/1/script`)).status).toBe(409);
});

test("auto mode still waits for a script the AI review never passed, and approving it resumes", async () => {
  f.control.scriptReview = "revise";
  const job = f.fresh();
  engine.start(job.id, { ...policy, scriptApproval: "auto" });
  await settle(engine);
  const waiting = f.store.get(job.id);
  expect(waiting.renders[0]?.scriptReview?.accepted).toBe("forced");
  expect(waiting.automation?.status).toBe("waiting");
  expect(waiting.automation?.phase).toBe("script");
  expect(paid()).toEqual({ voice: 0, startImage: 0, still: 0, veoCreate: 0 });
  const current = await view(job.id);
  expect(current.approvalMode).toBe("auto");
  expect(current.pending).toEqual([1]);
  expect(current.approved).toBe(false);
  // 자동 진행이라도 강제 수용 대본은 고칠 수 있다(영문 → 400 은 같은 규칙)
  expect(
    (
      await request(`${job.id}/videos/1/script`, {
        method: "PUT",
        body: { voiceover: [{ index: 0, text: "600mg, 30Capsules도 확인." }], captions: [] },
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(`${job.id}/videos/1/script/approve`, { method: "POST", body: {} })).status,
  ).toBe(200);
  await settle(engine);
  expect(f.store.get(job.id).automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
  expect(pendingScriptApprovals(f.store.get(job.id))).toEqual([]);
});

test("in auto mode a rewrite that passes the AI review resumes without approval", async () => {
  f.control.scriptReview = "revise";
  const job = f.fresh();
  engine.start(job.id, { ...policy, scriptApproval: "auto" });
  await settle(engine);
  expect(f.store.get(job.id).automation?.status).toBe("waiting");
  f.control.scriptReview = "pass";
  const response = await request(`${job.id}/videos/1/script/rewrite`, {
    method: "POST",
    body: { feedback: "메모체 문장을 말하는 문장으로 고쳐 주세요" },
  });
  expect(response.status).toBe(200);
  const rewritten = f.store.get(job.id);
  expect(rewritten.renders[0]?.scriptReview?.accepted).toBe("pass");
  expect(pendingScriptApprovals(rewritten)).toEqual([]);
  await settle(engine);
  expect(f.store.get(job.id).automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
});

test("the CLI shows, rewrites and approves through the API with a same-origin header", async () => {
  const id = await waitingJob();
  const lines: string[] = [];
  const errors: string[] = [];
  const seen: { url: string; origin: string | null; method: string }[] = [];
  const context = {
    baseUrl: origin,
    out: (line: string) => lines.push(line),
    err: (line: string) => errors.push(line),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        origin: request.headers.get("Origin"),
        method: request.method,
      });
      return app.request(request);
    }) as typeof fetch,
  };
  expect(await runScriptCli(["show", id, "1"], context)).toBe(0);
  expect(errors).toEqual([]);
  const shown = lines.join("\n");
  expect(shown).toContain("[내레이션]");
  expect(shown).toContain(f.store.get(id).videoScripts[0]?.voiceover[0]?.text ?? "?");
  expect(shown).toContain("[자막]");
  expect(shown).toContain("승인 대기");
  expect(shown).toContain("[AI 검토 1회차] 통과");
  // 키·토큰류는 출력에 없다
  expect(shown).not.toMatch(/api[_-]?key|sk-[A-Za-z0-9]/i);
  lines.length = 0;
  expect(await runScriptCli(["rewrite", id, "1", "첫 문장을 질문으로"], context)).toBe(0);
  expect(lines.join("\n")).toContain("다시 썼습니다");
  expect(f.scriptFeedback[1]).toContain("첫 문장을 질문으로");
  expect(await runScriptCli(["rewrite", id, "1"], context)).toBe(2);
  lines.length = 0;
  expect(await runScriptCli(["approve", id, "1"], context)).toBe(0);
  expect(lines.join("\n")).toContain("모든 영상이 승인되어");
  const posts = seen.filter((item) => item.method === "POST");
  expect(posts.length).toBe(2);
  for (const post of posts) expect(post.origin).toBe(origin);
  expect(posts[0]?.url).toContain(`/api/jobs/${id}/videos/1/script/rewrite`);
  expect(posts[1]?.url).toContain(`/api/jobs/${id}/videos/1/script/approve`);
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("completed");
  // 잘못된 명령·없는 영상은 종료 코드로 알린다
  expect(await runScriptCli(["frobnicate", id, "1"], context)).toBe(2);
  errors.length = 0;
  expect(await runScriptCli(["show", id, "2"], context)).toBe(1);
  expect(errors.join("\n")).toContain("대본이 아직 없습니다");
});

test.skipIf(!hasFfmpeg)(
  "after approval the pipeline continues to a final mp4 with stubbed providers",
  async () => {
    const real = await renderRuntimeFixture();
    const realEngine = new AutomationEngine(
      real.store,
      automationServices(real.store, {
        production: real.production,
        renderPipeline: real.renderPipeline,
      }),
    );
    const realApp = createApp(real.store, new Pipeline(real.store), realEngine);
    try {
      const job = real.fresh();
      realEngine.start(job.id, policy);
      await settle(realEngine);
      expect(real.store.get(job.id).automation?.status).toBe("waiting");
      expect(real.counts.voice).toBe(0);
      const approved = await realApp.request(
        new Request(`${origin}/api/jobs/${job.id}/videos/1/script/approve`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(approved.status).toBe(200);
      await settle(realEngine);
      const result = real.store.get(job.id);
      expect(result.automation?.lastError).toBeNull();
      expect(result.automation?.status).toBe("completed");
      expect(result.renders[0]?.final?.name).toBe("video-final-1.mp4");
      expect(existsSync(join(real.root, "artifacts", job.id, "video-final-1.mp4"))).toBe(true);
      expect(result.renders[0]?.scriptApproval?.scriptDigest).toBe(
        result.renders[0]?.scriptDigest ?? "?",
      );
    } finally {
      realEngine.close();
      await real.close();
    }
  },
  300_000,
);

// --- needsFix 초안(2026-10-04): 규칙을 통과하지 못한 초안도 승인 대기에 들어가고, 고쳐서 승인하면 제작이 이어진다 -----------------
async function needsFixJob(scriptApproval: "required" | "auto" = "required") {
  f.control.scriptRules = "latin-always";
  const job = f.fresh();
  engine.start(job.id, { ...policy, scriptApproval });
  await settle(engine);
  // 초안이 저장된 뒤에는 정상 대본이 나오게 한다(다시 쓰기 테스트용)
  f.control.scriptRules = "pass";
  return job.id;
}

test("a needsFix draft waits with its hard problems visible, refuses approval until an edit fixes them, then continues to completion", async () => {
  const id = await needsFixJob();
  const waiting = f.store.get(id);
  expect(waiting.automation?.status).toBe("waiting");
  expect(waiting.automation?.phase).toBe("script");
  expect(f.counts.script).toBe(3);
  expect(paid()).toEqual({ voice: 0, startImage: 0, still: 0, veoCreate: 0 });
  const current = await view(id);
  expect(current.review).toMatchObject({ accepted: "needsFix", attempt: 0 });
  expect(current.pending).toEqual([1]);
  expect(current.rules?.hard.length).toBeGreaterThan(0);
  expect(current.rules?.hard[0]).toContain("영문이 있습니다");
  // 승인은 409 로 거부되고 엔진은 깨어나지 않는다
  const refused = await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} });
  expect(refused.status).toBe(409);
  const refusal = await errorOf(refused);
  expect(refusal.code).toBe("script_needs_fix");
  expect(refusal.error).toContain("규칙을 통과하지 못한 초안은 승인할 수 없습니다");
  expect(refusal.error).toContain("영문이 있습니다");
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(f.store.get(id).renders[0]?.scriptApproval).toBeNull();
  expect(f.counts.voice).toBe(0);
  // 영문 문장을 한글로 고치면 저장되고 hard 가 비며, accepted 는 needsFix 로 남아 승인이 필요하다
  const edited = await request(`${id}/videos/1/script`, {
    method: "PUT",
    body: { voiceover: [{ index: 0, text: "다리가 붓는 분이라면 꼭 보세요" }] },
  });
  expect(edited.status).toBe(200);
  const fixed = await view(id);
  expect(fixed.rules?.hard).toEqual([]);
  expect(fixed.review).toMatchObject({ accepted: "needsFix", hardProblems: [] });
  expect(fixed.pending).toEqual([1]);
  // 이제 승인되고 재시작 없이 내레이션 합성부터 이어간다
  const approved = await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} });
  expect(approved.status).toBe(200);
  await settle(engine);
  const done = f.store.get(id);
  expect(done.automation?.lastError).toBeNull();
  expect(done.automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
  // 생성은 더 늘지 않았다
  expect(f.counts.script).toBe(3);
});

test("auto mode takes the same needsFix path: the draft waits, approval needs the fix, then the run completes", async () => {
  const id = await needsFixJob("auto");
  const job = f.store.get(id);
  expect(job.automation?.status).toBe("waiting");
  expect(pendingScriptApprovals(job)).toEqual([1]);
  expect((await view(id)).approvalMode).toBe("auto");
  expect(
    (await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} })).status,
  ).toBe(409);
  expect(
    (
      await request(`${id}/videos/1/script`, {
        method: "PUT",
        body: { voiceover: [{ index: 0, text: "다리가 붓는 분이라면 꼭 보세요" }] },
      })
    ).status,
  ).toBe(200);
  expect(
    (await request(`${id}/videos/1/script/approve`, { method: "POST", body: {} })).status,
  ).toBe(200);
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("completed");
  expect(f.counts.voice).toBeGreaterThan(0);
});

test("a rewrite that still fails the rules is saved as a needsFix draft with approval reset and a fix-or-rewrite message", async () => {
  const id = await waitingJob();
  engine.services.scripts.approve(id, 1);
  expect(scriptApproved(f.store.get(id), 1)).toBe(true);
  f.control.scriptRules = "latin-always";
  const response = await request(`${id}/videos/1/script/rewrite`, {
    method: "POST",
    body: { feedback: "더 짧게" },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    approved: boolean;
    review: { accepted: string; generations: number; hardProblems: string[] } | null;
    rules: { hard: string[] };
  };
  expect(body.approved).toBe(false);
  expect(body.review).toMatchObject({ accepted: "needsFix", generations: 3 });
  expect(body.review?.hardProblems.length).toBeGreaterThan(0);
  expect(body.rules.hard.length).toBeGreaterThan(0);
  expect(f.counts.script).toBe(4);
  const job = f.store.get(id);
  expect(job.renders[0]?.scriptApproval).toBeNull();
  expect(job.events.some((event) => event.message.includes("고치거나 다시 쓰기"))).toBe(true);
  // 엔진은 다시 기다리고 유료 호출은 없다
  await settle(engine);
  expect(f.store.get(id).automation?.status).toBe("waiting");
  expect(f.counts.voice).toBe(0);
});

test("the CLI prints the unresolved rules of a needsFix draft and exits 1 when approval is refused", async () => {
  const id = await needsFixJob();
  const lines: string[] = [];
  const errors: string[] = [];
  const context = {
    baseUrl: origin,
    out: (line: string) => lines.push(line),
    err: (line: string) => errors.push(line),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(new Request(input, init))) as typeof fetch,
  };
  expect(await runScriptCli(["show", id, "1"], context)).toBe(0);
  const shown = lines.join("\n");
  expect(shown).toContain("규칙 미통과 초안");
  expect(shown).toContain("[규칙 미통과]");
  expect(shown).toContain("영문이 있습니다");
  expect(shown).not.toContain("[AI 검토");
  lines.length = 0;
  expect(await runScriptCli(["approve", id, "1"], context)).toBe(1);
  expect(errors.join("\n")).toContain("규칙을 통과하지 못한 초안은 승인할 수 없습니다");
  expect(f.store.get(id).renders[0]?.scriptApproval).toBeNull();
});

test("formatScriptView prints repairs, warnings and the unresolved-rules section", () => {
  const base = renderScript(1, "concept-1", 36);
  const output = formatScriptView({
    number: 1,
    script: base,
    approvalMode: "required",
    approved: false,
    approval: null,
    review: {
      attempt: 0,
      status: "revise",
      summary: "규칙을 통과하지 못한 초안입니다 — 고치거나 다시 쓰기(생성 3회)",
      issues: [],
      accepted: "needsFix",
      repairs: [
        "1번째 문장 1번째 컷(정지 이미지)의 graphicLines 1줄 삭제",
        "컷 3: 5초 넘게 효과가 없어 zoom_punch 추가",
      ],
      warnings: ["목표 40초, 실제 43초입니다."],
      hardProblems: ["1번째 문장(0초): 나레이션에 영문이 있습니다"],
      generations: 3,
    },
    rules: {
      hard: ["1번째 문장(0초): 나레이션에 영문이 있습니다"],
      soft: ["목표 40초, 실제 43초입니다."],
    },
    synthesized: false,
    pending: [1],
  }).join("\n");
  expect(output).toContain("[규칙 미통과] 고치거나 다시 쓰기(생성 3회)");
  expect(output).toContain("- 1번째 문장(0초): 나레이션에 영문이 있습니다");
  expect(output).toContain("[경고 1건]");
  expect(output).toContain("[자동 수리 2건]");
  expect(output).toContain("- 컷 3: 5초 넘게 효과가 없어 zoom_punch 추가");
  // 장면 계획(2026-10-06): 컷 줄의 목표·구간, 문장 아래 콜아웃, 등장 대상, 클립 세 구간 계획
  expect(output).toContain('목표 "장면 1의 핵심"');
  expect(output).toMatch(/구간 (early|mid|late)/);
  expect(output).toContain("콜아웃: ");
  expect(output).toContain("→ label '지금 확인' (subject)");
  expect(output).toContain("[등장 대상]");
  expect(output).toContain("- woman: woman in her 30s");
  expect(output).toContain("[클립 구간 계획]");
  expect(output).toContain("Veo 클립 A");
  expect(output).toContain("early(0~3초) 카메라: Clip A: start wide at the kitchen doorway");
  expect(output).toContain("late(5.5~8초) 카메라: Orbit a quarter turn");
  // 장면 계획이 없는 예전 대본은 그 절을 내지 않는다
  const legacy = formatScriptView({
    number: 1,
    script: {
      ...base,
      subjects: [],
      cuts: base.cuts.map((cut) => ({ ...cut, goal: "", phase: "" })),
      voiceover: base.voiceover.map((voice) => ({ ...voice, callouts: [] })),
      veoClips: base.veoClips.map((clip) => ({ ...clip, plan: EMPTY_CLIP_PLAN })),
    },
    approvalMode: "required",
    approved: false,
    approval: null,
    review: null,
    synthesized: false,
    pending: [1],
  }).join("\n");
  expect(legacy).not.toContain("[등장 대상]");
  expect(legacy).not.toContain("[클립 구간 계획]");
  expect(legacy).not.toContain("콜아웃: ");
  expect(legacy).not.toContain("목표 ");
});
