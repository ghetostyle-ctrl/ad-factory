import { expect, test } from "bun:test";
import { AutomationStateSchema } from "../shared/automation";
import { jobProgress, nextAction } from "../shared/next-action";
import { emptyRenderState } from "../shared/render-state";
import { ArtifactSchema, type Job, JobSchema } from "../shared/schema";
import { scriptDigestOf } from "../shared/script-approval";
import { renderScript } from "./render-fixture";

// --- 픽스처: JobSchema.parse 로 최소 객체를 만든다(기본값 필드는 스키마가 채운다) ---
const JOB_ID = "0f5b6c1e-3f0e-4b1a-9c33-2f1d6a7e8b90";
const NOW = "2026-10-12T00:00:00.000Z";
const artifact = (name: string, kind: "text" | "image" | "video" | "json" | "audio" = "video") =>
  ArtifactSchema.parse({
    id: name,
    name,
    kind,
    url: `/api/jobs/${JOB_ID}/artifacts/${name}`,
    agentId: "production",
  });
function automation(over: Record<string, unknown> = {}) {
  return AutomationStateSchema.parse({
    policy: { mode: "creative", imageCount: 1, videoCount: 3, clipMode: "flow" },
    status: "running",
    phase: "clips",
    nextRunAt: null,
    nextAnalysisAt: null,
    lastError: null,
    authorizedAt: NOW,
    scopeDigest: "scope",
    imageAttempts: 0,
    operation: null,
    stoppedAt: null,
    ...over,
  });
}
function policy(videoCount: number, extra: Record<string, unknown> = {}) {
  return { mode: "creative", imageCount: 1, videoCount, clipMode: "flow", ...extra };
}
function job(over: Record<string, unknown> = {}): Job {
  return JobSchema.parse({
    id: JOB_ID,
    projectId: null,
    name: "올리브 테스트",
    productUrl: "https://example.com/olive",
    productDescription: "올리브 오일 캡슐 제품 설명입니다. 충분히 길게 적은 문장.",
    audience: "30대 직장인",
    status: "review",
    createdAt: NOW,
    updatedAt: NOW,
    agents: [],
    events: [],
    artifacts: [],
    accountId: null,
    selection: null,
    staged: null,
    metrics: null,
    result: null,
    ...over,
  });
}
const scriptsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => renderScript(index + 1, "h1"));
const finalState = (number: number, durationMs: number) => ({
  ...emptyRenderState(number),
  final: { name: `video-final-${number}.mp4`, digest: `d${number}`, durationMs, bgmTrackId: null },
});
const finals = (...numbers: number[]) => numbers.map((n) => artifact(`video-final-${n}.mp4`));
// 영상 3편: 1·2는 완성, 3은 Flow 클립 대기 중
function waitingClipsJob(over: Record<string, unknown> = {}): Job {
  return job({
    status: "review",
    result: "클립 4개를 Flow에서 만들어 업로드해 주세요",
    automation: automation({ status: "waiting", phase: "clips" }),
    videoScripts: scriptsOf(3),
    artifacts: finals(1, 2),
    renders: [finalState(1, 23000), finalState(2, 24600)],
    ...over,
  });
}

test("⑪ a new job without automation or files starts with the 시작 button", () => {
  const action = nextAction(job({ status: "queued" }));
  expect(action).toMatchObject({
    kind: "start",
    reason: "",
    title: "자료로 광고안과 영상을 만들기 시작하세요",
    facts: [],
    primary: { label: "시작", command: { type: "start" } },
    secondary: null,
    videoNumber: null,
  });
});

test("② a saved plan draft waiting for a choice asks for 광고안 선택", () => {
  const action = nextAction(
    job({
      status: "blocked",
      result: "기획 검토에서 멈췄습니다. 광고안 초안을 보관했습니다.",
      automation: automation({
        policy: policy(10),
        status: "attention",
        phase: "creative",
        lastError: "기획 검토에서 멈췄습니다. 광고안 초안을 보관했습니다.",
      }),
      artifacts: [artifact("plan-draft-1.json", "json")],
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    reason: "기획 검토에서 멈췄습니다",
    title: "저장된 광고안을 확인하고 선택하세요",
    primary: { command: { type: "reviewPlan" } },
  });
});

test("① a kept script draft opens that video's script or resumes", () => {
  const action = nextAction(
    job({
      result: "대본 초안 수정 대기 · 영상 2. 형식 오류 응답 원문을 보관했습니다.",
      automation: automation({ status: "waiting", phase: "script" }),
      videoScripts: scriptsOf(3),
      artifacts: [artifact("video-script-issues-2-1.json", "json")],
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    reason: "대본 형식 문제로 초안을 보관했어요",
    title: "영상 2 대본 초안을 고치거나 다시 쓰세요",
    primary: { command: { type: "openVideo", number: 2 } },
    secondary: { label: "이어서 진행", command: { type: "resume" } },
    videoNumber: 2,
  });
});

test("③ blocked asks for the connection settings and keeps the cause as the reason", () => {
  const action = nextAction(
    job({
      status: "blocked",
      automation: automation({
        status: "blocked",
        lastError: "Typecast 키가 필요합니다. 연결 설정에서 입력하세요.",
      }),
      videoScripts: scriptsOf(3),
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    reason: "Typecast 키가 필요합니다",
    title: "연결 설정을 마치면 이어서 진행합니다",
    primary: { command: { type: "openSettings" } },
    secondary: { command: { type: "resume" } },
  });
});

test("④ script approval: counts pending and rule-failed scripts, batch-approves only the approvable", () => {
  const action = nextAction(
    job({
      result: "영상 대본 3개를 확인하고 승인해 주세요",
      automation: automation({ status: "waiting", phase: "script" }),
      videoScripts: scriptsOf(3),
      renders: [
        {
          ...emptyRenderState(2),
          scriptReview: {
            attempt: 0,
            status: "revise",
            summary: "규칙 미통과",
            issues: [],
            accepted: "needsFix",
          },
        },
      ],
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    title: "영상 1 대본을 확인하고 승인하세요",
    primary: { command: { type: "openVideo", number: 1 } },
    secondary: { label: "대본 2편 승인", command: { type: "approveScripts", numbers: [1, 3] } },
    videoNumber: 1,
  });
  expect(action.facts).toEqual([
    { label: "승인 대기", value: "3", unit: "편" },
    { label: "규칙 미통과", value: "1", unit: "편" },
    { label: "완성 영상", value: "0/3", unit: "편" },
  ]);
  expect(action.detail).toContain("1편");
});

test("④ when only rule-failed scripts remain there is nothing to batch-approve", () => {
  const action = nextAction(
    job({
      automation: automation({ status: "waiting", phase: "script", policy: policy(1) }),
      videoScripts: scriptsOf(1),
      renders: [
        {
          ...emptyRenderState(1),
          scriptReview: {
            attempt: 0,
            status: "revise",
            summary: "x",
            issues: [],
            accepted: "needsFix",
          },
        },
      ],
    }),
  );
  expect(action.secondary).toBeNull();
  expect(action.primary?.command).toEqual({ type: "openVideo", number: 1 });
  expect(action.facts[1]).toEqual({ label: "규칙 미통과", value: "1", unit: "편" });
});

test("④ waiting at the script phase with nothing pending falls back to a resume check", () => {
  const action = nextAction(
    job({
      automation: automation({ status: "waiting", phase: "script", policy: policy(1) }),
      videoScripts: [],
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    title: "대본 승인 상태를 다시 확인하세요",
    primary: { label: "이어서 진행", command: { type: "resume" } },
    secondary: null,
  });
});

test("⑤ waiting for Flow images counts the images still missing", () => {
  const request = (id: string, digest: string | null) => ({
    id: id.repeat(64).slice(0, 64),
    target: "variant-1",
    label: "광고 이미지",
    prompt: "올리브 오일 광고 이미지",
    aspect: "square",
    referenceCount: 0,
    digest,
    createdAt: NOW,
  });
  const action = nextAction(
    job({
      automation: automation({ status: "waiting", phase: "startImages" }),
      videoScripts: scriptsOf(3),
      flowImageRequests: [request("a", null), request("b", "c".repeat(64)), request("d", null)],
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    title: "Flow 이미지를 만들어 올리세요",
    primary: { command: { type: "openVideo", number: 1 } },
    videoNumber: 1,
  });
  expect(action.facts[0]).toEqual({ label: "대기", value: "2", unit: "장" });
  // 영상이 없는 작업(광고 이미지만)은 영상 번호도 완성 영상 칸도 없다
  const imagesOnly = nextAction(
    job({ automation: automation({ status: "waiting", phase: "image", policy: policy(0) }) }),
  );
  expect(imagesOnly).toMatchObject({ kind: "yourTurn", primary: null, videoNumber: null });
  expect(imagesOnly.facts).toEqual([{ label: "대기", value: "0", unit: "장" }]);
});

test("⑥ waiting for Flow clips names the video, the clip count, and the progress", () => {
  const action = nextAction(waitingClipsJob());
  expect(action).toMatchObject({
    kind: "yourTurn",
    reason: "",
    title: "영상 3 클립 4개를 Flow에서 만들어 올리세요",
    primary: { label: "영상 3 Flow 지시서 보기", command: { type: "openVideo", number: 3 } },
    secondary: { label: "이어서 진행", command: { type: "resume" } },
    videoNumber: 3,
  });
  expect(action.facts).toEqual([
    { label: "올린 클립", value: "0/4", unit: "개" },
    { label: "완성 영상", value: "2/3", unit: "편" },
    { label: "남은 영상", value: "1", unit: "편" },
  ]);
  // 클립이 일부 올라오면 남은 수가 줄고, 모두 올라오면 이어서 진행을 안내한다
  const partial = waitingClipsJob({
    artifacts: [...finals(1, 2), artifact("clip-3-A-1.mp4"), artifact("clip-3-B-1.mp4")],
    renders: [
      finalState(1, 23000),
      finalState(2, 24600),
      {
        ...emptyRenderState(3),
        clips: { A: { name: "clip-3-A-1.mp4" }, B: { name: "clip-3-B-1.mp4" } },
      },
    ],
  });
  expect(nextAction(partial).title).toBe("영상 3 클립 2개를 Flow에서 만들어 올리세요");
  expect(nextAction(partial).facts[0]).toEqual({ label: "올린 클립", value: "2/4", unit: "개" });
  const clips = Object.fromEntries(
    ["A", "B", "C", "D"].map((id) => [id, { name: `clip-3-${id}-1.mp4` }]),
  );
  const complete = waitingClipsJob({
    artifacts: [
      ...finals(1, 2),
      ...["A", "B", "C", "D"].map((id) => artifact(`clip-3-${id}-1.mp4`)),
    ],
    renders: [finalState(1, 23000), finalState(2, 24600), { ...emptyRenderState(3), clips }],
  });
  expect(nextAction(complete)).toMatchObject({
    kind: "yourTurn",
    title: "영상 3 클립을 모두 올렸어요. 이어서 진행하세요",
    primary: { command: { type: "resume" } },
  });
});

test("⑦ attention reports the first sentence of lastError and resumes", () => {
  const action = nextAction(
    job({
      status: "blocked",
      automation: automation({
        status: "attention",
        phase: "assemble",
        lastError: "h3 · 조립 검증에 실패했습니다. 실행 기록을 확인하세요.",
      }),
      videoScripts: scriptsOf(3),
    }),
  );
  expect(action).toMatchObject({
    kind: "yourTurn",
    reason: "광고안 3 · 조립 검증에 실패했습니다",
    title: "멈춘 이유를 확인하고 이어서 진행하세요",
    primary: { label: "이어서 진행", command: { type: "resume" } },
    secondary: null,
  });
  expect(action.detail).not.toContain("불확실");
});

test("⑦ attention with an uncertain clip request warns about paying twice", () => {
  const action = nextAction(
    job({
      automation: automation({ status: "attention", lastError: "응답 수신 뒤 저장이 끊겼습니다." }),
      videoScripts: scriptsOf(3),
      renders: [
        { ...emptyRenderState(1), clips: { A: { pendingSince: "2026-10-12T00:00:00.000Z" } } },
      ],
    }),
  );
  expect(action.detail).toContain("불확실");
  expect(action.reason).toBe("응답 수신 뒤 저장이 끊겼습니다");
});

test("⑧ stopped says the work can resume and keeps the stop reason", () => {
  const action = nextAction(
    job({
      status: "cancelled",
      result: "사용자가 자동 운영을 중지했습니다. · 자동 실행 중지",
      automation: automation({ status: "stopped", phase: "voice" }),
      videoScripts: scriptsOf(3),
      artifacts: finals(1),
      renders: [finalState(1, 23000)],
    }),
  );
  expect(action).toMatchObject({
    kind: "stopped",
    reason: "사용자가 자동 운영을 중지했습니다",
    title: "중지한 작업을 이어서 진행할 수 있어요",
    primary: { label: "이어서 진행", command: { type: "resume" } },
  });
  expect(action.detail).toContain("완성 영상 1편");
});

test("⑨ running and queued show the phase as progress with a stop button only", () => {
  const running = nextAction(
    job({
      status: "running",
      automation: automation({ status: "running", phase: "assemble" }),
      videoScripts: scriptsOf(3),
      artifacts: finals(1),
      renders: [finalState(1, 23000)],
    }),
  );
  expect(running).toMatchObject({
    kind: "progress",
    title: "조립 진행 중",
    primary: null,
    secondary: { label: "중지", command: { type: "stop" } },
    videoNumber: 2,
  });
  expect(running.facts).toEqual([{ label: "완성 영상", value: "1/3", unit: "편" }]);
  const queued = nextAction(
    job({ status: "queued", automation: automation({ status: "queued", phase: "script" }) }),
  );
  expect(queued).toMatchObject({ kind: "progress", title: "대본 진행 중", videoNumber: null });
});

test("⑩ completed offers every finished video for download with the total length", () => {
  const action = nextAction(
    job({
      status: "completed",
      automation: automation({ status: "completed", phase: "finished" }),
      videoScripts: scriptsOf(3),
      artifacts: finals(1, 2, 3),
      renders: [finalState(1, 23000), finalState(2, 24600), finalState(3, 25200)],
    }),
  );
  expect(action).toMatchObject({
    kind: "done",
    title: "완성 영상 3편을 받으세요",
    primary: { command: { type: "downloadFinals", numbers: [1, 2, 3] } },
    secondary: null,
  });
  expect(action.facts).toEqual([
    { label: "완성 영상", value: "3/3", unit: "편" },
    { label: "총 길이", value: "1분 13초", unit: "" },
  ]);
  // 광고 이미지만 만든 작업
  const imagesOnly = nextAction(
    job({
      status: "completed",
      automation: automation({ policy: policy(0), status: "completed", phase: "finished" }),
    }),
  );
  expect(imagesOnly).toMatchObject({ kind: "done", primary: null, facts: [] });
});

test("⑫ legacy jobs without automation map job.status to a simple action", () => {
  const legacy = (status: string, result: string | null = null) =>
    nextAction(job({ status, result, artifacts: [artifact("ad-1.png", "image")] }));
  expect(legacy("completed")).toMatchObject({ kind: "done", primary: null });
  expect(legacy("running").kind).toBe("progress");
  expect(legacy("queued").kind).toBe("progress");
  expect(legacy("review")).toMatchObject({ kind: "yourTurn", title: "결과를 확인하세요" });
  expect(legacy("blocked", "연결 설정이 필요합니다.")).toMatchObject({
    kind: "yourTurn",
    reason: "연결 설정이 필요합니다",
    primary: { command: { type: "openSettings" } },
  });
  expect(legacy("failed", "이미지 생성에 실패했습니다.")).toMatchObject({
    kind: "stopped",
    reason: "이미지 생성에 실패했습니다",
    primary: null,
  });
  expect(legacy("cancelled").kind).toBe("stopped");
});

test("ad-operation waiting (out of scope) is progress with nothing to do", () => {
  const action = nextAction(
    job({
      automation: automation({
        policy: {
          mode: "prepare",
          maxTotalSpend: 1000,
          endAt: "2026-12-01T00:00:00.000Z",
          analysisIntervalMinutes: 60,
        },
        status: "waiting",
        phase: "insights",
      }),
    }),
  );
  expect(action).toMatchObject({ kind: "progress", primary: null, secondary: null, facts: [] });
});

test("action text never leaks file names, commands, or digests", () => {
  const jobs = [
    waitingClipsJob(),
    job({
      automation: automation({ status: "waiting", phase: "script" }),
      videoScripts: scriptsOf(2),
    }),
    job({ automation: automation({ status: "attention", lastError: "flow-export-1.md 참고" }) }),
    job({
      automation: automation({
        status: "blocked",
        lastError: "키가 없습니다 (flow-export-2.md 참고).",
      }),
    }),
  ];
  for (const item of jobs) {
    const action = nextAction(item);
    const text = [
      action.reason,
      action.title,
      action.detail,
      action.primary?.label,
      action.secondary?.label,
    ]
      .concat(action.facts.flatMap((fact) => [fact.label, fact.value, fact.unit]))
      .join(" ");
    expect(text).not.toMatch(/digest|CLI|LUFS|bun run|\.json|\.mp4|\.png|flow-export-\d+\.md\)/u);
    expect(action.facts.length).toBeLessThanOrEqual(4);
  }
});

// --- jobProgress ---

test("jobProgress for the real-world shape: 8 of 10 done, video 9 waiting on the user", () => {
  const renders = Array.from({ length: 8 }, (_, index) => finalState(index + 1, 24000));
  const progress = jobProgress(
    job({
      automation: automation({ policy: policy(10), status: "waiting", phase: "clips" }),
      videoScripts: scriptsOf(10),
      artifacts: finals(1, 2, 3, 4, 5, 6, 7, 8),
      renders,
    }),
  );
  expect(progress).toEqual({ done: 8, total: 10, yourTurn: 1, waiting: 1, totalSec: 192 });
});

test("jobProgress counts a final video from render.final or from a legacy video-final artifact", () => {
  const progress = jobProgress(
    job({
      automation: automation({ status: "running" }),
      videoScripts: scriptsOf(3),
      // 영상 1은 renders.final 만, 영상 2는 산출물만, 영상 3은 둘 다(한 번만 센다)
      artifacts: finals(2, 3),
      renders: [finalState(1, 20000), finalState(3, 21500)],
    }),
  );
  expect(progress.done).toBe(3);
  // 영상 2는 길이를 모르므로 합계를 지어내지 않는다
  expect(progress.totalSec).toBeNull();
  expect(progress).toMatchObject({ total: 3, yourTurn: 0, waiting: 0 });
});

test("jobProgress takes the total from policy.videoCount, else from the saved scripts", () => {
  expect(jobProgress(job({ automation: automation({ policy: policy(5) }) })).total).toBe(5);
  expect(
    jobProgress(
      job({
        automation: automation({ policy: { mode: "creative", clipMode: "flow" } }),
        videoScripts: scriptsOf(4),
      }),
    ).total,
  ).toBe(4);
  expect(jobProgress(job({ videoScripts: scriptsOf(2) })).total).toBe(2);
  // videoCount 0 은 0 이다(스크립트 수로 되돌아가지 않는다)
  expect(jobProgress(job({ automation: automation({ policy: policy(0) }) })).total).toBe(0);
});

test("jobProgress counts script approvals once per video and never below 1 when it is the user's turn", () => {
  const waitingApproval = jobProgress(
    job({
      automation: automation({ status: "waiting", phase: "script", policy: policy(3) }),
      videoScripts: scriptsOf(3),
    }),
  );
  expect(waitingApproval).toMatchObject({ done: 0, total: 3, yourTurn: 3, waiting: 0 });
  // 한 편이 승인되면 승인 대기 수가 줄고 나머지는 대기로 센다
  const base = job({
    automation: automation({ status: "waiting", phase: "script", policy: policy(3) }),
    videoScripts: scriptsOf(3),
  });
  const first = base.videoScripts[0];
  if (!first) throw new Error("fixture script missing");
  const oneApproved = jobProgress({
    ...base,
    renders: [
      {
        ...emptyRenderState(1),
        scriptApproval: { approvedAt: NOW, scriptDigest: scriptDigestOf(first) },
      },
    ],
  });
  expect(oneApproved).toMatchObject({ yourTurn: 2, waiting: 1 });
  // 연결 설정·확인·기획 선택처럼 영상 번호로 셀 수 없는 차례도 1 로 센다
  const blocked = jobProgress(
    job({
      automation: automation({ status: "blocked", policy: policy(3) }),
      videoScripts: scriptsOf(3),
    }),
  );
  expect(blocked).toMatchObject({ yourTurn: 1, waiting: 2 });
});

test("jobProgress of a job that never started is all zeros with no length", () => {
  expect(jobProgress(job({ status: "queued" }))).toEqual({
    done: 0,
    total: 0,
    yourTurn: 0,
    waiting: 0,
    totalSec: null,
  });
  // 진행 중인 작업은 사용자 차례가 아니다
  expect(
    jobProgress(job({ automation: automation({ status: "running", policy: policy(2) }) })),
  ).toEqual({ done: 0, total: 2, yourTurn: 0, waiting: 2, totalSec: null });
});
