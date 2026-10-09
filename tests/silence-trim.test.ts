import { expect, test } from "bun:test";
import { buildTimeline, SILENCE_TRIM_MIN_CUT_MS, silenceTrim } from "../shared/render-timeline";
import { renderScript } from "./render-fixture";

// 말이 끝난 뒤 남는 컷 시간 줄이기(2026-10-06): 실전 영상 3은 정수 초 컷 때문에 39초 중 약 9초가 무음이었다.
const cut = (startSec: number, endSec: number) => ({ startSec, endSec });
const line = (fromCut: number, toCut: number) => ({ fromCut, toCut, startSec: 0, endSec: 0 });
type Input = Parameters<typeof silenceTrim>[0];
const script = (cuts: [number, number][], lines: [number, number][]) =>
  ({
    cuts: cuts.map(([a, b]) => cut(a, b)),
    voiceover: lines.map(([a, b]) => line(a, b)),
  }) as unknown as Input;
const measured = (...ms: number[]) =>
  new Map(ms.map((durationMs, index) => [index, { durationMs }]));

test("the last cut of a sentence ends 300ms after the speech", () => {
  // 컷 0~9초(9초) + 9~40초. 문장 0은 5.3초.
  const trim = silenceTrim(
    script(
      [
        [0, 9],
        [9, 40],
      ],
      [
        [0, 0],
        [1, 1],
      ],
    ),
    measured(5300, 20000),
    150,
    300,
  );
  expect(trim[0]).toBe(9000 - 5600);
  // 두 번째 컷은 10.7초를 줄일 수 있지만 전체 30초 하한 때문에 남은 예산 6.6초만 줄인다.
  expect(trim[1]).toBe(40000 - 30000 - 3400);
});

test("never shorter than one second per cut or thirty seconds in total", () => {
  const trim = silenceTrim(
    script(
      [
        [0, 4],
        [4, 8],
        [8, 40],
      ],
      [
        [0, 1],
        [2, 2],
      ],
    ),
    measured(500, 1000),
    150,
    300,
  );
  expect(4000 - (trim[1] ?? 0)).toBeGreaterThanOrEqual(SILENCE_TRIM_MIN_CUT_MS);
  const total = 40000 - trim.reduce((sum, value) => sum + value, 0);
  expect(total).toBe(30000);
});

test("silent cuts between sentences shrink to the one-second floor toward the 500ms gap cap", () => {
  // 컷 0(3초, 문장 0 = 1초) · 컷 1(4초, 말 없음) · 컷 2(33초, 문장 1 = 2초). 예전에는 범위 밖의 컷 1 이 4초 그대로 남았다.
  const trim = silenceTrim(
    script(
      [
        [0, 3],
        [3, 7],
        [7, 40],
      ],
      [
        [0, 0],
        [2, 2],
      ],
    ),
    measured(1000, 2000),
    150,
    300,
  );
  expect(trim[0]).toBe(3000 - 1300);
  expect(trim[1]).toBe(4000 - SILENCE_TRIM_MIN_CUT_MS);
  // 문장 1 은 컷 2 시작(1300 + 1000)에서 시작한다: 무음은 꼬리 0.3초 + 말 없는 컷 하한 1초
  expect(3000 - (trim[0] ?? 0) + 4000 - (trim[1] ?? 0)).toBe(2300);
  expect(40000 - trim.reduce((sum, value) => sum + value, 0)).toBe(30000);
});

test("live Veo cuts end 300ms after their speech even when explanation clips are read from the start", () => {
  // 예전 immersive 면제(모든 veo 컷 보존)는 풀었다(2026-10-07 H6): 실사 컷 A(6초, 말 2초)는 3.7초를 줄인다.
  const trim = silenceTrim(
    {
      cuts: [
        { ...cut(0, 6), source: "veo_clip", veoClip: "A", phase: "" },
        { ...cut(6, 40), source: "approved_image", veoClip: "", phase: "" },
      ],
      voiceover: [line(0, 0), line(1, 1)],
    } as unknown as Input,
    measured(2000, 20000),
    150,
    300,
    true,
  );
  expect(trim[0]).toBe(6000 - 2300);
});

test("scripts saved before cut ranges are left alone", () => {
  const trim = silenceTrim(
    script(
      [
        [0, 9],
        [9, 40],
      ],
      [[-1, -1]],
    ),
    measured(1000),
    150,
    300,
  );
  expect(trim).toEqual([0, 0]);
});

test("buildTimeline trims only when asked and never creates overflow", () => {
  const base = renderScript(1, "concept-1", 36);
  const short = base.voiceover.map((_, index) => ({ index, durationMs: 400, tempo: 1 }));
  const plain = buildTimeline(base, short);
  const trimmed = buildTimeline(base, short, { trimSilence: true });
  if (!("timeline" in plain) || !("timeline" in trimmed)) throw new Error("timeline expected");
  expect(plain.timeline.durationMs).toBe(36000);
  expect(trimmed.timeline.durationMs).toBe(30000);
  expect(trimmed.timeline.extendedMs).toBe(0);
  for (const voice of trimmed.timeline.voice) {
    const owner = trimmed.timeline.cuts.find(
      (item) => item.startMs <= voice.startMs && voice.startMs < item.endMs,
    );
    expect(owner).toBeDefined();
  }
});
