import {
  type FlatCut,
  type FlatScript,
  type SentenceCutResponse,
  type SentenceResponse,
  type VideoScript,
  type VideoScriptResponse,
  videoScriptFromFlat,
} from "./video-script";

// 모델 응답(문장 우선·컷 중첩)을 저장 형식으로 바꾸면서 기계적인 문제는 거부하지 않고 고친다(2026-10-04).
// 실전 gpt-5-mini 가 3회 모두 거부된 원인은 '규칙을 몰라서'가 아니라 '약 25개 제약을 평면 JSON 한 번에 못 맞춰서'였다:
// 소스 부속 필드와 자막 공백은 자동 수정한다. 추정 발화 속도로 문장·컷 시간을 바꾸지는 않는다.
// 모든 수리는 한국어 한 줄로 repairs 에 쌓여 검토 기록(renders[n].scriptReview.repairs)·화면·CLI 에 보인다.
// 서버·테스트·화면이 같은 순수 함수를 쓴다.
export type ScriptContext = {
  readonly number: number;
  readonly hypothesisId: string;
  // 목표 길이(초). 저장 길이는 컷 합계에서 유도하므로 여기서는 쓰지 않지만 호출자가 같은 문맥을 넘긴다.
  readonly targetSec: number;
  // 광고안에 카드뉴스가 있을 때만 card_slide 컷을 쓸 수 있다(없으면 R4 가 대표 이미지로 바꾼다).
  readonly hasCardSlides?: boolean;
};
export type Repaired<T> = {
  readonly value: T;
  readonly repairs: string[];
  // 수리로 생긴 soft 경고(사용자에게 보여 줄 것): 자막 자름·대표 이미지 강제 배치·쓰지 않는 선언 삭제·답 시점 이동.
  readonly warnings: string[];
};

const SOURCE_LABELS: Record<SentenceCutResponse["source"], string> = {
  approved_image: "대표 이미지",
  card_slide: "카드뉴스",
  veo_clip: "Veo 클립",
  project_clip: "촬영본",
  motion_graphic: "모션그래픽",
  still_image: "정지 이미지",
};

// R4 소스별 부속 필드 정리: 모션그래픽이 아닌데 글줄/종류, Veo 클립이 아닌데 veoClip, 정지 이미지가 아닌데 stillId 가 있으면 비운다.
// 모션그래픽인데 종류가 없으면 callout, 글줄이 없으면 자막 줄로 채운다(둘 다 비면 hard 로 남는다). 카드뉴스 없는 광고안의 card_slide 는 대표 이미지로.
function hygiene(
  cut: SentenceCutResponse,
  where: string,
  ctx: Pick<ScriptContext, "hasCardSlides">,
  repairs: string[],
): SentenceCutResponse {
  let next = { ...cut, graphicLines: [...cut.graphicLines] };
  if (next.source === "card_slide" && ctx.hasCardSlides === false) {
    next = { ...next, source: "approved_image" };
    repairs.push(`${where}: 카드뉴스가 없는 광고안이라 card_slide → 대표 이미지(approved_image)`);
  }
  const label = SOURCE_LABELS[next.source];
  if (next.source !== "motion_graphic") {
    if (next.graphicLines.length > 0) {
      repairs.push(`${where}(${label})의 graphicLines ${next.graphicLines.length}줄 삭제`);
      next = { ...next, graphicLines: [] };
    }
    if (next.graphicKind !== "") {
      repairs.push(`${where}(${label})의 graphicKind "${next.graphicKind}" 삭제`);
      next = { ...next, graphicKind: "" };
    }
  } else {
    if (next.graphicLines.length === 0 && next.onScreenText.trim().length > 0) {
      const lines = next.onScreenText
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 4)
        .map((item) => [...item].slice(0, 24).join(""));
      next = { ...next, graphicLines: lines };
      repairs.push(`${where}(모션그래픽)의 글줄이 비어 자막 ${lines.length}줄을 글줄로 채움`);
    }
    if (next.graphicKind === "" && next.graphicLines.length > 0) {
      next = { ...next, graphicKind: "callout" };
      repairs.push(`${where}(모션그래픽)의 graphicKind 가 비어 callout 으로 채움`);
    }
  }
  if (next.source !== "veo_clip" && next.veoClip !== "") {
    repairs.push(`${where}(${label})의 veoClip ${next.veoClip} 삭제`);
    next = { ...next, veoClip: "" };
  }
  if (next.source !== "still_image" && next.stillId !== "") {
    repairs.push(`${where}(${label})의 stillId ${next.stillId} 삭제`);
    next = { ...next, stillId: "" };
  }
  return next;
}

// 중첩 형태에서 컷 단위 기계 수리(R1~R6). 문장 순서·문장 수는 바꾸지 않는다.
export function repairSentences(
  response: VideoScriptResponse,
  ctx: Pick<ScriptContext, "hasCardSlides">,
): Repaired<VideoScriptResponse> {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const sentences: SentenceResponse[] = response.sentences.map((sentence, index) => {
    const where = `${index + 1}번째 문장`;
    // R4 부속 필드 정리. 계획한 컷 길이와 효과는 유지한다.
    const cuts = sentence.cuts.map((cut, k) =>
      hygiene(cut, `${where} ${k + 1}번째 컷`, ctx, repairs),
    );
    return { ...sentence, cuts };
  });
  // R5 대표 이미지 컷 보장: 하나도 없으면 마지막 컷(cta)을 대표 이미지로 바꾼다(재개 검사가 대표 이미지 컷을 요구한다).
  if (!sentences.some((sentence) => sentence.cuts.some((cut) => cut.source === "approved_image"))) {
    const last = sentences[sentences.length - 1];
    const cut = last?.cuts[last.cuts.length - 1];
    if (last && cut) {
      last.cuts[last.cuts.length - 1] = {
        ...cut,
        source: "approved_image",
        veoClip: "",
        stillId: "",
        graphicKind: "",
        graphicLines: [],
      };
      repairs.push(
        `대표 이미지(approved_image) 컷이 없어 ${sentences.length}번째 문장의 마지막 컷을 대표 이미지로 바꿈`,
      );
      warnings.push(
        "대표 이미지 컷이 없어 마지막 컷을 대표 이미지로 바꿨습니다. 행동 유도 장면의 구도를 확인하세요.",
      );
    }
  }
  // R6 쓰지 않는 선언 삭제(유료 생성 낭비 방지). flowPrompt 가 지운 클립의 프롬프트였으면 남은 첫 클립(없으면 첫 정지 이미지)으로.
  const usedClips = new Set<string>();
  const usedStills = new Set<string>();
  for (const sentence of sentences)
    for (const cut of sentence.cuts) {
      if (cut.source === "veo_clip" && cut.veoClip) usedClips.add(cut.veoClip);
      if (cut.source === "still_image" && cut.stillId) usedStills.add(cut.stillId);
    }
  const veoClips = response.veoClips.filter((clip) => usedClips.has(clip.id));
  const stills = response.stills.filter((still) => usedStills.has(still.id));
  const removedClips = response.veoClips.filter((clip) => !usedClips.has(clip.id));
  const removedStills = response.stills.filter((still) => !usedStills.has(still.id));
  if (removedClips.length > 0) {
    repairs.push(`쓰지 않는 Veo 클립 선언 삭제: ${removedClips.map((clip) => clip.id).join(", ")}`);
    warnings.push(
      `선언만 하고 쓰지 않은 Veo 클립 ${removedClips.map((clip) => clip.id).join(", ")}을 뺐습니다(유료 생성 낭비 방지).`,
    );
  }
  if (removedStills.length > 0) {
    repairs.push(
      `쓰지 않는 정지 이미지 선언 삭제: ${removedStills.map((still) => still.id).join(", ")}`,
    );
    warnings.push(
      `선언만 하고 쓰지 않은 정지 이미지 ${removedStills.map((still) => still.id).join(", ")}을 뺐습니다(유료 생성 낭비 방지).`,
    );
  }
  let flowPrompt = response.flowPrompt;
  if (removedClips.some((clip) => clip.prompt === flowPrompt)) {
    const replacement = veoClips[0]?.prompt ?? stills[0]?.prompt;
    if (replacement && replacement !== flowPrompt) {
      flowPrompt = replacement;
      repairs.push(
        `flowPrompt 가 지운 클립의 프롬프트라 ${veoClips[0] ? `클립 ${veoClips[0].id}` : `정지 이미지 ${stills[0]?.id ?? ""}`}의 프롬프트로 바꿈`,
      );
    }
  }
  return { value: { ...response, sentences, veoClips, stills, flowPrompt }, repairs, warnings };
}

// 중첩 응답을 평면 대본으로: 컷 시간은 0초부터 연속, 컷 목적은 문장 목적을 상속, 음성 범위는 문장이 가진 컷 번호.
// 그래서 fromCut/toCut 은 항상 유효·순서대로·겹침 없음, 말 없는 컷 0개, 길이 = 컷 합계(모델이 적지 않음), 마지막 컷 끝 = durationSec.
export function flattenSentences(response: VideoScriptResponse, ctx: ScriptContext): FlatScript {
  const cuts: FlatCut[] = [];
  const voiceover: FlatScript["voiceover"] = [];
  let start = 0;
  for (const sentence of response.sentences) {
    const fromCut = cuts.length;
    for (const cut of sentence.cuts) {
      cuts.push({
        startSec: start,
        endSec: Math.round((start + cut.len) * 1000) / 1000,
        purpose: sentence.purpose,
        screenComposition: cut.screenComposition,
        onScreenText: cut.onScreenText,
        source: cut.source,
        effect: cut.effect,
        veoClip: cut.veoClip,
        stillId: cut.stillId,
        graphicKind: cut.graphicKind,
        graphicLines: [...cut.graphicLines],
      });
      start = Math.round((start + cut.len) * 1000) / 1000;
    }
    voiceover.push({
      fromCut,
      toCut: Math.max(fromCut, cuts.length - 1),
      purpose: sentence.purpose,
      text: sentence.text,
    });
  }
  return {
    number: ctx.number,
    hypothesisId: ctx.hypothesisId,
    title: response.title,
    fixedTitle: response.fixedTitle,
    disclaimer: response.disclaimer,
    voicePersona: response.voicePersona,
    durationSec: start,
    openLoop: response.openLoop,
    payoffSec: response.payoffSec,
    cuts,
    voiceover,
    styleAnchor: response.styleAnchor,
    veoClips: response.veoClips.map((clip) => ({ ...clip })),
    stills: response.stills.map((still) => ({ ...still })),
    flowPrompt: response.flowPrompt,
    editInstructions: response.editInstructions,
  };
}

// 구절 자막을 한 줄로 정리하되 숫자·내용은 전부 보존한다. 긴 자막은 규칙 검사에서 경고한다.
export function wrapCaption(text: string): {
  readonly text: string;
  readonly changed: boolean;
  readonly truncated: boolean;
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  return { text: normalized, changed: normalized !== text, truncated: false };
}

// 컷 열 전체의 기계 수리: 자막 공백과 영상 범위를 벗어난 답 시점만 정리한다.
export function repairFlat(flat: FlatScript): Repaired<FlatScript> {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const cuts = flat.cuts.map((cut) => ({ ...cut, graphicLines: [...cut.graphicLines] }));
  // R7 자막
  cuts.forEach((cut, index) => {
    if (!cut.onScreenText) return;
    const wrapped = wrapCaption(cut.onScreenText);
    if (!wrapped.changed) return;
    cuts[index] = { ...cut, onScreenText: wrapped.text };
    repairs.push(`컷 ${index} 자막의 줄바꿈·공백을 정리했습니다(내용 유지)`);
  });
  // R10 payoffSec는 정수 초다. 소수 길이에서도 저장 스키마를 지키도록 상한을 내린다.
  const low = 1;
  const high = Math.max(low, Math.ceil(flat.durationSec) - 1);
  let payoffSec = flat.payoffSec;
  if (payoffSec < low || payoffSec > high) {
    payoffSec = Math.min(high, Math.max(low, payoffSec));
    repairs.push(`궁금증의 답 시점(payoffSec) ${flat.payoffSec}초 → ${payoffSec}초로 옮김`);
    warnings.push(`궁금증의 답 시점을 영상 시간 안인 ${payoffSec}초로 옮겼습니다.`);
  }
  return { value: { ...flat, cuts, payoffSec }, repairs, warnings };
}

// 기존 호출자 호환용. 컷 길이만으로 장면을 분할하거나 계획한 구도·효과·음성 범위를 바꾸지 않는다.
export function splitSlowCuts(script: VideoScript): VideoScript {
  return script;
}

// 모델 응답 → 저장 대본: 수리(중첩) → 평면화 → 수리(컷 열) → 저장 형식(시간 유도·내레이션 배치·Veo 프롬프트).
export function videoScriptFromResponse(
  response: VideoScriptResponse,
  ctx: ScriptContext,
): { readonly script: VideoScript; readonly repairs: string[]; readonly warnings: string[] } {
  const sentences = repairSentences(response, ctx);
  const flat = repairFlat(flattenSentences(sentences.value, ctx));
  const script = videoScriptFromFlat(flat.value);
  const repairs = [...sentences.repairs, ...flat.repairs];
  return { script, repairs, warnings: [...sentences.warnings, ...flat.warnings] };
}
