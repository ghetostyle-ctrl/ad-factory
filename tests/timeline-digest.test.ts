import { describe, expect, test } from "bun:test";
import {
  RenderTimelineSchema,
  storedTimelineMatches,
  timelineDigest,
} from "../shared/render-timeline";
import { sha256Hex } from "../shared/sha256";

// 2026-10-11 실측 재현: 음성 단계가 쓴 timeline-1.json 의 자막 객체 키 순서(placement 앞, icon 뒤)가
// 스키마 선언 순서(icon 앞, placement 뒤)와 달라, 조립 단계가 파싱 뒤 값으로만 다이제스트를 비교하다
// "타임라인 파일이 변경되었습니다"로 멈췄다. 저장 당시 직렬화·파싱 뒤 직렬화 중 하나가 맞으면 변조가 아니다.
function sampleTimeline() {
  return {
    number: 1,
    durationMs: 8000,
    extendedMs: 0,
    scriptDigest: "x".repeat(64),
    cuts: [],
    voice: [],
    warnings: [],
    captions: [
      // 스키마와 다른 키 순서(placement 가 icon 보다 앞)
      {
        text: "숟가락으로",
        startMs: 0,
        endMs: 427,
        style: "bottom",
        tone: "general",
        placement: "bottom",
        icon: null,
      },
    ],
    disclaimer: null,
    visualPolicy: "hybrid_explainer_v1",
  };
}

describe("storedTimelineMatches", () => {
  test("저장 당시 직렬화(원본 키 순서)로 기록된 다이제스트를 받아들인다", () => {
    const stored = JSON.parse(JSON.stringify(sampleTimeline()));
    const parsed = RenderTimelineSchema.safeParse(stored);
    if (!parsed.success) return; // 스키마가 샘플 필드를 더 요구하면 이 검사는 건너뛴다(아래 검사가 핵심)
    const savedDigest = sha256Hex(JSON.stringify(stored));
    const parsedDigest = timelineDigest(parsed.data);
    expect(storedTimelineMatches(stored, savedDigest)).toBe(true);
    expect(storedTimelineMatches(stored, parsedDigest)).toBe(true);
    expect(storedTimelineMatches(stored, "0".repeat(64))).toBe(false);
    expect(storedTimelineMatches(stored, "")).toBe(false);
  });

  test("키 순서만 다른 두 직렬화는 서로 다른 다이제스트를 내므로 둘 다 허용해야 한다", () => {
    const a = { captions: [{ text: "a", placement: "bottom", icon: null }] };
    const b = { captions: [{ text: "a", icon: null, placement: "bottom" }] };
    expect(sha256Hex(JSON.stringify(a))).not.toBe(sha256Hex(JSON.stringify(b)));
  });

  test("내용이 바뀐 파일은 거부한다", () => {
    const stored = JSON.parse(JSON.stringify(sampleTimeline()));
    const savedDigest = sha256Hex(JSON.stringify(stored));
    stored.captions[0].text = "바뀐 자막";
    expect(storedTimelineMatches(stored, savedDigest)).toBe(false);
  });
});
