import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type InstructionsStatus, InstructionsStatusSchema } from "../shared/instructions-status";
import { InstructionsCardView } from "../src/InstructionsCard";

// 연결 설정 창의 '지시 파일' 읽기 전용 카드(D6): 파일 목록·해시 앞 8자리·마지막 로드·경고·임계값을 그린다.
const digest = "a".repeat(32) + "b".repeat(32);
const fileDigest = "0123456789abcdef".repeat(4);
const status: InstructionsStatus = InstructionsStatusSchema.parse({
  folder: "instructions",
  loaded: true,
  digest,
  loadedAt: "2026-10-07T03:04:05.000Z",
  checkedAt: "2026-10-07T03:10:00.000Z",
  files: [
    {
      name: "thresholds.json",
      digest: fileDigest,
      size: 2048,
      modifiedAt: "2026-10-07T03:00:00.000Z",
    },
    { name: "script.md", digest: fileDigest, size: 500, modifiedAt: "2026-10-07T03:00:00.000Z" },
  ],
  sections: [
    { file: "script.md", key: "SCRIPT_OPENING", chars: 40, runtime: ["seconds"] },
    { file: "script.md", key: "SCRIPT_SHAPE", chars: 120 },
  ],
  thresholds: { COPY_BEAT_TARGET_CHARS: 26, CUT_MAX_SEC: 5 },
  thresholdDetails: {
    COPY_BEAT_TARGET_CHARS: { value: 26, min: 10, max: 60, description: "한 문장 목표 글자 수" },
  },
  warnings: [],
});
const render = (props: Partial<Parameters<typeof InstructionsCardView>[0]>) =>
  renderToStaticMarkup(
    <InstructionsCardView
      status={status}
      error={null}
      pending={false}
      onRefresh={() => undefined}
      {...props}
    />,
  );

test("a healthy status shows files, short digests, counts and the thresholds list", () => {
  const output = render({});
  expect(output).toContain("정상");
  expect(output).toContain(digest.slice(0, 8));
  expect(output).toContain(digest);
  expect(output).toContain("thresholds.json");
  expect(output).toContain("script.md");
  expect(output).toContain(fileDigest.slice(0, 8));
  expect(output).toContain("절 2개");
  expect(output).toContain("임계값 2개");
  expect(output).toContain("COPY_BEAT_TARGET_CHARS");
  expect(output).toContain("CUT_MAX_SEC");
  // 허용 범위·설명이 있는 임계값은 "값 (min–max) — 설명" 으로
  expect(output).toContain("(10–60)");
  expect(output).toContain("한 문장 목표 글자 수");
  expect(output).toContain("2.0KB");
  expect(output).toContain("다시 확인");
  // 절 본문은 상태에 없으므로 화면에도 없다; 경고 알림도 없다
  expect(output).not.toContain("notice-warning");
  expect(output).not.toContain("notice-error");
});

test("a warning keeps the last good digest visible and renders the reason as a status notice", () => {
  const warning =
    "지시 파일을 다시 읽지 못해 마지막 성공본(aaaaaaaa, …)을 그대로 씁니다: script.md: 절 SCRIPT_OPENING 이 없습니다.";
  const output = render({ status: { ...status, warnings: [warning] } });
  expect(output).toContain("마지막 성공본 사용 중");
  expect(output).toContain("notice-warning");
  expect(output).toContain('role="status"');
  expect(output).toContain("SCRIPT_OPENING 이 없습니다");
  expect(output).toContain(digest.slice(0, 8));
});

test("a failed first load renders an alert, no digest and whatever files exist", () => {
  const output = render({
    status: {
      ...status,
      loaded: false,
      digest: null,
      loadedAt: null,
      sections: [],
      thresholds: {},
      files: [status.files[0] as InstructionsStatus["files"][number]],
      warnings: ["hybrid.md: 읽을 수 없습니다 — ENOENT"],
    },
  });
  expect(output).toContain("읽기 실패");
  expect(output).toContain('role="alert"');
  expect(output).toContain("hybrid.md: 읽을 수 없습니다");
  expect(output).toContain("thresholds.json");
  expect(output).not.toContain("script.md");
  expect(output).not.toContain("임계값 0개 보기");
});

test("loading and request errors are textual", () => {
  expect(render({ status: null, pending: true })).toContain("읽는 중");
  const failed = render({ status: null, error: "요청을 완료하지 못했습니다. (503)" });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("요청을 완료하지 못했습니다. (503)");
});
