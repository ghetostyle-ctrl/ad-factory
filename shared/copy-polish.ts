import { DEFAULT_THRESHOLDS, thresholds } from "./thresholds";
import type { VideoCopyEditingResponse, VideoPlanningDraft } from "./video-planning";

// 카피 교정 결과의 코드 판정(guardCopyEdit)과 리듬 상수. 한국어 AI 말투 규칙(KOREAN_COPY_POLISH_RULES)·리듬 규칙(legacy_rhythm·
// natural_v1) 본문은 2026-10-07 부터 instructions/copy.md 에 있고 서버(server/copy-instructions.ts)만 조립한다 — 이 모듈은 브라우저
// 번들이라 지시 파일을 읽을 수 없고 규칙 글을 갖지 않는다. 규칙의 출처: epoko77-ai/im-not-ai(MIT, https://github.com/epoko77-ai/im-not-ai)
// quick-rules 에서 짧은 구어체 광고 카피 항목만 골랐고, 다 쓴 글을 고치는 단계(카피 교정·대본 검토)에만 넣는다.

// 기본값(분리 전 상수). 규칙 검사는 thresholds()(instructions/thresholds.json 주입값)를 호출 때 읽는다 — shared/thresholds.ts.
export const COPY_BEAT_TARGET_CHARS = DEFAULT_THRESHOLDS.COPY_BEAT_TARGET_CHARS;
export const COPY_BEAT_MAX_CHARS = DEFAULT_THRESHOLDS.COPY_BEAT_MAX_CHARS;
// 카피 리듬(사용자 결정 2026-10-06): 한 문장 = 한 호흡, 26자 목표·40자 한도. 대본 soft 경고(shared/script-rules.ts)가 쓴다.
// 설명 꼬리: 광고 말맛을 빼는 서술 끝. 경고만 남긴다(사실 고지가 필요한 문장도 있다).
export const EXPLANATORY_TAIL =
  /(할 수 있어요|할 수 있습니다|라는 뜻은 아니에요|되어 있습니다|되어 있어요|표기되어|명시되어|권장하고 있어요)/u;

const DIGITS = /\d+(?:[.,]\d+)*/g;
const LATIN = /[A-Za-z]/;

function digitGroups(text: string): string[] {
  return (text.match(DIGITS) ?? []).map((group) => group.replaceAll(",", ""));
}

function bigrams(text: string): Map<string, number> {
  const chars = [...text.replace(/\s+/g, "")];
  const counts = new Map<string, number>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const pair = `${chars[index]}${chars[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** 글자 bigram 기준 변경률(0~1). 한국어는 어절 단위로 세면 가벼운 수정도 크게 잡힌다. */
export function bigramChangeRate(before: string, after: string): number {
  const left = bigrams(before);
  const right = bigrams(after);
  let total = 0;
  let shared = 0;
  for (const count of left.values()) total += count;
  for (const [pair, count] of right) {
    total += count;
    shared += Math.min(count, left.get(pair) ?? 0);
  }
  return total === 0 ? (before === after ? 0 : 1) : 1 - (2 * shared) / total;
}

/** text 에 있지만 source 어디에도 없는 숫자 묶음. */
export function injectedNumbers(source: string, text: string): string[] {
  const known = new Set(digitGroups(source));
  return [...new Set(digitGroups(text).filter((group) => !known.has(group)))];
}

export const COPY_CHANGE_WARNING_RATE = DEFAULT_THRESHOLDS.COPY_CHANGE_WARNING_RATE;

/**
 * 카피 교정 결과를 코드로 판정한다. 고치지는 않고 되돌리기만 한다.
 * - 초안 카피 어디에도 없던 숫자가 들어간 수정은 그 칸을 교정 전으로 되돌리고 수정 기록에서 뺀다.
 * - 내레이션 전체가 절반 넘게 바뀌면 요약에 경고를 남긴다(짧은 광고 문장은 정당한 수정도 변경률이
 *   높아서 되돌리지 않는다. 사용자가 수정 이력과 대본 승인에서 확인한다).
 */
export function guardCopyEdit(
  draft: VideoPlanningDraft,
  edited: VideoCopyEditingResponse,
): VideoCopyEditingResponse {
  if (draft.copy.lines.length !== edited.lines.length) return edited;
  const source = draft.copy.lines.map((line) => `${line.text} ${line.screenText}`).join(" ");
  const reverted = new Set<string>();
  const lines = edited.lines.map((line, lineIndex) => {
    const original = draft.copy.lines[lineIndex];
    if (!original) return line;
    const kept = { ...line };
    for (const key of ["text", "screenText"] as const) {
      // 낭독 규칙이 내레이션 영문을 막으므로 "600밀리그램" → "600mg" 같은 교정도 되돌린다.
      const latinAdded = key === "text" && LATIN.test(kept[key]) && !LATIN.test(original[key]);
      if (
        kept[key] === original[key] ||
        (injectedNumbers(source, kept[key]).length === 0 && !latinAdded)
      )
        continue;
      kept[key] = original[key];
      reverted.add(`${lineIndex}:${key === "text" ? "narration" : "screenText"}`);
    }
    return kept;
  });
  const edits = edited.review.edits.filter(
    (edit) => !reverted.has(`${edit.lineIndex}:${edit.field}`),
  );
  const rate = bigramChangeRate(
    draft.copy.lines.map((line) => line.text).join("\n"),
    lines.map((line) => line.text).join("\n"),
  );
  const notes = [
    ...(reverted.size > 0
      ? [
          `초안에 없던 숫자나 내레이션 영문이 들어간 수정 ${reverted.size}건은 교정 전 문장으로 되돌렸습니다.`,
        ]
      : []),
    ...(rate > thresholds().COPY_CHANGE_WARNING_RATE
      ? [
          `내레이션의 약 ${Math.round(rate * 100)}%가 바뀌었습니다. 뜻이 달라지지 않았는지 수정 전후를 확인하세요.`,
        ]
      : []),
  ];
  if (notes.length === 0) return edited;
  return {
    lines,
    review: {
      status: edits.length > 0 ? "revised" : "pass",
      summary: [edited.review.summary, ...notes].join(" ").slice(0, 1000),
      edits,
    },
  };
}
