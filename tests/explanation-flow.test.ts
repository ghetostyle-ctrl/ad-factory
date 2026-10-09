import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { infoTextProblems } from "../server/flow-import";
import { flowExportFor, flowTexts } from "../server/flow-instructions";
import { ExplanationPlanSchema } from "../shared/explanation-plan";
import {
  FlowExportSchema,
  flowExportMarkdown,
  infoCleanPrompt,
  infoClipExpectsText,
  infoMotionPrompt,
  infoOverlayPrompt,
  infoTextLines,
} from "../shared/flow-mode";
import { InfoClipSchema } from "../shared/video-script";
import { providerStore } from "./provider-fixtures";
import { renderScript } from "./render-fixture";
import { fixtureClipPlan } from "./video-script-fixture";

// 고정 문장은 instructions/flow.md 에서 읽는다(서버 로더). 테스트는 같은 글로 조립 함수를 부른다.
const texts = flowTexts();

const explanation = ExplanationPlanSchema.parse({
  id: "lid_structure",
  productForm: "손에 쥘 수 있는 원통형 컵과 납작한 뚜껑",
  entities: [
    { id: "cup", name: "컵", representation: "product", appearance: "아이보리 원통형 컵" },
    { id: "lid", name: "뚜껑", representation: "component", appearance: "짙은 올리브색 뚜껑" },
  ],
  beats: [
    {
      id: "lift_lid",
      targetIds: ["cup", "lid"],
      startProgress: 0.1,
      endProgress: 0.85,
      before: "뚜껑이 컵 위에 닫혀 있다.",
      action: "뚜껑이 올라가며 맞물린 가장자리를 드러낸다.",
      after: "컵과 뚜껑의 가장자리가 같은 시점에서 보인다.",
      narrationCue: "뚜껑을 열면",
      viewerTakeaway: "어떤 부분이 서로 맞물리는지 이해한다.",
    },
  ],
  annotations: [
    {
      targetId: "lid",
      beatId: "lift_lid",
      label: "뚜껑",
      kind: "pointer",
      motionIntent: "뚜껑 가장자리의 같은 지점을 따라가며 가리킨다.",
    },
  ],
});
const clip = InfoClipSchema.parse({
  id: "I1",
  stage: "mechanism",
  explanation,
  cleanPrompt: "An ivory cup with an olive lid on an ivory surface",
  infoPrompt: "The same lid lifted above the matching rim",
  graphicOrder: ["Lift the lid", "Hold with both rims visible"],
  plan: fixtureClipPlan("I1"),
});

function embeddedPlan(prompt: string) {
  const payload = prompt.match(/<explanation-plan>\n([\s\S]*?)\n<\/explanation-plan>/)?.[1];
  if (!payload) throw new TypeError("Explanation payload was dropped from the production prompt");
  return ExplanationPlanSchema.parse(JSON.parse(payload));
}

test("all three production prompts preserve the same explanation identities and timing", () => {
  const prompts = [
    infoCleanPrompt(clip, "Ivory and olive", texts),
    infoOverlayPrompt(clip, texts),
    infoMotionPrompt(clip, texts),
  ];
  for (const prompt of prompts) expect(embeddedPlan(prompt)).toEqual(explanation);
});

test("Flow bundle carries the structured contract and exports the identical payload for every pass", async () => {
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    const script = { ...renderScript(1, "concept-1"), veoClips: [], infoClips: [clip] };
    const exported = FlowExportSchema.parse(
      flowExportFor({ ...job, videoScripts: [script] }, 1, texts),
    );
    const info = exported.infoClips[0];
    if (!info) throw new TypeError("Missing exported INFO clip");
    expect(info.explanation).toEqual(explanation);
    expect(info.infoLines).toEqual(["뚜껑"]);
    for (const prompt of [info.cleanPrompt, info.infoPrompt, info.motionPrompt])
      expect(embeddedPlan(prompt)).toEqual(explanation);
    const markdownPayload = flowExportMarkdown(exported).match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(ExplanationPlanSchema.parse(JSON.parse(markdownPayload ?? "null"))).toEqual(explanation);
  } finally {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
});

test("planned INFO images validate their composed labels rather than rejecting all text", () => {
  const stale = { ...clip, infoLines: ["예전 문구"] };
  expect(infoClipExpectsText(stale)).toBe(true);
  expect(infoTextLines(stale)).toEqual(["뚜껑"]);
  expect(infoTextProblems(stale, ["뚜껑"])).toEqual([]);
  expect(infoTextProblems(stale, []).length).toBeGreaterThan(0);
  expect(infoTextProblems(stale, ["뚜껑", "누수 완벽 차단"]).length).toBeGreaterThan(0);
  expect(infoTextProblems(stale, ["예전 문구"]).length).toBeGreaterThan(0);
  expect(infoTextProblems(stale, ["뚜", "껑"])).toEqual([]);
});

test("older INFO exports keep their shape without backfilled explanation data", async () => {
  const store = providerStore();
  try {
    const job = store.list()[0];
    if (!job) throw new TypeError("Missing local fixture job");
    const { explanation: omitted, ...legacyClip } = clip;
    const script = { ...renderScript(1, "concept-1"), veoClips: [], infoClips: [legacyClip] };
    const exported = FlowExportSchema.parse(
      flowExportFor({ ...job, videoScripts: [script] }, 1, texts),
    );
    expect(Object.hasOwn(exported.infoClips[0] ?? {}, "explanation")).toBe(false);
    expect(omitted?.id).toBe(explanation.id);
  } finally {
    store.close();
    await rm(store.root, { recursive: true, force: true });
  }
});
