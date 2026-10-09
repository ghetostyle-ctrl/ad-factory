import { expect, test } from "bun:test";
import { ExplanationPlanSchema } from "../shared/explanation-plan";

test.each([
  { labelLength: 24, annotationCount: 4, accepted: true },
  { labelLength: 25, annotationCount: 4, accepted: false },
  { labelLength: 24, annotationCount: 5, accepted: false },
])(
  "INFO annotations respect image text limits %j",
  ({ labelLength, annotationCount, accepted }) => {
    // Given
    const plan = {
      id: "structure",
      productForm: "자료의 실제 제품 비율을 유지한다.",
      entities: [
        { id: "product", name: "제품", representation: "product", appearance: "실제 외형" },
      ],
      beats: [
        {
          id: "reveal",
          targetIds: ["product"],
          startProgress: 0,
          endProgress: 1,
          before: "제품 외부",
          action: "내부를 드러낸다.",
          after: "내부 구조",
          narrationCue: "안쪽을 보면",
          viewerTakeaway: "내부 구조를 이해한다.",
        },
      ],
      annotations: Array.from({ length: annotationCount }, () => ({
        targetId: "product",
        beatId: "reveal",
        label: "가".repeat(labelLength),
        kind: "pointer",
        motionIntent: "내부가 보일 때 해당 부분을 가리킨다.",
      })),
    };
    // When
    const result = ExplanationPlanSchema.safeParse(plan);
    // Then
    expect(result.success).toBe(accepted);
  },
);
