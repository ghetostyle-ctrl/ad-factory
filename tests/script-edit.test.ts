import { expect, test } from "bun:test";
import { applyScriptEdit } from "../shared/script-edit";
import { CAPTION_LINE_MAX_CHARS } from "../shared/video-script";
import { renderScript } from "./render-fixture";

test("editing a sentence preserves its multiple cuts and updates the first cut narration", () => {
  const original = renderScript(1, "c1");
  original.voiceover = [
    {
      text: "기존 문장입니다.",
      fromCut: 0,
      toCut: 2,
      startSec: 0,
      endSec: 5,
      purpose: "hook",
      chainStep: "",
      callouts: [{ word: "기존", text: "기존 문장", kind: "label", anchor: "left" }],
    },
  ];
  const edited = applyScriptEdit(original, {
    voiceover: [{ index: 0, text: "  새로운 문장을 살펴보세요.  " }],
    captions: [],
  });
  expect(edited.voiceover[0]).toMatchObject({
    text: "새로운 문장을 살펴보세요.",
    fromCut: 0,
    toCut: 2,
    startSec: original.cuts[0]?.startSec,
    endSec: original.cuts[2]?.endSec,
  });
  // 장면 계획(2026-10-06): 글만 바뀌고 콜아웃·컷 goal/phase·클립 plan·subjects 는 그대로다(어절이 사라졌는지는 서비스가 400 으로 알린다)
  expect(edited.voiceover[0]?.callouts).toEqual(original.voiceover[0]?.callouts);
  expect(edited.cuts.map((cut) => [cut.goal, cut.phase])).toEqual(
    original.cuts.map((cut) => [cut.goal, cut.phase]),
  );
  expect(edited.veoClips).toEqual(original.veoClips);
  expect(edited.subjects).toEqual(original.subjects);
  expect(edited.cuts[0]?.narration).toBe("새로운 문장을 살펴보세요.");
  expect(edited.cuts[1]?.narration).toBe("");
  expect(edited.cuts[2]?.narration).toBe("");
  expect(edited.cuts.map((cut) => [cut.startSec, cut.endSec, cut.source])).toEqual(
    original.cuts.map((cut) => [cut.startSec, cut.endSec, cut.source]),
  );
  expect(original.voiceover[0]?.text).toBe("기존 문장입니다.");
});

test("caption edits preserve long content while previewing saved whitespace normalization", () => {
  const original = renderScript(1, "c1");
  const text = "가".repeat(CAPTION_LINE_MAX_CHARS * 3);
  const edited = applyScriptEdit(original, {
    voiceover: [],
    captions: [{ cutIndex: 0, onScreenText: ` ${text} ` }],
  });
  expect(edited.cuts[0]?.onScreenText).toBe(text);
  expect(edited.cuts[1]?.onScreenText).toBe(original.cuts[1]?.onScreenText);
});
