import { expect, test } from "bun:test";
import {
  bigramChangeRate,
  guardCopyEdit,
  injectedNumbers,
  KOREAN_COPY_POLISH_RULES,
} from "../shared/copy-polish";
import type { VideoCopyEditingResponse, VideoPlanningDraft } from "../shared/video-planning";
import { fixtureVideoPlanning } from "./video-planning-fixture";

function draftOf(): VideoPlanningDraft {
  const { copyReview: _review, ...draft } = fixtureVideoPlanning();
  return draft;
}

function editOf(
  draft: VideoPlanningDraft,
  changes: readonly { lineIndex: number; field: "narration" | "screenText"; after: string }[],
): VideoCopyEditingResponse {
  const lines = draft.copy.lines.map((line) => ({ ...line }));
  const edits = changes.map((change) => {
    const line = lines[change.lineIndex];
    if (!line) throw new Error("line");
    const key = change.field === "narration" ? "text" : "screenText";
    const before = line[key];
    line[key] = change.after;
    return { ...change, before, reason: "테스트 수정" };
  });
  return {
    lines,
    review: { status: edits.length > 0 ? "revised" : "pass", summary: "검토 요약", edits },
  };
}

test("bigram change rate separates a light edit from a rewrite", () => {
  const before = "오백밀리리터의 수용이 가능합니다.";
  expect(bigramChangeRate(before, before)).toBe(0);
  expect(bigramChangeRate(before, "오백밀리리터를 담을 수 있어요.")).toBeLessThan(0.7);
  expect(bigramChangeRate(before, "출근길에 딱 맞는 크기예요.")).toBeGreaterThan(0.9);
  expect(bigramChangeRate("", "")).toBe(0);
});

test("injected numbers ignore numbers the draft already shows", () => {
  expect(injectedNumbers("용량 500mL, 1,000원", "500mL에 1000원")).toEqual([]);
  expect(injectedNumbers("용량 500mL", "500mL, 24시간 보냉")).toEqual(["24"]);
});

test("an edit that adds a number absent from the draft is reverted and dropped from the record", () => {
  const draft = draftOf();
  const edited = editOf(draft, [
    { lineIndex: 0, field: "narration", after: "가방은 다 챙겼는데 텀블러는 어디에 넣으세요?" },
    { lineIndex: 1, field: "screenText", after: "24시간 보냉" },
  ]);
  const guarded = guardCopyEdit(draft, edited);
  expect(guarded.lines[1]?.screenText).toBe(draft.copy.lines[1]?.screenText ?? "");
  expect(guarded.lines[0]?.text).toBe("가방은 다 챙겼는데 텀블러는 어디에 넣으세요?");
  expect(guarded.review.edits).toHaveLength(1);
  expect(guarded.review.status).toBe("revised");
  expect(guarded.review.summary).toContain("숫자가 들어간 수정 1건");
});

test("reverting the only edit leaves an honest pass record", () => {
  const draft = draftOf();
  const guarded = guardCopyEdit(
    draft,
    editOf(draft, [{ lineIndex: 3, field: "narration", after: "지금 30% 할인 중이에요." }]),
  );
  expect(guarded.lines).toEqual(draft.copy.lines);
  expect(guarded.review.status).toBe("pass");
  expect(guarded.review.edits).toEqual([]);
});

test("a number moved from the screen text into narration is kept", () => {
  const draft = draftOf();
  const edited = editOf(draft, [
    { lineIndex: 2, field: "narration", after: "500밀리리터를 담을 수 있어요." },
  ]);
  expect(guardCopyEdit(draft, edited)).toEqual(edited);
});

test("a wholesale narration rewrite is kept but flagged in the summary", () => {
  const draft = draftOf();
  const edited = editOf(
    draft,
    draft.copy.lines.map((_line, lineIndex) => ({
      lineIndex,
      field: "narration" as const,
      after: [
        "아침마다 손이 모자라죠.",
        "한 손으로 열려요.",
        "넉넉하게 들어가요.",
        "상세 정보를 보세요.",
      ][lineIndex] as string,
    })),
  );
  const guarded = guardCopyEdit(draft, edited);
  expect(guarded.lines).toEqual(edited.lines);
  expect(guarded.review.edits).toHaveLength(4);
  expect(guarded.review.summary).toContain("%가 바뀌었습니다");
});

test("untouched and light edits pass through unchanged", () => {
  const draft = draftOf();
  const light = editOf(draft, [
    { lineIndex: 1, field: "narration", after: "먼저 뚜껑을 여닫는 모습부터 살펴보세요." },
  ]);
  expect(guardCopyEdit(draft, light)).toBe(light);
  const none = editOf(draft, []);
  expect(guardCopyEdit(draft, none)).toBe(none);
});

test("the rulebook is a post-editing guide with meaning guards", () => {
  expect(KOREAN_COPY_POLISH_RULES).toContain("post-editing only");
  expect(KOREAN_COPY_POLISH_RULES).toContain("never treat them as bans");
  expect(KOREAN_COPY_POLISH_RULES).toContain("GUARDS");
  expect(KOREAN_COPY_POLISH_RULES).toContain("im-not-ai");
});
