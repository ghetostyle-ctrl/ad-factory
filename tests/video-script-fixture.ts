import {
  type FlatScript,
  FlatScriptSchema,
  type SentenceResponse,
  shownDigitGroups,
  type VideoScript,
  type VideoScriptResponse,
  VideoScriptResponseSchema,
  videoScriptFromFlat,
} from "../shared/video-script";

// 저장 대본 → 평면 형태(모델이 적지 않던 startSec/endSec·narration·veoPrompt 제거). 테스트가 평면 픽스처를 손볼 때 쓴다.
export function flatOf(script: VideoScript): FlatScript {
  const { cuts, voiceover, ...rest } = script;
  return FlatScriptSchema.parse({
    ...rest,
    cuts: cuts.map(({ narration: _narration, veoPrompt: _veoPrompt, ...cut }) => cut),
    voiceover: voiceover.map(({ startSec: _startSec, endSec: _endSec, ...voice }) => voice),
  });
}
// 평면 대본(컷 + 컷 범위에 묶인 문장, 모든 컷이 어느 문장에 속함) → 모델 응답 형태(문장 우선·컷 중첩).
// 컷 목적은 문장 목적을 상속하므로(rehook 컷이 다른 문장 안에 있던 평면 픽스처는 그 컷의 목적이 바뀐다) 둘을 비교할 때는 그 점을 감안한다.
export function nestedScriptResponse(flat: FlatScript): VideoScriptResponse {
  let next = 0;
  const sentences: SentenceResponse[] = flat.voiceover.map((voice, index) => {
    if (voice.fromCut !== next)
      throw new Error(
        `${index + 1}번째 문장이 컷 ${next}부터 시작해야 합니다(fromCut ${voice.fromCut}).`,
      );
    const covered = flat.cuts.slice(voice.fromCut, voice.toCut + 1);
    next = voice.toCut + 1;
    return {
      purpose: voice.purpose,
      text: voice.text,
      cuts: covered.map((cut) => ({
        len: cut.endSec - cut.startSec,
        source: cut.source,
        screenComposition: cut.screenComposition,
        onScreenText: cut.onScreenText,
        effect: cut.effect,
        veoClip: cut.veoClip,
        stillId: cut.stillId,
        graphicKind: cut.graphicKind,
        graphicLines: [...cut.graphicLines],
      })),
    };
  });
  if (next !== flat.cuts.length)
    throw new Error(`컷 ${next}~${flat.cuts.length - 1}이 어느 문장에도 속하지 않습니다.`);
  return VideoScriptResponseSchema.parse({
    title: flat.title,
    fixedTitle: flat.fixedTitle ?? [],
    disclaimer: flat.disclaimer ?? "",
    voicePersona: flat.voicePersona ?? "",
    openLoop: flat.openLoop,
    payoffSec: flat.payoffSec,
    styleAnchor: flat.styleAnchor,
    veoClips: flat.veoClips,
    stills: flat.stills,
    sentences,
    flowPrompt: flat.flowPrompt,
    editInstructions: flat.editInstructions,
  });
}

// 픽스처 문장 끝에 붙이는 꼬리표(문장마다 다르게): 숫자를 쓰지 않는다(숫자는 화면에 보여야 한다는 규칙에 걸린다).
// 조사·메모체 종결(도·은·는·을·를·의·과·와·법…)이 되지 않는 음절만 쓴다.
const TAIL_SYLLABLES = [
  "나",
  "다",
  "라",
  "마",
  "바",
  "사",
  "아",
  "자",
  "차",
  "카",
  "타",
  "파",
  "하",
];
export function fixtureTail(index: number): string {
  const first = TAIL_SYLLABLES[Math.floor(index / TAIL_SYLLABLES.length) % TAIL_SYLLABLES.length];
  const second = TAIL_SYLLABLES[index % TAIL_SYLLABLES.length];
  return `${first ?? "나"}${second ?? "다"}`;
}
// 픽스처 문장: 한글 채움 + (화면에 보이는 숫자) + 꼬리표. 길이 chars, 서로 다른 문장, 영문·메모 표기 없음.
// mention 은 그 문장이 묶인 컷 자막에 있는 숫자들(말과 그림 일치 규칙: 자막 숫자는 그 컷의 문장이 말해야 한다).
export function fixtureSentence(index: number, chars: number, mention = ""): string {
  const tail = fixtureTail(index);
  const body = mention ? `${mention} ` : "";
  return `${"가".repeat(Math.max(1, chars - tail.length - body.length))}${body}${tail}`;
}
// 컷 목록에서 컷에 묶인 음성 트랙을 만든다: 같은 목적의 컷 2개씩 묶고(rehook 컷은 어느 문장에나 들어간다),
// 문장 목적은 범위 첫 비-rehook 컷의 목적, 길이는 범위 초 × 5자(상한 6.5자/초 안), 범위 컷 화면에 보이는 숫자
// (자막·글줄·구도 설명의 제품 수량, shownDigitGroups)가 있으면 문장에 넣는다.
export function fixtureVoiceover(
  cuts: readonly FlatScript["cuts"][number][],
): FlatScript["voiceover"] {
  const lines: FlatScript["voiceover"] = [];
  let index = 0;
  while (index < cuts.length) {
    const first = cuts[index];
    if (!first) break;
    const next = cuts[index + 1];
    const joinable =
      next !== undefined &&
      (next.purpose === first.purpose || next.purpose === "rehook" || first.purpose === "rehook");
    const to = joinable ? index + 1 : index;
    const covered = cuts.slice(index, to + 1);
    const last = covered[covered.length - 1] ?? first;
    const purpose = covered.find((cut) => cut.purpose !== "rehook")?.purpose ?? first.purpose;
    const digits = [...new Set(covered.flatMap((cut) => [...shownDigitGroups(cut)]))].join(" ");
    lines.push({
      fromCut: index,
      toCut: to,
      purpose,
      text: fixtureSentence(lines.length, (last.endSec - first.startSec) * 5, digits),
    });
    index = to + 1;
  }
  return lines;
}
// 30~60초 규칙을 지키는 대본: 2초·1초 컷을 번갈아 쓰고, 3컷마다 화면 효과, 중간에 다시 붙잡는 장면,
// 컷에 묶인 음성 트랙(초당 5자), 후킹으로 시작·행동 유도로 끝.
export function longVideoScript(
  number: number,
  hypothesisId: string,
  durationSec: number,
): VideoScript {
  const lengths: number[] = [];
  let left = durationSec;
  while (left > 0) {
    const length = Math.min(lengths.length % 2 === 0 ? 2 : 1, left);
    lengths.push(length);
    left -= length;
  }
  let start = 0;
  let rehooked = false;
  const cuts = lengths.map((length, index) => {
    const at = start / durationSec;
    const purpose =
      index === lengths.length - 1
        ? "cta"
        : at < 0.1
          ? "hook"
          : at < 0.25
            ? "pain"
            : at < 0.35
              ? "story"
              : !rehooked
                ? "rehook"
                : at < 0.6
                  ? "mechanism"
                  : "proof";
    if (purpose === "rehook") rehooked = true;
    const cut: FlatScript["cuts"][number] = {
      startSec: start,
      endSec: start + length,
      purpose,
      screenComposition: `장면 ${index + 1}`,
      onScreenText: index === 0 ? "이런 분 주목" : "",
      source:
        index <= 1
          ? ("veo_clip" as const)
          : index === 3
            ? ("motion_graphic" as const)
            : ("approved_image" as const),
      effect:
        index % 3 === 2
          ? index % 2
            ? ("zoom_punch" as const)
            : ("text_pop" as const)
          : ("hard_cut" as const),
      veoClip: index <= 1 ? ("A" as const) : ("" as const),
      stillId: "" as const,
      graphicKind: index === 3 ? ("number" as const) : ("" as const),
      graphicLines: index === 3 ? ["600mg"] : [],
    };
    start += length;
    return cut;
  });
  return videoScriptFromFlat({
    number,
    hypothesisId,
    title: `영상 ${number} 대본`,
    durationSec,
    openLoop: "왜 매번 작심삼일일까?",
    payoffSec: Math.ceil(durationSec * 0.7),
    cuts,
    voiceover: fixtureVoiceover(cuts),
    styleAnchor: "Same woman in her 30s, navy blouse, bright kitchen, warm morning light.",
    veoClips: [
      {
        id: "A",
        startImagePrompt: "Photo of the woman at the kitchen table, portrait.",
        prompt: "Portrait product scene, no people talking.",
      },
    ],
    stills: [],
    flowPrompt: `Flow shot ${number}`,
    editInstructions: "자막은 말보다 조금 먼저 띄운다.",
  });
}
