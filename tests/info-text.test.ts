import { expect, test } from "bun:test";
import { infoTextProblems } from "../server/flow-import";

test.each(["商品説明", "ラベル", "Продукт", "προϊόν", "منتج", "༳༳"])(
  "new INFO clips reject readable Unicode text: %s",
  (text) => {
    // Given: a new INFO clip and OCR text outside Hangul/Latin.
    const clip = { infoLines: [], graphicOrder: ["ring", "arrow"] };
    // When: the upload gate checks the OCR result.
    const problems = infoTextProblems(clip, [text]);
    // Then: readable text requires a new text-free image.
    expect(problems).toHaveLength(1);
  },
);

test.each([{ read: [] }, { read: ["↗ ○ ✓"] }, { read: ["商"] }, { read: ["猫", "→"] }])(
  "new INFO clips preserve the single-character noise tolerance: %j",
  ({ read }) => {
    // Given: a new INFO clip and graphics or one OCR character.
    const clip = { infoLines: [], graphicOrder: ["ring", "arrow"] };
    // When: the upload gate checks the OCR result.
    const problems = infoTextProblems(clip, read);
    // Then: the existing noise tolerance still accepts the image.
    expect(problems).toEqual([]);
  },
);

test("legacy INFO clips still accept their required label", () => {
  // Given: a saved legacy INFO clip with required text.
  const clip = { infoLines: ["상품 설명"], graphicOrder: [] };
  // When: the upload gate receives that exact label.
  const problems = infoTextProblems(clip, ["상품 설명"]);
  // Then: the legacy label comparison accepts the image.
  expect(problems).toEqual([]);
});
