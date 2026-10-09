import { AD_EDIT_STYLE } from "../../shared/ad-edit-style";
import type { HfLabelPlan } from "../../shared/hf-label-plan";
import { StudioError } from "../errors";
import type { FontSet } from "./fonts";
import { lineEm } from "./text-fit";

export type LabelLayout = {
  readonly label: HfLabelPlan["labels"][number];
  readonly text: string;
  readonly lines: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly supporting: boolean;
};
const style = AD_EDIT_STYLE.label;
const width = (text: string, size: number, font: FontSet) =>
  (lineEm(text, font) / (font.family === "Pretendard" ? 2048 / 2444 : 0.95)) * size +
  Math.max(0, [...text].length - 1) * style.letterSpacingEm * size;
function splitLabel(text: string, size: number, font: FontSet): string[] {
  const room = 1080 * style.maxWidthRatio - 2 * style.horizontalPaddingEm * size;
  if ([...text].length <= 16) {
    if (width(text, size, font) > room)
      throw new StudioError(
        "hf_label_layout",
        "16자 이내 라벨이 한 줄 폭을 넘습니다. 문구를 줄이지 말고 장면 배치를 수정하세요.",
      );
    return [text];
  }
  if (width(text, size, font) <= room) return [text];
  const candidates = [...text.matchAll(/\s+/gu)].map((match) => [
    text.slice(0, match.index),
    text.slice(match.index + match[0].length),
  ]);
  const fitted = candidates.filter((lines) =>
    lines.every((line) => line.length > 0 && width(line, size, font) <= room),
  );
  fitted.sort(
    (a, b) =>
      Math.abs(width(a[0] ?? "", size, font) - width(a[1] ?? "", size, font)) -
      Math.abs(width(b[0] ?? "", size, font) - width(b[1] ?? "", size, font)),
  );
  const best = fitted[0];
  if (!best)
    throw new StudioError(
      "hf_label_layout",
      "라벨이 80% 폭·어절 줄바꿈으로 맞지 않습니다. 원문을 보존하며 배치를 수정하세요.",
    );
  return best;
}
export function layoutHfLabels(
  plan: HfLabelPlan,
  infoLines: readonly string[],
  font: FontSet,
): LabelLayout[] {
  const placed = plan.labels.map((label): LabelLayout => {
    const text = infoLines[label.lineIndex];
    if (!text) throw new StudioError("hf_label_layout", "라벨 문구 인덱스가 원문과 맞지 않습니다.");
    const supporting = label.role === "supporting";
    const size = supporting
      ? style.supportingFontSize
      : Math.max(style.minFontSize, Math.min(style.maxFontSize, label.fontSizePx));
    const lines = splitLabel(text, size, font);
    const textWidth = Math.max(...lines.map((line) => width(line, size, font)));
    const w = Math.ceil(textWidth + 2 * style.horizontalPaddingEm * size);
    const h = Math.ceil(size * (lines.length === 1 ? style.heightEm : 3.1));
    const reach = 1080 * style.maxLeaderReachRatio;
    const minimum = Math.max(
      1080 * style.safeSide + w / 2,
      ...label.anchors.map((anchor) => anchor.x * 1080 - reach),
    );
    const maximum = Math.min(
      1080 * (1 - style.safeSide) - w / 2,
      ...label.anchors.map((anchor) => anchor.x * 1080 + reach),
    );
    if (minimum > maximum)
      throw new StudioError(
        "hf_label_layout",
        "안전 여백과 짧은 연결선을 함께 확보할 수 없습니다. 앵커·문구 배치를 수정하세요.",
      );
    const center = Math.max(minimum, Math.min(maximum, (label.box.x + label.box.width / 2) * 1080));
    const x = center - w / 2;
    const lower = Math.max(
      1920 * style.safeTop,
      ...label.anchors.map((anchor) => anchor.y * 1920 + style.anchorRadiusPx + 12),
    );
    const upper = 1920 * style.bottomRatio - h;
    if (lower > upper)
      throw new StudioError(
        "hf_label_layout",
        "대상 아래에 배지와 자막의 안전 여백이 부족합니다. 장면 배치를 수정하세요.",
      );
    const y = Math.max(lower, Math.min(upper, label.box.y * 1920));
    return { label, text, lines, x, y, width: w, height: h, size, supporting };
  });
  const aligned = placed.map((item) => {
    const group = placed.filter(
      (other) =>
        other.supporting === item.supporting &&
        other.size === item.size &&
        Math.abs(other.label.box.y - item.label.box.y) < 0.03 &&
        other.label.startSec < item.label.endSec &&
        item.label.startSec < other.label.endSec,
    );
    const height = Math.max(...group.map((other) => other.height));
    const y = Math.max(...group.map((other) => other.y));
    return { ...item, height, y };
  });
  for (const item of aligned) {
    if (
      item.y + item.height > 1920 * style.bottomRatio ||
      item.label.anchors.some((anchor) => anchor.y * 1920 > item.y - style.anchorRadiusPx)
    )
      throw new StudioError(
        "hf_label_layout",
        "비교 배지 정렬 후 앵커와 판이 겹칩니다. 라벨 위치를 조정하세요.",
      );
  }
  for (const [i, a] of aligned.entries())
    for (const b of aligned.slice(0, i)) {
      if (
        a.label.startSec < b.label.endSec &&
        b.label.startSec < a.label.endSec &&
        a.x < b.x + b.width + 16 &&
        b.x < a.x + a.width + 16 &&
        a.y < b.y + b.height + 16 &&
        b.y < a.y + a.height + 16
      )
        throw new StudioError(
          "hf_label_layout",
          "실제 글자 폭으로 배치한 라벨이 겹칩니다. 비교 라벨의 위치를 수정하세요.",
        );
    }
  return aligned;
}
