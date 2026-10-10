import {
  type Callout,
  type ClipPlan,
  type FlatScript,
  FlatScriptSchema,
  type HybridInfoClipResponse,
  type HybridVideoScriptResponse,
  HybridVideoScriptResponseSchema,
  type SentenceResponse,
  type Subject,
  shownDigitGroups,
  type VideoScript,
  type VideoScriptResponse,
  VideoScriptResponseSchema,
  videoScriptFromFlat,
} from "../shared/video-script";

// 장면 계획 픽스처(2026-10-06): 등장 대상 2개(인물·제품)와 클립별 세 구간 계획. 이미지 프롬프트는 traits 낱말(woman·kitchen·bottle)을 담는다.
export const fixtureSubjects: readonly Subject[] = [
  { id: "woman", traits: "woman in her 30s, navy blouse, tied-back hair, bright kitchen" },
  { id: "bottle", traits: "amber glass supplement bottle, white cap, cream label" },
];
export function fixtureClipPlan(id: string): ClipPlan {
  return {
    early: {
      camera: `Clip ${id}: start wide at the kitchen doorway, dolly in toward the woman, settle on a medium shot`,
      action: "She turns from the window and reaches for the amber bottle on the table",
    },
    mid: {
      camera:
        "Continue the dolly past her shoulder to the bottle, settle on a close-up of the label",
      action: "Her hand lifts the bottle and tilts the cream label toward the lens",
    },
    late: {
      camera: "Orbit a quarter turn around the bottle and hold a steady close-up",
      action: "One capsule rolls out into her open palm",
    },
  };
}
// 픽스처 콜아웃: 문장의 첫 어절(20자 이하일 때)에 라벨, 문장이 말하는 숫자가 있으면 그 숫자가 든 어절에 밀리그램 링.
export function fixtureCallouts(text: string, digits: readonly string[] = []): Callout[] {
  const callouts: Callout[] = [];
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const first = tokens[0] ?? "";
  if (first.length > 0 && first.length <= 20 && !/\d/.test(first))
    callouts.push({ word: first, text: "지금 확인", kind: "label", anchor: "subject" });
  for (const value of digits) {
    const token = tokens.find((item) => item.includes(value) && item.length <= 20);
    if (token)
      callouts.push({ word: token, text: `${value}밀리그램`, kind: "ring", anchor: "subject" });
  }
  return callouts.slice(0, 3);
}

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
      chainStep: voice.chainStep || "bridge",
      text: voice.text,
      captionDirection: voice.captionDirection ?? { tone: "plain", keyword: "", icon: "none" },
      callouts: voice.callouts.map((callout) => ({
        ...callout,
        targetId: callout.targetId ?? null,
      })),
      actionSync: voice.actionSync ?? null,
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
        // 응답은 goal 이 필수다. 평면 픽스처에 없으면 구도 설명을 쓴다.
        goal: cut.goal || [...cut.screenComposition].slice(0, 40).join(""),
        phase: cut.phase,
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
    subjects: flat.subjects,
    veoClips: flat.veoClips,
    stills: flat.stills,
    // 응답용 설명 컷에는 infoLines·motionPrompt 와 혼합형 장면 필드(sceneType·objects·actions·emphasis)가 없다(저장 전용 필드는 뺀다).
    infoClips: (flat.infoClips ?? []).map(
      ({
        infoLines: _infoLines,
        motionPrompt: _motionPrompt,
        sceneType: _sceneType,
        objects: _objects,
        actions: _actions,
        emphasis: _emphasis,
        ...clip
      }) => ({
        ...clip,
        explanation: clip.explanation ?? null,
      }),
    ),
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
      chainStep: "",
      text: fixtureSentence(lines.length, (last.endSec - first.startSec) * 5, digits),
      callouts: [],
    });
    index = to + 1;
  }
  // 콜아웃(R7 픽스처)은 마지막 문장(행동 유도)에만 붙인다. 앞 문장들은 여러 테스트가 글을 바꾸는데, 콜아웃 word 는 그 문장의 어절이어야 한다.
  const tail = lines[lines.length - 1];
  if (tail) tail.callouts = fixtureCallouts(tail.text);
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
      goal: `장면 ${index + 1}의 핵심`,
      // 클립 A: 컷 0(2초)은 early, 컷 1(1초)은 mid — 한 클립의 컷이 모두 같은 구간이면 경고가 난다.
      phase: index === 0 ? ("early" as const) : index === 1 ? ("mid" as const) : ("" as const),
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
    subjects: fixtureSubjects.map((subject) => ({ ...subject })),
    veoClips: [
      {
        id: "A",
        startImagePrompt: "Photo of the woman at the kitchen table, portrait.",
        prompt: "Portrait product scene, no people talking.",
        plan: fixtureClipPlan("A"),
      },
    ],
    stills: [],
    flowPrompt: `Flow shot ${number}`,
    editInstructions: "자막은 말보다 조금 먼저 띄운다.",
  });
}

// --- 혼합형 픽스처(hybrid_explainer_v1, 2026-10-07) -------------------------------------------------------------
// 실사 클립 A(고통·믿는 원인·진짜 원인)·B(결과·행동) + 설명 장면 I1(과정: 캡슐이 열리고 오일이 차오름)·I2(비교: 두 캡슐 색 구분)
// + 정지 이미지 S1 + 승인 이미지 엔딩 2초. 문장 8개, 사슬 칸 순서대로, 콜아웃은 실사 문장에만. 36초(설명 16초 = 44%).
// 설명 물체는 subjects 의 capsule(accent1)·oil(accent2)·bottle(neutral)이고 같은 ID 의 색은 두 장면에서 같다.
export const hybridSubjects: readonly Subject[] = [
  ...fixtureSubjects,
  { id: "capsule", traits: "clay-white translucent capsule shell, rounded ends" },
  { id: "oil", traits: "golden olive oil volume, smooth glossy surface" },
];
export const HYBRID_STYLE_ANCHOR =
  "Same woman in her 30s, navy blouse, tied-back hair, bright kitchen, warm morning daylight, handheld documentary feel.";
export const HYBRID_EXPLAINER_ANCHOR =
  "Clay-white model world under daylight, two brand accent colors (deep olive, warm gold) and white glow lines, no people, no text, no logos.";
function hybridInfoClip(
  id: "I1" | "I2",
  scene: Pick<
    HybridInfoClipResponse,
    "stage" | "sceneType" | "objects" | "actions" | "emphasis" | "infoLines"
  >,
  cleanPrompt: string,
  infoPrompt: string,
): HybridInfoClipResponse {
  const [first = "The capsule rests on the table", second = first, third = second] = scene.actions;
  return {
    id,
    cleanPrompt,
    infoPrompt,
    plan: {
      early: {
        camera: `Scene ${id}: low angle rising toward the capsule models on a clay table`,
        action: first,
      },
      mid: {
        camera: "Slow orbit a quarter turn around the models, keep both in frame",
        action: second,
      },
      late: { camera: "Fly past and settle on a steady three-quarter close-up", action: third },
    },
    ...scene,
  };
}
type HybridSentence = HybridVideoScriptResponse["sentences"][number];
type HybridCut = HybridSentence["cuts"][number];
function hybridCut(
  len: number,
  source: HybridCut["source"],
  goal: string,
  ref: {
    readonly veoClip?: HybridCut["veoClip"];
    readonly phase?: HybridCut["phase"];
    readonly stillId?: HybridCut["stillId"];
  } = {},
): HybridCut {
  return {
    len,
    source,
    screenComposition: goal,
    onScreenText: "",
    effect: "hard_cut",
    veoClip: ref.veoClip ?? "",
    stillId: ref.stillId ?? "",
    graphicKind: "",
    graphicLines: [],
    goal,
    phase: ref.phase ?? "",
  };
}
function hybridSentence(
  chainStep: HybridSentence["chainStep"],
  purpose: HybridSentence["purpose"],
  text: string,
  cuts: HybridCut[],
  callouts: HybridSentence["callouts"] = [],
): HybridSentence {
  return {
    purpose,
    chainStep,
    text,
    callouts,
    captionDirection: { tone: "plain", keyword: "", icon: "none" },
    actionSync: null,
    cuts,
  };
}
export function hybridScriptResponse(): HybridVideoScriptResponse {
  return HybridVideoScriptResponseSchema.parse({
    fixedTitle: [],
    disclaimer: "",
    voicePersona: "conversational",
    title: "혼합형 영상 1 대본",
    openLoop: "비싼 영양제가 왜 효과가 없을까?",
    payoffSec: 20,
    styleAnchor: HYBRID_STYLE_ANCHOR,
    explainerAnchor: HYBRID_EXPLAINER_ANCHOR,
    subjects: hybridSubjects.map((subject) => ({ ...subject })),
    veoClips: [
      {
        id: "A",
        startImagePrompt:
          "Photo of the woman in her 30s, navy blouse, at the bright kitchen table holding an amber glass supplement bottle, portrait 9:16.",
        prompt:
          "The woman hesitates over two supplement bottles, picks one up, reads the label, sighs.",
        plan: fixtureClipPlan("A"),
      },
      {
        id: "B",
        startImagePrompt:
          "Photo of the same woman in her 30s, navy blouse, bright kitchen, smiling with the amber glass bottle and a glass of water, portrait 9:16.",
        prompt: "She takes one capsule with water, relaxed, and puts the bottle in her bag.",
        plan: fixtureClipPlan("B"),
      },
    ],
    stills: [
      {
        id: "S1",
        prompt:
          "Photographic still of the bright kitchen at morning, the woman in a navy blouse packing her bag, soft daylight.",
      },
    ],
    infoClips: [
      hybridInfoClip(
        "I1",
        {
          stage: "mechanism",
          // INFO 인포그래픽 문구(2026-10-08): 한국어 라벨만, 숫자는 FACTS 에 있을 때만 쓴다(픽스처 자료에는 숫자가 없다).
          infoLines: ["캡슐 안은 올리브유"],
          sceneType: "process",
          objects: [
            { subjectId: "capsule", color: "accent1" },
            { subjectId: "oil", color: "accent2" },
          ],
          actions: [
            "The capsule shell splits open along its seam",
            "Golden olive oil pours into the open shell",
            "The oil level rises until the shell is full",
          ],
          emphasis: [
            { kind: "outline", target: "capsule", afterAction: 0 },
            { kind: "glow_line", target: "oil", afterAction: 1 },
          ],
        },
        "Clay-white translucent capsule shell with rounded ends resting on a clay table, empty space around it, daylight.",
        "The same capsule shell split open with a red outline, golden olive oil volume inside with a white glow line tracing its rise.",
      ),
      hybridInfoClip(
        "I2",
        {
          stage: "criteria",
          infoLines: ["겉은 같은 캡슐", "속은 다른 기름"],
          sceneType: "comparison",
          objects: [
            { subjectId: "capsule", color: "accent1" },
            { subjectId: "bottle", color: "neutral" },
          ],
          actions: [
            "Two capsule models rise side by side from the clay table",
            "The olive-colored capsule fills with golden olive oil while the neutral one stays hollow",
          ],
          emphasis: [{ kind: "color_code", target: "capsule", afterAction: 0 }],
        },
        "Two clay-white translucent capsule shells with rounded ends side by side next to an amber glass supplement bottle, same camera, daylight.",
        "The same two capsules, the left one olive-colored and full of golden olive oil, the right one neutral and hollow, no text.",
      ),
    ],
    sentences: [
      hybridSentence(
        "pain",
        "hook",
        "아침마다 영양제 고르기 고민되시죠?",
        [
          hybridCut(3, "veo_clip", "여자가 두 병 앞에서 망설인다", {
            veoClip: "A",
            phase: "early",
          }),
        ],
        [{ word: "아침마다", text: "아침 고민", kind: "label", anchor: "subject", targetId: null }],
      ),
      hybridSentence("believed_cause", "pain", "비싼 게 좋은 줄만 알았어요.", [
        hybridCut(2.5, "veo_clip", "라벨을 읽고 한숨 쉰다", { veoClip: "A", phase: "mid" }),
      ]),
      hybridSentence("real_cause", "story", "진짜 차이는 캡슐 속 원료예요.", [
        hybridCut(2.5, "veo_clip", "병을 내려놓는 손", { veoClip: "A", phase: "late" }),
      ]),
      hybridSentence("requirement", "mechanism", "원료가 제대로 들어가야 효과를 봐요.", [
        hybridCut(3, "veo_clip", "캡슐이 열린다", { veoClip: "I1", phase: "early" }),
        hybridCut(2.5, "veo_clip", "오일이 쏟아진다", { veoClip: "I1", phase: "mid" }),
      ]),
      hybridSentence("product_fact", "mechanism", "이 캡슐은 올리브 오일을 그대로 담았어요.", [
        hybridCut(2.5, "veo_clip", "오일이 가득 찬다", { veoClip: "I1", phase: "late" }),
        hybridCut(3, "veo_clip", "두 캡슐이 나란히 올라온다", { veoClip: "I2", phase: "early" }),
      ]),
      hybridSentence("reason_why", "proof", "냉압착이라 원료가 살아 있거든요.", [
        hybridCut(2.5, "veo_clip", "왼쪽 캡슐만 차오른다", { veoClip: "I2", phase: "mid" }),
        hybridCut(2.5, "veo_clip", "오른쪽은 비어 있다", { veoClip: "I2", phase: "late" }),
      ]),
      hybridSentence(
        "outcome",
        "proof",
        "그래서 아침 한 알이 가볍게 느껴져요.",
        [
          hybridCut(2, "still_image", "가방을 싸는 아침", { stillId: "S1" }),
          hybridCut(3, "veo_clip", "물과 함께 한 알", { veoClip: "B", phase: "early" }),
        ],
        [{ word: "가볍게", text: "가벼운 아침", kind: "label", anchor: "subject", targetId: null }],
      ),
      hybridSentence("cta", "cta", "지금 비교해 보세요.", [
        hybridCut(2.5, "veo_clip", "병을 가방에 넣는다", { veoClip: "B", phase: "mid" }),
        hybridCut(2.5, "veo_clip", "손에 든 병 클로즈업", { veoClip: "B", phase: "late" }),
        hybridCut(2, "approved_image", "승인 제품 이미지"),
      ]),
    ],
    flowPrompt:
      "The woman hesitates over two supplement bottles, picks one up, reads the label, sighs.",
    editInstructions: "설명 컷은 마지막 동작이 끝난 뒤 1초 안에 넘긴다.",
  });
}
