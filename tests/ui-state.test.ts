import { expect, test } from "bun:test";
import { AutomationStateSchema } from "../shared/automation";
import type { CreativeVariant } from "../shared/creative-plan";
import { emptyRenderState } from "../shared/render-state";
import { ArtifactSchema, type Job, JobSchema } from "../shared/schema";
import { scriptDigestOf } from "../shared/script-approval";
import {
  agentUiState,
  automationUiState,
  firstSentence,
  flowClipUiState,
  humanizeEventMessage,
  jobUiState,
  PHASE_LABELS,
  stripEnumPrefix,
  variantUiState,
} from "../shared/ui-state";
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
// 영상 3편: 1·2는 완성, 3은 Flow 클립 대기 중인 작업
function waitingClipsJob(over: Record<string, unknown> = {}): Job {
  return job({
    status: "review",
    result: "클립 4개를 Flow에서 만들어 업로드해 주세요",
    automation: automation({ status: "waiting", phase: "clips" }),
    videoScripts: [1, 2, 3].map((number) => renderScript(number, "h1")),
    artifacts: [artifact("video-final-1.mp4"), artifact("video-final-2.mp4")],
    ...over,
  });
}
const variant = (over: Record<string, unknown> = {}) =>
  ({
    id: "v1",
    imageAttempts: 1,
    approvedImageId: null,
    approvedImageDigest: null,
    approvedCreativeDigest: null,
    reviewStatus: "pending",
    cardImageIds: [],
    ...over,
  }) as unknown as CreativeVariant;

test("PHASE_LABELS gives every automation phase its user-language name", () => {
  expect(PHASE_LABELS).toMatchObject({
    strategy: "자료 분석",
    creative: "광고안",
    script: "대본",
    image: "광고 이미지",
    video: "영상",
    voice: "내레이션",
    stills: "정지 이미지",
    startImages: "시작 이미지",
    clips: "클립",
    graphics: "설명 라벨 합성",
    assemble: "조립",
    review: "이미지 검토",
    stage: "Meta 준비",
    activate: "게시",
    insights: "성과",
    report: "분석",
    finished: "종료",
  });
  expect(Object.keys(PHASE_LABELS)).toHaveLength(17);
});

test("running and queued automation read as progress with the phase name", () => {
  const running = job({ status: "running", automation: automation({ status: "running" }) });
  expect(jobUiState(running)).toMatchObject({ family: "progress", label: "진행 중 · 클립" });
  const queued = job({
    status: "queued",
    automation: automation({ status: "queued", phase: "assemble" }),
  });
  expect(jobUiState(queued)).toMatchObject({ family: "progress", label: "진행 중 · 조립" });
});

test("waiting for Flow clips is the user's turn and names the video and clip count", () => {
  const state = jobUiState(waitingClipsJob());
  expect(state).toEqual({
    family: "yourTurn",
    label: "당신 차례 · Flow 클립 올리기",
    detail: "영상 3의 클립 4개를 기다려요.",
  });
  // 클립을 하나 올리면 남은 수가 줄어든다
  const uploaded = waitingClipsJob({
    artifacts: [
      artifact("video-final-1.mp4"),
      artifact("video-final-2.mp4"),
      artifact("clip-3-A-1.mp4"),
    ],
    renders: [{ ...emptyRenderState(3), clips: { A: { name: "clip-3-A-1.mp4" } } }],
  });
  expect(jobUiState(uploaded).detail).toBe("영상 3의 클립 3개를 기다려요.");
});

test("waiting at the script phase is '대본 승인' with the pending count", () => {
  const scripts = [1, 2, 3].map((number) => renderScript(number, "h1"));
  const waiting = job({
    result: "영상 대본 3개를 확인하고 승인해 주세요",
    automation: automation({ status: "waiting", phase: "script" }),
    videoScripts: scripts,
  });
  expect(jobUiState(waiting)).toEqual({
    family: "yourTurn",
    label: "당신 차례 · 대본 승인",
    detail: "대본 3편이 승인을 기다려요.",
  });
  // 한 편을 승인하면 대기 수가 줄어든다(승인 다이제스트는 스키마가 읽은 대본으로 계산한다)
  const first = waiting.videoScripts[0];
  if (!first) throw new Error("fixture script missing");
  const approved = job({
    automation: automation({ status: "waiting", phase: "script" }),
    videoScripts: scripts,
    renders: [
      {
        ...emptyRenderState(1),
        scriptApproval: { approvedAt: NOW, scriptDigest: scriptDigestOf(first) },
      },
    ],
  });
  expect(jobUiState(approved).detail).toBe("대본 2편이 승인을 기다려요.");
});

test("waiting for Flow images (image, stills, startImages) is '당신 차례 · Flow 이미지 올리기'", () => {
  for (const phase of ["image", "stills", "startImages"] as const)
    expect(jobUiState(job({ automation: automation({ status: "waiting", phase }) }))).toMatchObject(
      { family: "yourTurn", label: "당신 차례 · Flow 이미지 올리기" },
    );
});

test("blocked is '당신 차례 · 연결 설정'", () => {
  const blocked = job({
    status: "blocked",
    automation: automation({ status: "blocked", lastError: "Typecast 키가 필요합니다." }),
  });
  expect(jobUiState(blocked)).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 연결 설정",
  });
});

test("attention is '당신 차례 · 확인' and carries the first sentence of lastError", () => {
  const attention = job({
    status: "blocked",
    automation: automation({
      status: "attention",
      lastError: "Veo 요청 결과가 불확실합니다. 실행 기록을 확인하세요.",
    }),
  });
  expect(jobUiState(attention)).toEqual({
    family: "yourTurn",
    label: "당신 차례 · 확인",
    detail: "Veo 요청 결과가 불확실합니다",
  });
  // 원인이 없으면 일반 안내
  const bare = job({ automation: automation({ status: "attention" }) });
  expect(jobUiState(bare).detail).toBe("처리 결과를 확인해야 해요.");
});

test("stopped is '멈춤 · 중지함' and completed is '완료'", () => {
  expect(
    jobUiState(
      job({ status: "cancelled", automation: automation({ status: "stopped", phase: "voice" }) }),
    ),
  ).toMatchObject({ family: "stopped", label: "멈춤 · 중지함" });
  expect(
    jobUiState(
      job({
        status: "completed",
        automation: automation({ status: "completed", phase: "finished" }),
      }),
    ),
  ).toMatchObject({ family: "done", label: "완료" });
});

test("a saved plan draft waiting for choice reads '기획 선택' before the automation status", () => {
  const planning = job({
    status: "blocked",
    automation: automation({ status: "attention", phase: "creative", lastError: "기획 검토 실패" }),
    artifacts: [artifact("plan-draft-1.json", "json")],
  });
  expect(jobUiState(planning)).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 기획 선택",
  });
  // 기획이 이미 저장된 작업은 기획 선택이 아니라 확인으로 읽힌다
  expect(automationUiState(automation({ status: "attention" }), job()).label).toBe(
    "당신 차례 · 확인",
  );
});

test("a kept script draft reads '대본 초안 수정'", () => {
  const draft = job({
    result: "대본 초안 수정 대기 · 영상 2. 형식 오류 / 길이 오류 응답 원문을 보관했습니다.",
    automation: automation({ status: "waiting", phase: "script" }),
    artifacts: [artifact("video-script-issues-2-1.json", "json")],
  });
  expect(jobUiState(draft)).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 대본 초안 수정",
  });
  expect(jobUiState(draft).detail).toContain("영상 2");
});

test("legacy jobs without automation fall back to job.status", () => {
  expect(jobUiState(job({ status: "running" }))).toMatchObject({
    family: "progress",
    label: "진행 중 · 제작",
  });
  // 새로 만든 작업(queued, 도는 단계 없음)은 시작 전이라 '대기'다
  expect(jobUiState(job({ status: "queued" }))).toMatchObject({ family: "idle", label: "대기" });
  expect(jobUiState(job({ status: "blocked" }))).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 연결 설정",
  });
  expect(jobUiState(job({ status: "review" }))).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 확인",
  });
  expect(jobUiState(job({ status: "completed" }))).toMatchObject({ family: "done", label: "완료" });
  expect(jobUiState(job({ status: "cancelled" }))).toMatchObject({
    family: "stopped",
    label: "멈춤 · 중지함",
  });
  expect(
    jobUiState(
      job({ status: "failed", result: "이미지 모델이 응답하지 않았습니다. 다시 시도하세요." }),
    ),
  ).toMatchObject({ family: "stopped", label: "멈춤 · 이미지 모델이 응답하지 않았습니다" });
  expect(jobUiState(job({ status: "failed", result: null })).label).toBe("멈춤 · 실패");
});

test("an agent in a running legacy job names its stage; agentUiState covers every status", () => {
  const legacy = job({
    status: "running",
    agents: [
      {
        id: "strategy",
        name: "전략",
        status: "completed",
        action: "",
        startedAt: null,
        finishedAt: null,
      },
      {
        id: "creative",
        name: "기획",
        status: "running",
        action: "",
        startedAt: null,
        finishedAt: null,
      },
    ],
  });
  expect(jobUiState(legacy).label).toBe("진행 중 · 광고안");
  expect(agentUiState("idle")).toMatchObject({ family: "idle", label: "대기" });
  expect(agentUiState("running", "정지 이미지").label).toBe("진행 중 · 정지 이미지");
  expect(agentUiState("review").family).toBe("yourTurn");
  expect(agentUiState("failed").family).toBe("stopped");
});

test("ad-operation waiting is just '대기' (not the user's turn)", () => {
  const prepared = job({
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
  });
  expect(jobUiState(prepared)).toMatchObject({ family: "idle", label: "대기" });
});

test("variantUiState ports the VariantStatus rules to the shared vocabulary", () => {
  const plain = job();
  expect(variantUiState(variant({ reviewStatus: "pass" }), plain)).toMatchObject({
    family: "done",
    label: "완료",
  });
  // 검토 통과는 작업 상태보다 앞선다
  const stopped = job({ automation: automation({ status: "stopped" }) });
  expect(variantUiState(variant({ reviewStatus: "pass" }), stopped).family).toBe("done");
  expect(variantUiState(variant(), stopped)).toMatchObject({
    family: "stopped",
    label: "멈춤 · 중지함",
  });
  expect(
    variantUiState(variant(), job({ automation: automation({ status: "attention" }) })),
  ).toMatchObject({ family: "yourTurn", label: "당신 차례 · 확인" });
  expect(
    variantUiState(variant(), job({ automation: automation({ status: "blocked" }) })).label,
  ).toBe("당신 차례 · 연결 설정");
  expect(
    variantUiState(variant(), job({ automation: automation({ status: "waiting" }) })),
  ).toMatchObject({ family: "idle", label: "대기" });
  // 지금 만드는 광고안만 진행 중으로 읽는다
  const current = variant({ id: "v1", reviewStatus: "revise" });
  const other = variant({ id: "v2", reviewStatus: "pending", imageAttempts: 0 });
  const running = (phase: "image" | "review") =>
    ({
      ...job({ automation: automation({ status: "running", phase }) }),
      creativeVariants: [current, other],
    }) as Job;
  expect(variantUiState(current, running("image")).label).toBe("진행 중 · 수정 중");
  expect(variantUiState(current, running("review")).label).toBe("진행 중 · 검토");
  expect(variantUiState(other, running("image")).family).toBe("idle");
  // 자동 제작이 없는 작업
  expect(variantUiState(variant({ reviewStatus: "revise" }), plain).label).toBe(
    "진행 중 · 수정 중",
  );
  expect(variantUiState(variant({ imageAttempts: 0 }), plain).family).toBe("idle");
  expect(variantUiState(undefined, plain)).toMatchObject({ family: "idle", label: "대기" });
});

test("flowClipUiState puts a failed upload ahead of an uploaded one", () => {
  expect(flowClipUiState(true, false)).toMatchObject({ family: "done", label: "완료" });
  expect(flowClipUiState(false, false)).toMatchObject({
    family: "yourTurn",
    label: "당신 차례 · 올리기",
  });
  expect(flowClipUiState(false, true)).toMatchObject({
    family: "stopped",
    label: "멈춤 · 검증 실패",
  });
  expect(flowClipUiState(true, true).family).toBe("stopped");
});

test("stripEnumPrefix removes only the leading enum token", () => {
  expect(stripEnumPrefix("mechanism_explainer | 맛 접촉 경로")).toBe("맛 접촉 경로");
  expect(stripEnumPrefix("맛 접촉 경로")).toBe("맛 접촉 경로");
  expect(stripEnumPrefix("A | B")).toBe("A | B");
});

test("humanizeEventMessage rewrites only what the screen shows", () => {
  expect(humanizeEventMessage("h10 · 카드뉴스 3장 완성")).toBe("광고안 10 · 카드뉴스 3장 완성");
  expect(
    humanizeEventMessage(
      "영상 9 클립 6개를 Flow에서 만들어 업로드해 주세요 (flow-export-9.md 참고)",
    ),
  ).toBe("영상 9 클립 6개를 Flow에서 만들어 업로드해 주세요");
  expect(humanizeEventMessage("BGM 없이 완성합니다(assets/bgm/manifest.json 참고).")).toBe(
    "BGM 없이 완성합니다.",
  );
  expect(humanizeEventMessage("순서는 안내서(FLOW-MODE.md 0절)를 보세요")).toBe(
    "순서는 안내서를 보세요",
  );
  // 건드리지 않는 것: 세그먼트, 단어 속 h+숫자, 숫자 소수점 괄호
  expect(humanizeEventMessage("세그먼트 3개 · hash10 · x")).toBe("세그먼트 3개 · hash10 · x");
  const upload = "영상 1 클립 A Flow 클립 업로드(1번째, 1080x1920, 8.0초)";
  expect(humanizeEventMessage(upload)).toBe(upload);
});

test("firstSentence cuts at a sentence end, drops server suffixes, and caps the length", () => {
  expect(firstSentence("사용자가 자동 운영을 중지했습니다. · 자동 실행 중지")).toBe(
    "사용자가 자동 운영을 중지했습니다",
  );
  expect(firstSentence("첫 줄입니다\n둘째 줄")).toBe("첫 줄입니다");
  expect(firstSentence("영상은 8.0초입니다. 다음 문장")).toBe("영상은 8.0초입니다");
  expect(firstSentence(null)).toBe("");
  expect(firstSentence("가".repeat(100), 10)).toBe(`${"가".repeat(9)}…`);
  expect(firstSentence("h3 · 이미지 수정이 필요합니다.")).toBe(
    "광고안 3 · 이미지 수정이 필요합니다",
  );
});

test("no label or detail leaks file names, digests, commands, or loudness units", () => {
  const jobs = [
    waitingClipsJob(),
    job({
      automation: automation({ status: "waiting", phase: "script" }),
      videoScripts: [renderScript(1, "h1")],
    }),
    job({
      automation: automation({
        status: "attention",
        lastError: "h2 · 실패 (flow-export-2.md 참고)",
      }),
    }),
    job({ automation: automation({ status: "stopped" }) }),
    job({ status: "failed", result: "클립 업로드에 실패했습니다 (flow-export-1.md 참고)" }),
  ];
  for (const item of jobs) {
    const { label, detail } = jobUiState(item);
    expect(`${label} ${detail}`).not.toMatch(
      /digest|CLI|LUFS|bun run|\.md|\.json|\.mp4|flow-export/u,
    );
  }
});
