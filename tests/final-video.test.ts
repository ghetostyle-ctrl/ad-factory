import { expect, test } from "bun:test";
import { finalVoices, renderStage } from "../src/FinalVideo";

const audio = (name: string) => ({ kind: "audio", name });

test("voice list keeps only the latest attempt per sentence of the requested video", () => {
  const artifacts = [
    audio("voice-1-01-1.wav"),
    audio("voice-1-02-1.wav"),
    audio("voice-1-02-2.wav"),
    audio("voice-1-03-1.wav"),
    audio("voice-2-01-1.wav"),
    { kind: "json", name: "voice-1.json" },
    { kind: "image", name: "voice-1-04-1.wav" },
  ];
  expect(finalVoices(artifacts, 1).map((item) => item.name)).toEqual([
    "voice-1-01-1.wav",
    "voice-1-02-2.wav",
    "voice-1-03-1.wav",
  ]);
  expect(finalVoices(artifacts, 2).map((item) => item.name)).toEqual(["voice-2-01-1.wav"]);
  expect(finalVoices([], 1)).toEqual([]);
});

test("the finished stage label does not repeat the 완성 영상 prefix", () => {
  expect(renderStage(undefined, 2)).toBe("제작 대기");
  const finished = { final: { name: "video-final-1.mp4", durationMs: 1000 } };
  // 대본 카드 머리글은 "완성 영상 " + 상태 라벨 이므로 라벨이 "완성"이면 중복된다.
  expect(renderStage(finished as never, 2)).not.toContain("완성");
});
