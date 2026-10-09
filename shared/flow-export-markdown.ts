import {
  EXPLAINER_COLOR_LABELS,
  EXPLAINER_EMPHASIS_LABELS,
  EXPLAINER_SCENE_LABELS,
  type FlowExport,
  flowClipIsExplainerScene,
  infoClipExpectsText,
} from "./flow-mode";

const numbered = (lines: readonly string[]) => lines.map((line, index) => `${index + 1}) ${line}`);
const sceneLabel = (sceneType: string) =>
  sceneType in EXPLAINER_SCENE_LABELS
    ? EXPLAINER_SCENE_LABELS[sceneType as keyof typeof EXPLAINER_SCENE_LABELS]
    : sceneType;

// 혼합형 설명 장면(2026-10-07, H5): 실사 시작 이미지를 참조로 쓰지 않는 설명 세계 CLEAN → 강조(+인포그래픽)를 더한 INFO → 전환 영상.
// INFO 문구(infoLines, 2026-10-08)가 있으면 글자를 지정 문구와 대조하고, 없는 예전 장면은 "글자 없음" 방식이다. 사람 유무는 눈으로 본다.
function explainerSection(clip: FlowExport["infoClips"][number]): string[] {
  if (clip.labelLayer)
    return [
      `## 설명 장면 ${clip.id} (글자 없는 Veo + HyperFrames 라벨)`,
      "",
      `1. 설명 세계 CLEAN을 만들고 ${clip.cleanFile}로 저장한다. 실사 시작 이미지를 섞지 않는다.`,
      `2. 같은 물체의 최종 상태와 3D 구조·윤곽·가이드선·흐름 화살표를 INFO에 완성해 ${clip.infoFile}로 저장한다. 글자·라벨판·라벨 연결선·끝점은 넣지 않는다.`,
      "3. 사용자에게 CLEAN·INFO를 보여 준 뒤 업로드한다. 글자나 라벨용 그래픽 검사 오류는 보고하고 임의 우회·재생성하지 않는다.",
      ...clip.imageImportCommands.map((command) => `   - ${command}`),
      `4. Veo 3.1 Lite·9:16·8초·x1과 실제 비용을 화면에서 확인한다. CLEAN 첫 프레임·INFO 마지막 프레임으로 만들고 원본 전체를 재생해 변형·임의 글자·가림을 검수한다. ${clip.outputFile}: ${clip.importCommand}`,
      "5. 아래 라벨 계획은 HyperFrames 인계용이다. Veo 프롬프트에 붙이지 않는다. 실제 영상의 대상 좌표·시각을 확인한다. 앱이 03 라벨·연결선을 자동 합성하며 자동 대상 추적은 하지 않는다.",
      "",
      "HyperFrames 라벨 계획 (원본 8초 시각, 좌표는 계획값):",
      "```json",
      JSON.stringify({ infoLines: clip.infoLines, labelLayer: clip.labelLayer }, null, 2),
      "```",
      "",
    ];
  const objects = clip.objects.map(
    (object) =>
      `${object.subjectId}(${EXPLAINER_COLOR_LABELS[object.color]}${object.traits ? `: ${object.traits}` : ""})`,
  );
  const emphasis = clip.emphasis.map(
    (item) =>
      `${EXPLAINER_EMPHASIS_LABELS[item.kind]} → ${item.target} (동작 ${item.afterAction + 1} 뒤)`,
  );
  const labels = clip.infoLines.length > 0;
  return [
    `## 설명 장면 ${clip.id} (${clip.stage} · ${sceneLabel(clip.sceneType)})`,
    "",
    `1. 설명 세계 CLEAN: 실사 시작 이미지(flow-start-*.png)는 첨부하지 않는다(사람·사진이 섞인다). 같은 영상에서 먼저 만든 설명 장면 CLEAN 이 있으면 그것을 + 메뉴로 참조 첨부해 같은 모형 세계와 같은 물체 색을 유지한다. 아래 CLEAN 프롬프트로 이미지를 만들어 ${clip.cleanFile} 로 내려받는다. CLEAN 에는 사람·글자·화살표·이름표·링이 없어야 한다.`,
    labels
      ? `2. CLEAN 이미지를 채팅 + 메뉴로 첨부하고 INFO 프롬프트로 강조(색 구분·빨간 외곽선·흰 발광선·반투명 비유)와 인포그래픽(굵은 화살표·치수선·강조 링·한글 라벨·숫자)을 완성한 이미지를 만들어 ${clip.infoFile} 로 내려받는다. INFO 의 글자는 아래 '넣을 문구'와 정확히 같아야 하고(다른 글자·영문·깨진 한글 금지) 사람이 없어야 한다. 글자가 다르거나 깨졌으면 다시 만든다(이미지 재생성은 크레딧 0).`
      : `2. CLEAN 이미지를 채팅 + 메뉴로 첨부하고 INFO 프롬프트로 강조(색 구분·빨간 외곽선·흰 발광선·반투명 비유)만 더한 이미지를 만들어 ${clip.infoFile} 로 내려받는다. INFO 에는 글자·숫자·이름표·지시선·표가 없어야 하고 사람이 없어야 한다. 글자나 사람이 보이면 다시 만든다.`,
    labels
      ? "3. 두 이미지를 앱에 올린다(INFO 는 앱이 글자를 넣을 문구와 자동 대조해 빠지거나 다른 글자가 있으면 거부한다; 사람 유무는 눈으로 확인한다):"
      : "3. 두 이미지를 앱에 올린다(INFO 는 앱이 글자 유무를 자동 검사해 읽히는 글자가 있으면 거부한다; 사람 유무는 눈으로 확인한다):",
    ...clip.imageImportCommands.map((command) => `   - \`${command}\``),
    labels
      ? `4. CLEAN 을 첫 프레임, INFO 를 마지막 프레임으로 첨부해 영상 프롬프트로 9:16·8초 영상을 만들고 ${clip.outputFile} 로 내려받아 올린다: \`${clip.importCommand}\`. 재생해서 라벨·숫자가 둘째 구간부터 완성된 모양으로 나타나 끝까지 선명한지, 그 밖의 글자·사람이 없는지, 동작이 순서대로 끝나는지 확인한다.`
      : `4. CLEAN 을 첫 프레임, INFO 를 마지막 프레임으로 첨부해 영상 프롬프트로 9:16·8초 영상을 만들고 ${clip.outputFile} 로 내려받아 올린다: \`${clip.importCommand}\`. 재생해서 어느 순간에도 글자·사람이 없고 동작이 순서대로 끝나는지 확인한다.`,
    "",
    `장면: ${sceneLabel(clip.sceneType)} · 물체: ${objects.join(" / ") || "(없음)"}`,
    `동작 순서: ${numbered(clip.actions).join(" ") || "(없음)"}`,
    `강조: ${emphasis.join(" / ") || "(없음)"}`,
    ...(labels ? [`넣을 문구(정확히): ${clip.infoLines.join(" / ")}`] : []),
    "",
  ];
}

// 사람·에이전트가 그대로 따라 할 수 있는 단계 목록. 같은 데이터(FlowExport)에서만 만든다.
export function flowExportMarkdown(data: FlowExport): string {
  const lines = [
    `# Flow 클립 제작 지시 · 영상 ${data.number} · ${data.title}`,
    "",
    `작업 ID: ${data.jobId}`,
    `Flow 주소: ${data.flowUrl}`,
    `클립 ${data.clips.length}개를 만들어 앱에 업로드하면 앱이 내레이션·정지 이미지·모션그래픽과 조립해 완성 영상을 만든다.`,
    ...(data.visualPolicy === "hybrid_explainer_v1"
      ? [
          data.infoClips.some((clip) => clip.labelLayer)
            ? "혼합형: 실사는 사람과 상황, 설명은 3D 모형 세계다. HyperFrames 라벨 계획이 있는 컷의 INFO·Veo는 글자가 없고 문구와 연결선은 별도 합성한다. 원본을 업로드하면 앱이 03 라벨 세트를 자동 합성한다."
            : "혼합형(hybrid_explainer_v1): 실사 클립(A~D)에는 사람과 상황이 보여야 하고, 설명 장면(I1~I3)은 사람 없는 클레이·화이트 3D 모형 세계다. 설명 장면의 글자는 INFO 이미지에 넣을 문구(인포그래픽 라벨·숫자)와 앱 자막 한 줄뿐이다.",
        ]
      : []),
    "Flow 화면 조작 순서는 실제 화면에서 확인된 적이 없다(미검증). 화면이 다르면 화면에 맞게 조정하되 아래 값(비율·길이·프롬프트·시작 이미지)은 바꾸지 않는다.",
    "자세한 절차: FLOW-MODE.md",
    "",
    "## 공통 순서",
    "",
    ...data.checklist.map((step, index) => `${index + 1}. ${step}`),
    "",
  ];
  for (const clip of data.clips)
    lines.push(
      `## 클립 ${clip.id}`,
      "",
      `- 시작 이미지: ${clip.startImageFile} (앱 산출물 ${clip.startImageArtifact})`,
      `- 모델: ${clip.suggestedModel}`,
      `- 비율·길이: ${clip.aspectRatio} · ${clip.durationSec}초`,
      `- 내려받을 파일 이름: ${clip.outputFile}`,
      `- 업로드: \`${clip.importCommand}\``,
      "",
      "프롬프트(수정 없이 그대로):",
      "",
      "```text",
      clip.prompt,
      "```",
      "",
    );
  for (const clip of data.infoClips) {
    if (flowClipIsExplainerScene(clip)) {
      lines.push(...explainerSection(clip), ...promptBlocks(clip));
      continue;
    }
    const expectsLabels = infoClipExpectsText(clip);
    lines.push(
      `## 설명 컷 ${clip.id} (${clip.stage})`,
      "",
      `1. 같은 영상의 시작 이미지(flow-start-*.png, 인물·제품 기준)를 + 메뉴로 참조 첨부하고 아래 CLEAN 프롬프트로 이미지를 만들어 ${clip.cleanFile} 로 내려받는다. 참조 없이 만들면 다른 인물·제품이 나온다. CLEAN 에는 글자·화살표·라벨·강조 링이 없어야 한다.`,
      expectsLabels
        ? `2. CLEAN 이미지를 채팅 + 메뉴로 첨부하고 INFO 프롬프트로 화살표·연결선·라벨까지 완성한 인포그래픽 이미지를 만들어 ${clip.infoFile} 로 내려받는다. 글자가 지정 문구와 같은지 화면에서 확인한다.`
        : `2. CLEAN 이미지를 채팅 + 메뉴로 첨부하고 INFO 프롬프트로 그래픽을 입힌 이미지를 만들어 ${clip.infoFile} 로 내려받는다. INFO 에는 글자·숫자·라벨이 없어야 한다(이 컷의 프롬프트 기준). 글자가 보이면 다시 만든다.`,
      expectsLabels
        ? "3. 두 이미지를 앱에 올린다(INFO 는 앱이 글자를 지정 문구와 자동 대조한다):"
        : "3. 두 이미지를 앱에 올린다(INFO 는 앱이 글자 유무를 자동 검사해 읽히는 글자가 있으면 거부한다):",
      ...clip.imageImportCommands.map((command) => `   - \`${command}\``),
      `4. CLEAN 을 첫 프레임, INFO 를 마지막 프레임으로 첨부해 영상 프롬프트로 9:16·8초 영상을 만들고 ${clip.outputFile} 로 내려받아 올린다: \`${clip.importCommand}\``,
      "",
    );
    if (clip.explanation)
      lines.push(
        "설명 설계: INFO 이미지에서 대상의 형태·구성·변화와 연결선·라벨을 먼저 완성합니다. 영상에서는 같은 대상과 라벨을 유지합니다. 아래 진행 비율은 생성 전 계획이며 실제 동작 추적 결과가 아닙니다. 영상의 글자 보존·연결선 위치·말과 동작은 재생해서 확인합니다.",
        "",
        "```json",
        JSON.stringify(clip.explanation, null, 2),
        "```",
        "",
      );
    if (expectsLabels) lines.push(`넣을 문구(정확히): ${clip.infoLines.join(" / ")}`, "");
    else if (clip.graphicOrder.length > 0)
      lines.push(`그래픽 순서: ${numbered(clip.graphicOrder).join(" ")}`, "");
    lines.push(...promptBlocks(clip));
  }
  return lines.join("\n");
}
// 설명 컷의 세 프롬프트 블록(정책 공통).
function promptBlocks(clip: FlowExport["infoClips"][number]): string[] {
  return [
    "CLEAN 프롬프트:",
    "",
    "```text",
    clip.cleanPrompt,
    "```",
    "",
    "INFO 프롬프트:",
    "",
    "```text",
    clip.infoPrompt,
    "```",
    "",
    "영상 프롬프트:",
    "",
    "```text",
    clip.motionPrompt,
    "```",
    "",
  ];
}
