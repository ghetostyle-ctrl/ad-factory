import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { MissingConnectionError, StudioError } from "../server/errors";
import { snapshotModels } from "../server/model-settings";
import { generateVoiceResult, getSubscription, normalizeNarration } from "../server/tts-provider";
import { ttsVoicePresets } from "../shared/models";
import { providerStore } from "./provider-fixtures";
import { typecastFixture } from "./typecast-fixture";

// 실 Typecast 호출 0회. 로컬 픽스처 + ffprobe 교차검증(ffprobe 없으면 건너뜀).
const hasFfprobe = Boolean(Bun.which("ffprobe"));
if (!hasFfprobe) console.log("미검증: ffprobe 가 없어 Typecast 공급자 테스트를 건너뜁니다.");
let fixture: ReturnType<typeof typecastFixture>;
let store: ReturnType<typeof providerStore>;
beforeEach(() => {
  fixture = typecastFixture();
  store = providerStore();
});
afterEach(() => {
  fixture.close();
  store.close();
  // providerStore 가 만든 임시 폴더(SQLite·모델 설정)를 남기지 않는다.
  rmSync(store.root, { recursive: true, force: true });
});
const task = (overrides: Partial<Parameters<typeof generateVoiceResult>[0]> = {}) => ({
  text: "하루 한 번, 600mg 으로 충분합니다.",
  previousText: "앞 문장",
  nextText: "뒤 문장",
  voiceId: ttsVoicePresets[0].id,
  tempo: 1.1,
  signal: new AbortController().signal,
  models: snapshotModels(store.root),
  ...overrides,
});

test("normalizeNarration strips emoji and control characters and collapses spaces", () => {
  expect(normalizeNarration("  하루  한 번 🎉\n600mg\t입니다 ")).toBe("하루 한 번 600mg 입니다");
});

test("missing Typecast key throws MissingConnectionError before any request", async () => {
  await expect(
    generateVoiceResult(task(), { ...fixture.connection, apiKey: "" }),
  ).rejects.toBeInstanceOf(MissingConnectionError);
  expect(fixture.requests).toHaveLength(0);
});

test.skipIf(!hasFfprobe)(
  "sends the with-timestamps wire shape (granularity query, X-API-KEY, body) and returns measured audio",
  async () => {
    const result = await generateVoiceResult(task(), fixture.connection);
    const request = fixture.synthesisRequests()[0];
    expect(request?.query).toBe("?granularity=word");
    expect(request?.headers["x-api-key"]).toBe("local-fixture-only");
    expect(request?.body).toEqual({
      voice_id: ttsVoicePresets[0].id,
      text: "하루 한 번, 600mg 으로 충분합니다.",
      model: "ssfm-v30",
      language: "kor",
      prompt: { emotion_type: "smart", previous_text: "앞 문장", next_text: "뒤 문장" },
      output: { audio_format: "wav", audio_tempo: 1.1, target_lufs: -16 },
    });
    expect(result.model).toEqual({
      provider: "typecast",
      requestedModel: "ssfm-v30",
      effectiveModel: "ssfm-v30",
      quality: null,
    });
    expect(String.fromCharCode(...result.value.audio.slice(0, 4))).toBe("RIFF");
    // 글자 수/5.5/템포 초 ≈ 실측 길이
    const expected = Math.round(
      ([..."하루 한 번, 600mg 으로 충분합니다."].length / 5.5 / 1.1) * 1000,
    );
    expect(Math.abs(result.value.durationMs - expected)).toBeLessThanOrEqual(60);
    expect(result.value.words.length).toBeGreaterThan(0);
  },
);

test.skipIf(!hasFfprobe)("maps 401/402/422 to connection, credit and text errors", async () => {
  fixture.control.status = 401;
  await expect(generateVoiceResult(task(), fixture.connection)).rejects.toBeInstanceOf(
    MissingConnectionError,
  );
  fixture.control.status = 402;
  await expect(generateVoiceResult(task(), fixture.connection)).rejects.toMatchObject({
    code: "typecast_credit",
  });
  fixture.control.status = 422;
  await expect(generateVoiceResult(task(), fixture.connection)).rejects.toMatchObject({
    code: "typecast_text",
  });
  fixture.control.status = 429;
  await expect(generateVoiceResult(task(), fixture.connection)).rejects.toMatchObject({
    code: "typecast_rate",
  });
  // 공급자 함수 자체는 재시도하지 않는다(백오프는 호출부)
  expect(fixture.synthesisRequests()).toHaveLength(4);
});

test.skipIf(!hasFfprobe)("rejects a non-WAV payload without re-requesting", async () => {
  fixture.control.corruptAudio = true;
  const failure = generateVoiceResult(task(), fixture.connection);
  await expect(failure).rejects.toBeInstanceOf(StudioError);
  await expect(failure).rejects.toMatchObject({ code: "typecast_format" });
  expect(fixture.synthesisRequests()).toHaveLength(1);
});

test.skipIf(!hasFfprobe)(
  "accepts a multi-second WAV and rejects a mismatched declared duration",
  async () => {
    fixture.control.durationByIndex.set(0, 3.4);
    const ok = await generateVoiceResult(task({ tempo: 1 }), fixture.connection);
    expect(Math.abs(ok.value.durationMs - 3400)).toBeLessThanOrEqual(50);
    expect(ok.value.audio.length).toBeGreaterThan(290_000);
    fixture.control.declaredOffsetSec = 0.4;
    await expect(generateVoiceResult(task({ tempo: 1 }), fixture.connection)).rejects.toMatchObject(
      {
        code: "typecast_duration",
      },
    );
  },
);

test("getSubscription parses plan, credits and concurrency", async () => {
  fixture.control.plan = "free";
  fixture.control.planCredits = 15000;
  fixture.control.usedCredits = 120;
  fixture.control.concurrencyLimit = 2;
  expect(await getSubscription(fixture.connection)).toEqual({
    plan: "free",
    planCredits: 15000,
    usedCredits: 120,
    concurrencyLimit: 2,
  });
  await expect(getSubscription({ ...fixture.connection, apiKey: "" })).rejects.toBeInstanceOf(
    MissingConnectionError,
  );
});

test("tempo outside the supported range is rejected before a paid request", async () => {
  await expect(
    generateVoiceResult(task({ tempo: 1.31 }), fixture.connection),
  ).rejects.toMatchObject({ code: "typecast_tempo" });
  expect(fixture.requests).toHaveLength(0);
});
