import type { VideoCopyEditingResponse, VideoPlanningDraft } from "./video-planning";

// 한국어 AI 말투 교정 규칙. epoko77-ai/im-not-ai(MIT, https://github.com/epoko77-ai/im-not-ai)의
// quick-rules 에서 짧은 구어체 광고 카피에 해당하는 항목만 골라 옮겼다. 원본 지침대로 다 쓴 글을
// 고치는 단계(카피 교정·대본 검토)에만 쓰고 초안 생성 프롬프트에는 넣지 않는다 — 빈도 규칙이
// 생성 단계에서는 금지 규칙으로 바뀌어 문장이 더 어색해진다.
export const KOREAN_COPY_POLISH_RULES = `KOREAN AI-TELL RULES (post-editing only; adapted from the MIT-licensed im-not-ai rulebook). These describe wording that makes Korean copy sound machine-written. Most are ordinary Korean when used once — act on clear cases and pile-ups, never treat them as bans.
A. Translationese: "~에 대해/~에 있어서/~와 관련하여/~에 기반하여" → a direct particle ("성분에 대해 확인" → "성분을 확인"); "~을 가지고 있다" and other have/make/give+noun calques → a plain predicate ("흡수력을 가지고 있어요" → "흡수가 잘 돼요"); double passive "~되어지다/~지게 되다" → active or single passive; "~에 의해" → make the agent the subject; repeated "~를 통해" or "~을 위해" → "~로", "~려고", "~도록".
B. Abstract subject + all-purpose verb ("편안함을 제공합니다/선사합니다/가져다줍니다/보여줍니다") → a concrete subject doing a concrete thing.
C. Significance inflation with no fact behind it ("주목할 만한", "매우 중요한", "혁신적인", "차원이 다른", "완벽한") → delete it, or say the concrete supported fact that is already in the copy. Never invent one.
D. Formulas: "단순한 X를 넘어 Y", "X에서 Y로", cleft "중요한 것은/핵심은/문제는 ~입니다" → a direct statement; "A가 아니라 B" contrast used more than once → keep one; closing formula "~할 때입니다/~할 시간입니다" at most once; personified abstractions ("기술이 답합니다") → a person or the product as subject.
E. Connectives: sentence-initial "또한/따라서/결론적으로/이를 통해/그리고" chains → drop them; no comma right after a connective ending (-고, -며, -지만, -면서).
F. Rhythm: three or more consecutive sentences with the same ending or the same length → vary one; stacked three-item parallels ("빠르고, 쉽고, 간편하게") → keep at most one in the whole copy.
GUARDS: keep proper nouns, numbers, units, dates and quotations exactly. Keep a hedge or condition ("~일 수 있어요", "개인차가 있어요") as a hedge — never raise it to a flat claim. Keep the content nouns of each sentence; change particles, endings and filler, not the claim. Do not introduce any of these patterns while fixing another. A line that already sounds like a person talking stays unchanged; over-editing is a failure.`;

const DIGITS = /\d+(?:[.,]\d+)*/g;

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

export const COPY_CHANGE_WARNING_RATE = 0.5;

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
      if (kept[key] === original[key] || injectedNumbers(source, kept[key]).length === 0) continue;
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
      ? [`초안에 없던 숫자가 들어간 수정 ${reverted.size}건은 교정 전 문장으로 되돌렸습니다.`]
      : []),
    ...(rate > COPY_CHANGE_WARNING_RATE
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
