import type { Caption } from "../../shared/narration-captions";
import type { TimelineCut } from "../../shared/render-timeline";

const graphicText = (text: string): string =>
  text
    .replace(/^백\s*퍼센트(?=(?:거든요|입니다|예요|이에요)?[.!?]?$)/u, "100%")
    .replace(/퍼센트/gu, "%")
    .replace(/(?:거든요|입니다|이에요|예요)[.!?]?$/u, "")
    .replace(/(?<!\d)\.|\.(?!\d)|[\s,!?·]/gu, "")
    .toLowerCase();
// 정규화한 글 안에 다른 글이 들어 있는지. 숫자는 앞뒤에 다른 숫자·소수점이 붙으면(1100%·1.00%) 다른 값으로 본다.
const containsText = (haystack: string, needle: string): boolean => {
  const at = haystack.indexOf(needle);
  return (
    at >= 0 &&
    !(/^\d/u.test(needle) && /[\d.+-]/u.test(haystack[at - 1] ?? "")) &&
    !(/\d$/u.test(needle) && /[\d.]/u.test(haystack[at + needle.length] ?? ""))
  );
};

export function graphicCaptionSpans(
  caption: Caption,
  cuts: readonly TimelineCut[],
  staggerMs: number,
): Caption[] {
  const text = graphicText(caption.text);
  if (!text) return [caption];
  let spans = [caption];
  for (const cut of cuts) {
    if (cut.visualPolicy !== "immersive_explanations_v1" || cut.source !== "motion_graphic")
      continue;
    if (cut.graphicKind !== "callout" && cut.purpose !== "cta") continue;
    const index = cut.graphicLines.findIndex((line) => containsText(graphicText(line), text));
    if (index < 0) continue;
    const visibleAt =
      cut.startMs + Math.min(index * staggerMs, Math.max(0, cut.endMs - cut.startMs - 200)) + 80;
    spans = spans.flatMap((span) => {
      if (span.endMs <= visibleAt || span.startMs >= cut.endMs) return [span];
      return [
        ...(span.startMs < visibleAt ? [{ ...span, endMs: visibleAt }] : []),
        ...(span.endMs > cut.endMs ? [{ ...span, startMs: cut.endMs }] : []),
      ];
    });
  }
  return spans;
}

// 패널 글줄 ↔ 자막 중복(H6, 2026-10-07): 1a25b85 는 글줄과 같은 자막을 지웠지만 c65223c 뒤로 말하는 구간의 자막은
// 늘 남으므로 어제 완성본(8e3aeb37)에서는 패널 글과 자막이 같은 글로 겹쳤다. 그래서 같은 시각에 뜨는 음성 자막에
// 이미 들어 있는 글줄(정규화 후 포함)은 패널에서 뺀다. 자리를 정하는 첫 줄(number 의 큰 숫자·callout 의 강조 상자)은
// 남기고, 두 열이 자리를 나누는 compare 는 손대지 않는다. 글줄이 모두 겹치면 빈 패널 대신 그대로 둔다.
// 호출자(render-production)는 말하는 구간의 자막만 넘기고, 뺀 뒤의 글줄로 세그먼트 캐시 키를 잡는다.
// hybrid 정책은 패널 컷이 없어 영향이 없다.
// immersive 정책의 행동 유도(cta) 패널은 compare 로 적혀 있어도 강조 상자(callout) 템플릿으로 그린다(1a25b85).
// ass.ts 의 cutGraphicAss 와 아래 글줄 제외가 같은 템플릿을 본다.
export function effectiveGraphicKind(
  cut: Pick<TimelineCut, "graphicKind" | "purpose" | "visualPolicy">,
): TimelineCut["graphicKind"] {
  return cut.visualPolicy === "immersive_explanations_v1" && cut.purpose === "cta"
    ? "callout"
    : cut.graphicKind;
}
export function graphicLinesWithoutCaptions(
  cut: Pick<
    TimelineCut,
    "source" | "graphicKind" | "graphicLines" | "startMs" | "endMs" | "purpose" | "visualPolicy"
  >,
  captions: readonly Caption[],
): string[] {
  const lines = [...cut.graphicLines];
  const kind = effectiveGraphicKind(cut);
  if (cut.source !== "motion_graphic" || kind === "compare") return lines;
  const spoken = captions
    .filter((caption) => caption.startMs < cut.endMs && caption.endMs > cut.startMs)
    .sort((left, right) => left.startMs - right.startMs)
    .map((caption) => graphicText(caption.text))
    .join("");
  if (!spoken) return lines;
  const anchored = kind === "number" || kind === "callout" ? 1 : 0;
  const kept = lines.filter((line, index) => {
    if (index < anchored) return true;
    const text = graphicText(line);
    return !(text && containsText(spoken, text));
  });
  return kept.length === 0 ? lines : kept;
}
