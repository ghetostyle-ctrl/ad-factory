import { expect, test } from "bun:test";
import { verifyVideoScript } from "../server/video-scripts";
import { VideoScriptSchema } from "../shared/video-script";

const script = VideoScriptSchema.parse({
  number: 1,
  hypothesisId: "concept-1",
  title: "상품 사용 장면",
  durationSec: 8,
  cuts: [
    {
      startSec: 0,
      endSec: 3,
      purpose: "hook",
      screenComposition: "첫 화면",
      onScreenText: "후킹",
      narration: "",
      source: "approved_image",
    },
    {
      startSec: 3,
      endSec: 8,
      purpose: "cta",
      screenComposition: "마지막 화면",
      onScreenText: "자세히 보기",
      narration: "자세히 확인해 보세요",
      source: "veo_clip",
    },
  ],
  flowPrompt: "Animate the approved product image in portrait format.",
  editInstructions: "컷별 자막을 시간에 맞게 배치한다.",
});

test("video script accepts only the linked concept and continuous eight-second cuts", () => {
  expect(() => verifyVideoScript(script, 1, "concept-1")).not.toThrow();
  expect(() => verifyVideoScript(script, 2, "concept-1")).toThrow("번호");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) =>
          index === 0 ? { ...cut, source: "veo_clip" as const } : cut,
        ),
      },
      1,
      "concept-1",
    ),
  ).toThrow("첫 이미지");
  expect(() =>
    verifyVideoScript(
      {
        ...script,
        cuts: script.cuts.map((cut, index) => (index === 1 ? { ...cut, startSec: 4 } : cut)),
      },
      1,
      "concept-1",
    ),
  ).toThrow("컷 시간");
});
