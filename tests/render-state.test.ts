import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptDigest } from "../server/render-state-helpers";
import { JobStore } from "../server/store";
import { AutomationPolicySchema, AutomationStateSchema } from "../shared/automation";
import { ArtifactModelSchema } from "../shared/models";
import {
  emptyRenderState,
  RenderStateSchema,
  StoredVideoScriptReviewSchema,
} from "../shared/render-state";
import { ArtifactSchema, ConfigStatusSchema, CreateJobSchema, JobSchema } from "../shared/schema";
import { sha256Hex } from "../shared/sha256";
import { VEO_CLIP_MS, VideoScriptSchema, voiceoverChars } from "../shared/video-script";
import { renderScript } from "./render-fixture";

test("jobs stored before renders existed still parse and get an empty renders array", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "studio-render-state-"));
  try {
    const store = new JobStore(root);
    const job = store.create(
      CreateJobSchema.parse({
        name: "Legacy fixture",
        productUrl: "https://example.com",
        productDescription: "A factual product description for a fixture.",
        audience: "Adult shoppers",
      }),
    );
    expect(job.renders).toEqual([]);
    const legacy = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
    delete legacy["renders"];
    // When / Then
    expect(JobSchema.parse(legacy).renders).toEqual([]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("render state defaults every optional field so partial records stay readable", () => {
  const state = RenderStateSchema.parse({ number: 2 });
  expect(state).toEqual({
    number: 2,
    scriptDigest: null,
    scriptApproval: null,
    scriptReview: null,
    voice: null,
    voiceLines: [],
    startImages: {},
    stills: {},
    clips: {},
    infoImages: {},
    final: null,
  });
  expect(emptyRenderState(3, "abc").scriptDigest).toBe("abc");
  const partial = RenderStateSchema.parse({
    number: 1,
    startImages: { A: { name: "start-1-A-1.png", digest: "d" } },
    clips: {
      B: {
        operation: {
          name: "operations/x",
          startedAt: "2026-10-03T00:00:00.000Z",
          model: "veo-3.1-generate-preview",
        },
      },
    },
  });
  expect(partial.startImages["A"]).toEqual({
    name: "start-1-A-1.png",
    digest: "d",
    attempts: 0,
    status: "pass",
  });
  // 정지 이미지 기록은 시작 이미지와 같은 형식이고, S1..S14 만 키로 받는다.
  const withStills = RenderStateSchema.parse({
    number: 1,
    stills: { S3: { name: "still-1-S3-1.png", digest: "e" } },
  });
  expect(withStills.stills["S3"]).toEqual({
    name: "still-1-S3-1.png",
    digest: "e",
    attempts: 0,
    status: "pass",
  });
  expect(RenderStateSchema.safeParse({ number: 1, stills: { S15: {} } }).success).toBe(false);
  expect(partial.clips["B"]?.name).toBeNull();
  expect(partial.clips["B"]?.pendingSince).toBeNull();
  expect(RenderStateSchema.safeParse({ number: 1, clips: { Z: {} } }).success).toBe(false);
  expect(RenderStateSchema.safeParse({ number: 11 }).success).toBe(false);
});

test("config status, artifact kinds, providers, phases and policy knobs accept the new values", () => {
  const config = ConfigStatusSchema.parse({
    openai: true,
    gemini: false,
    codex: false,
    meta: false,
    typecast: false,
    textProvider: "openai",
    imageModel: "gpt-image-2",
    textModel: "gpt-5-mini",
    metaVersion: "v26.0",
    modelSettings: {
      textProvider: "auto",
      textModel: "gpt-5-mini",
      codexModel: null,
      imageModel: "gpt-image-2",
      imageQuality: "medium",
      ttsProvider: "typecast",
      ttsSelection: "auto",
      ttsVoiceId: null,
      ttsTempo: 1,
    },
  });
  expect(config.ffmpeg).toBe(false);
  expect(config.captionFont).toBe(false);
  expect(
    ArtifactSchema.parse({
      id: "a",
      name: "voice-1-00-1.wav",
      kind: "audio",
      url: "/api/artifacts/j/voice-1-00-1.wav",
      agentId: "production",
      model: {
        provider: "typecast",
        requestedModel: "ssfm-v30",
        effectiveModel: "ssfm-v30",
        quality: null,
      },
    }).kind,
  ).toBe("audio");
  expect(
    ArtifactModelSchema.parse({
      provider: "ffmpeg",
      requestedModel: "ffmpeg-8.1",
      effectiveModel: null,
      quality: null,
    }).provider,
  ).toBe("ffmpeg");
  for (const phase of ["voice", "stills", "startImages", "clips", "graphics", "assemble", "video"])
    expect(AutomationStateSchema.shape.phase.safeParse(phase).success).toBe(true);
  const policy = AutomationPolicySchema.parse({
    mode: "creative",
    videoCount: 1,
    videoResolution: "1080p",
    bgm: { mode: "track", trackId: "calm-01" },
    clipReview: false,
  });
  expect(policy).toMatchObject({
    videoResolution: "1080p",
    bgm: { mode: "track", trackId: "calm-01" },
  });
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", bgm: { mode: "track" } }).success,
  ).toBe(false);
  expect(
    AutomationPolicySchema.safeParse({ mode: "creative", videoResolution: "4k" }).success,
  ).toBe(false);
  expect(AutomationPolicySchema.parse({ mode: "creative" })).toEqual({ mode: "creative" });
});

test("shared sha256 matches node:crypto and script helpers count narration characters", () => {
  for (const input of [
    "",
    "abc",
    "한국어 내레이션 테스트",
    "x".repeat(55),
    "y".repeat(64),
    "z".repeat(1000),
  ])
    expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
  expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
    createHash("sha256")
      .update(new Uint8Array([1, 2, 3]))
      .digest("hex"),
  );
  expect(VEO_CLIP_MS).toBe(8000);
  const script = renderScript(1, "concept-1", 36);
  expect(voiceoverChars(script)).toBe(36 * 5);
  expect(voiceoverChars({ voiceover: [] })).toBe(0);
});

test("a script saved before still images existed keeps its digest so synthesized narration stays valid", () => {
  // 정지 이미지 소스 이전 저장 형식(키 순서 포함). 파싱하면 stills·stillId 기본값이 붙지만 다이제스트는 그대로여야 한다.
  const legacy = {
    number: 1,
    hypothesisId: "concept-1",
    title: "예전 대본",
    durationSec: 40,
    openLoop: "왜 실패할까?",
    payoffSec: 30,
    cuts: [
      {
        startSec: 0,
        endSec: 2,
        purpose: "hook",
        screenComposition: "첫 장면",
        onScreenText: "",
        source: "veo_clip",
        effect: "hard_cut",
        veoClip: "A",
        graphicKind: "",
        graphicLines: [],
        narration: "안녕하세요",
        veoPrompt: "Motion A.",
      },
      {
        startSec: 2,
        endSec: 40,
        purpose: "cta",
        screenComposition: "마지막",
        onScreenText: "",
        source: "approved_image",
        effect: "hard_cut",
        veoClip: "",
        graphicKind: "",
        graphicLines: [],
        narration: "",
        veoPrompt: "",
      },
    ],
    voiceover: [{ startSec: 0, endSec: 3, text: "안녕하세요" }],
    styleAnchor: "Same woman.",
    veoClips: [{ id: "A", startImagePrompt: "Start A.", prompt: "Motion A." }],
    flowPrompt: "Flow",
    editInstructions: "편집",
  };
  const parsed = VideoScriptSchema.parse(legacy);
  expect(parsed.stills).toEqual([]);
  expect(scriptDigest(parsed)).toBe(sha256Hex(JSON.stringify(legacy)));
  // 정지 이미지를 쓰는 새 대본은 다른 다이제스트를 가진다
  const withStill = VideoScriptSchema.parse({
    ...legacy,
    stills: [{ id: "S1", prompt: "A kitchen counter, photographic." }],
    cuts: legacy.cuts.map((cut, index) =>
      index === 1 ? { ...cut, source: "still_image", stillId: "S1" } : cut,
    ),
  });
  expect(scriptDigest(withStill)).not.toBe(scriptDigest(parsed));
});

test("a script review stored before repairs existed parses with empty repair fields and zero generations", () => {
  // 2026-10-04 이전 기록: {attempt, status, summary, issues, accepted} 만 있다
  const legacy = StoredVideoScriptReviewSchema.parse({
    attempt: 2,
    status: "pass",
    summary: "통과",
    issues: [{ sentenceIndex: 0, problem: "p", fix: "f" }],
    accepted: "forced",
  });
  expect(legacy).toMatchObject({
    attempt: 2,
    accepted: "forced",
    repairs: [],
    warnings: [],
    hardProblems: [],
    generations: 0,
  });
  expect(legacy.issues[0]?.cutIndexes).toEqual([]);
  // 새 기록: needsFix 초안은 검토 없이(attempt 0) 저장될 수 있다
  expect(
    StoredVideoScriptReviewSchema.parse({
      attempt: 0,
      status: "revise",
      summary: "규칙 미통과",
      issues: [],
      accepted: "needsFix",
      hardProblems: ["영문"],
      generations: 3,
    }),
  ).toMatchObject({ accepted: "needsFix", hardProblems: ["영문"], generations: 3 });
  expect(
    StoredVideoScriptReviewSchema.safeParse({
      attempt: 1,
      status: "pass",
      summary: "",
      issues: [],
      accepted: "maybe",
    }).success,
  ).toBe(false);
  // renders 안에서도 같은 기본값으로 읽힌다
  const state = RenderStateSchema.parse({
    number: 1,
    scriptReview: { attempt: 1, status: "pass", summary: "ok", issues: [] },
  });
  expect(state.scriptReview).toMatchObject({ accepted: "pass", repairs: [], generations: 0 });
});
