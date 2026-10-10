import { expect, test } from "bun:test";
import { classifyScriptProblems, verifyLongVideoScript } from "../server/video-scripts";
import { HypothesisSchema } from "../shared/creative-plan";
import { videoScriptFromResponse } from "../shared/script-repair";
import {
  alignmentProblems,
  type SentenceCutResponse,
  type SentenceResponse,
  type VideoScriptResponse,
  VideoScriptResponseSchema,
  VideoScriptSchema,
} from "../shared/video-script";
import { sourcePlanResponse } from "./source-planning-fixture";

// 2026-10-04 실전 gpt-5-mini 실패 재현(생성 3회 모두 거부 → attention): 내레이션은 좋았지만("출근 전 10초, 영양 챙길 시간 있나요?",
// "매일 여러 알 챙기기 번거로우시죠?", "캡슐당 600mg으로 설계됐어요.") graphicLines 가 정지 이미지·Veo 컷에 붙고, 3초 범위에 19~23자,
// mechanism 문장이 proof 컷에 묶이고, 600mg 를 보이지 않는 컷에서 말했다(55건). 같은 내용의 중첩 응답을 변환+수리+검사 파이프라인에
// 넣으면 형식 문제는 거부가 아니라 수리되고, 숫자 규칙만 남아 거부하며, 목적 어긋남은 구조상 생길 수 없고, 초는 속도 한도로 맞춰진다.
const hypothesis = HypothesisSchema.parse(sourcePlanResponse("fact-1").hypotheses[0]);
const facts = ["종근당 엑스트라 버진 올리브 오일 600밀리그램 30캡슐"];
const ctx = { number: 1, hypothesisId: hypothesis.id, targetSec: 30, hasCardSlides: false };

function cut(input: Partial<SentenceCutResponse> & { readonly len: number }): SentenceCutResponse {
  return {
    source: "still_image",
    screenComposition: "장면",
    onScreenText: "",
    effect: "hard_cut",
    veoClip: "",
    stillId: "",
    graphicKind: "",
    graphicLines: [],
    goal: "이 컷의 핵심",
    // 장면 계획(2026-10-06): Veo 컷은 클립 구간이 필수다. 오늘 실패 재현과 무관하므로 early 로 둔다.
    phase: input.source === "veo_clip" ? "early" : "",
    ...input,
  };
}
const sentence = (
  purpose: SentenceResponse["purpose"],
  text: string,
  cuts: SentenceCutResponse[],
): SentenceResponse => ({
  purpose,
  chainStep: "bridge",
  text,
  captionDirection: { tone: "plain", keyword: "", icon: "none" },
  callouts: [],
  actionSync: null,
  cuts,
});
const plan = (id: string) => ({
  early: {
    camera: `Clip ${id}: start at the doorway, dolly in, settle on a medium shot`,
    action: "She hurries",
  },
  mid: { camera: "Continue to the counter, settle on the hands", action: "She grabs the keys" },
  late: { camera: "Orbit to the bottle and hold a close-up", action: "She pauses at the counter" },
});
// 오늘 실패를 본뜬 응답: 문장 1·2·4·5·6 이 범위보다 길고, graphicLines 가 Veo·정지 이미지 컷에 붙어 있고, 600 은 어느 컷에도 보이지 않는다.
function realFailureResponse(): VideoScriptResponse {
  const response = VideoScriptResponseSchema.parse({
    fixedTitle: [],
    disclaimer: "",
    voicePersona: "",
    title: "출근 전 10초 영양",
    openLoop: "하루 1알이 정말 가능할까?",
    payoffSec: 22,
    styleAnchor:
      "Same woman in her 30s, grey hoodie, bright apartment kitchen, soft morning light.",
    subjects: [],
    veoClips: [
      {
        id: "A",
        startImagePrompt: "Woman at the door checking her watch.",
        prompt: "She hurries, grabs keys, pauses at the counter.",
        plan: plan("A"),
      },
      {
        id: "B",
        startImagePrompt: "Hand opening a capsule bottle.",
        prompt: "One capsule into the palm, swallowed with water.",
        plan: plan("B"),
      },
    ],
    stills: [
      { id: "S1", prompt: "Cluttered counter with many pill bottles." },
      { id: "S2", prompt: "Product bottle front, label readable." },
      { id: "S3", prompt: "A single capsule on a clean wooden table." },
    ],
    infoClips: [],
    sentences: [
      sentence("hook", "출근 전 10초, 영양 챙길 시간 있나요?", [
        // 실패 1행: 모션그래픽이 아닌데 graphicLines
        cut({
          len: 1,
          source: "veo_clip",
          veoClip: "A",
          screenComposition: "현관에서 시계를 보는 얼굴",
          onScreenText: "출근 전 10초",
          graphicLines: ["10초"],
        }),
        cut({
          len: 1,
          source: "veo_clip",
          veoClip: "A",
          screenComposition: "열쇠를 집는 손",
          effect: "zoom_punch",
        }),
        cut({ len: 1, source: "veo_clip", veoClip: "A", screenComposition: "조리대 앞에서 멈칫" }),
      ]),
      sentence("pain", "매일 여러 알 챙기기 번거로우시죠?", [
        cut({
          len: 1,
          stillId: "S1",
          screenComposition: "약병이 가득한 조리대 와이드",
          onScreenText: "매일 여러 알",
          graphicLines: ["여러 알"],
        }),
        cut({
          len: 1,
          stillId: "S1",
          screenComposition: "약병 뚜껑들 클로즈업",
          effect: "zoom_punch",
        }),
        cut({ len: 1, stillId: "S1", screenComposition: "한숨 쉬는 듯한 빈 손 위치" }),
      ]),
      sentence("story", "알약 개수가 문제가 아니었어요.", [
        cut({
          len: 2,
          stillId: "S3",
          screenComposition: "나무 탁자 위 캡슐 한 알 와이드",
          effect: "text_pop",
        }),
        cut({ len: 2, stillId: "S3", screenComposition: "캡슐 한 알 클로즈업" }),
      ]),
      sentence("rehook", "근데 이게 진짜 가능한가요?", [
        cut({
          len: 2,
          source: "motion_graphic",
          graphicKind: "question",
          graphicLines: ["진짜 가능할까?"],
          screenComposition: "질문 카드",
          effect: "text_pop",
        }),
        cut({ len: 1, source: "veo_clip", veoClip: "B", screenComposition: "병을 여는 손" }),
      ]),
      sentence("mechanism", "그래서 하루 1알 방식으로 제안해요.", [
        cut({
          len: 1,
          source: "veo_clip",
          veoClip: "B",
          screenComposition: "손바닥 위 캡슐 한 알",
          onScreenText: "하루 1알",
        }),
        cut({
          len: 1,
          source: "veo_clip",
          veoClip: "B",
          screenComposition: "물과 함께 삼키는 순간",
          effect: "zoom_punch",
        }),
        cut({
          len: 1,
          source: "motion_graphic",
          graphicKind: "number",
          graphicLines: ["하루 1알"],
          screenComposition: "숫자 카드",
        }),
      ]),
      // 실패 5번째 문장: 600 을 말하지만 어느 컷도 보여 주지 않는다(글줄 "600mg" 는 정지 이미지 컷에 잘못 붙어 R4 가 지운다)
      sentence("mechanism", "캡슐당 600밀리그램으로 설계됐어요.", [
        cut({ len: 1, stillId: "S2", screenComposition: "제품 정면 클로즈업" }),
        cut({
          len: 1,
          stillId: "S2",
          screenComposition: "제품 측면",
          effect: "zoom_punch",
          graphicLines: ["600mg"],
        }),
      ]),
      sentence("proof", "포장에 그대로 적혀 있어요.", [
        cut({
          len: 2,
          source: "approved_image",
          screenComposition: "대표 이미지 포장 전면",
          effect: "text_pop",
        }),
        cut({ len: 2, source: "approved_image", screenComposition: "대표 이미지 라벨 부분 확대" }),
      ]),
      sentence("cta", "지금 확인해 보세요.", [
        cut({
          len: 3,
          source: "approved_image",
          screenComposition: "대표 이미지와 링크 안내",
          onScreenText: "지금 확인",
        }),
      ]),
    ],
    flowPrompt: "She hurries, grabs keys, pauses at the counter.",
    editInstructions: "자막은 말보다 조금 먼저, 숫자에 줌 펀치.",
  });
  return {
    ...response,
    sentences: response.sentences.map((sentence, index) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut, k) => ({
        ...cut,
        len:
          index === 6
            ? 3
            : [0, 1, 5].includes(index) && k === sentence.cuts.length - 1
              ? cut.len + 1
              : cut.len,
      })),
    })),
  };
}
const expected = { number: 1, durationSec: 30, hypothesis, facts };

test("formatting repairs clear stray fields while preserving planned sentence timing", () => {
  const { script, repairs } = videoScriptFromResponse(realFailureResponse(), ctx);
  expect(VideoScriptSchema.safeParse(script).success).toBe(true);
  // graphicLines 가 모션그래픽이 아닌 컷에서 지워졌다(실패 1~7행)
  expect(
    repairs.filter((item) => item.includes("graphicLines") && item.includes("삭제")),
  ).toHaveLength(3);
  expect(
    script.cuts.every((item) => item.source === "motion_graphic" || item.graphicLines.length === 0),
  ).toBe(true);
  const original = realFailureResponse();
  script.voiceover.forEach((voice, index) => {
    const sentence = original.sentences[index];
    if (!sentence) throw new Error("sentence missing");
    expect(voice.endSec - voice.startSec).toBe(
      sentence.cuts.reduce((sum, cut) => sum + cut.len, 0),
    );
  });
  // 길이는 컷 합계에서 유도된다(30초 목표 안)
  expect(script.durationSec).toBe(script.cuts.at(-1)?.endSec ?? -1);
  expect(script.durationSec).toBe(30);
  expect(alignmentProblems(script).filter((item) => item.includes("자까지 들어갑니다"))).toEqual(
    [],
  );
  expect(alignmentProblems(script).filter((item) => item.includes("graphicLines"))).toEqual([]);
  // 모든 수리는 한국어 한 줄
  for (const item of repairs) {
    expect(item).toMatch(/[가-힣]/);
    expect(item).not.toContain("\n");
  }
});

test("purpose mismatch between a sentence and its cuts is impossible by construction", () => {
  const { script } = videoScriptFromResponse(realFailureResponse(), ctx);
  for (const voice of script.voiceover)
    for (let k = voice.fromCut; k <= voice.toCut; k++)
      expect(String(script.cuts[k]?.purpose)).toBe(voice.purpose);
  expect(alignmentProblems(script).filter((item) => item.includes("목적이"))).toEqual([]);
  // 범위는 연속·겹침 없음·말 없는 컷 0개
  let next = 0;
  for (const voice of script.voiceover) {
    expect(voice.fromCut).toBe(next);
    next = voice.toCut + 1;
  }
  expect(next).toBe(script.cuts.length);
});

test("the number rule still rejects: 600 is said over cuts that do not show it, and nothing else is left", () => {
  const { script } = videoScriptFromResponse(realFailureResponse(), ctx);
  const rules = classifyScriptProblems(script, expected);
  expect(rules.hard.length).toBeGreaterThan(0);
  expect(rules.hard.every((item) => item.includes("6번째 문장"))).toBe(true);
  expect(rules.hard).toContainEqual(expect.stringContaining("숫자 600가 묶인"));
  // 오늘 거부 사유였던 형식·속도·목적 문제는 남아 있지 않다
  for (const item of rules.hard) {
    expect(item).not.toContain("graphicLines");
    expect(item).not.toContain("자까지 들어갑니다");
    expect(item).not.toContain("목적이");
  }
  expect(() => verifyLongVideoScript(script, expected)).toThrow("숫자 600");
  // 600mg 를 보여 주는 자막을 그 문장의 컷에 넣으면 통과한다(600·밀리그램·캡슐 모두 화면에)
  const fixed = realFailureResponse();
  const mechanism = fixed.sentences[5];
  const shown = mechanism?.cuts[1];
  if (!mechanism || !shown) throw new Error("픽스처 문장이 없습니다");
  mechanism.cuts[1] = { ...shown, onScreenText: "600mg 캡슐", graphicLines: [] };
  const passed = videoScriptFromResponse(fixed, ctx).script;
  expect(classifyScriptProblems(passed, expected).hard).toEqual([]);
  expect(() => verifyLongVideoScript(passed, expected)).not.toThrow();
});
