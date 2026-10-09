import { useState } from "react";
import {
  EXPLAINER_COLOR_LABELS,
  EXPLAINER_EMPHASIS_LABELS,
  EXPLAINER_SCENE_LABELS,
  type FlowExportInfoClip,
  flowClipIsExplainerScene,
  infoClipExpectsText,
} from "../shared/flow-mode";
import type { Job } from "../shared/schema";
import { thresholds } from "../shared/thresholds";
import type { InfoClipId } from "../shared/video-script";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";

const stages = {
  real_cause: "진짜 원인",
  criteria: "봐야 할 기준",
  mechanism: "우리 상품이 푸는 방식",
  verification: "직접 확인하는 방법",
} as const;

// 설명 컷(CLEAN → INFO 전환): Flow 에서 CLEAN 사진 → (CLEAN 첨부) INFO 사진 → 두 장을 첫·마지막 프레임으로 영상.
// 설명 설계가 있는 컷은 그래픽과 라벨을 완성한 INFO 이미지로 영상을 만든다.
// 기존 글자 없는 INFO와 infoLines 전용 대본도 각 저장 방식에 맞는 안내를 유지한다.
// 혼합형 설명 장면(2026-10-07, sceneType 있음)은 사람 없는 3D 물체 장면 + 강조. 2026-10-08 부터 INFO 문구(infoLines)가 있으면
// 인포그래픽(화살표·치수선·링·한글 라벨·숫자)을 이미지 안에 완성하고 앱이 업로드 때 글자를 대조한다; 없는 예전 장면은 글자 없음 검사다.
function ExplainerScene({ clip }: { readonly clip: FlowExportInfoClip }) {
  const scene = clip.sceneType === "" ? clip.sceneType : EXPLAINER_SCENE_LABELS[clip.sceneType];
  return (
    <>
      {clip.labelLayer ? (
        <>
          <p className="muted small-copy">
            INFO에는 글자 없이 3D 구조·윤곽선·가이드선·흐름 화살표를 완성합니다. 라벨판·문구용
            연결선·끝점은 넣지 않습니다. 업로드 때 글자와 라벨용 그래픽을 검사합니다.
          </p>
          <p className="small-copy">
            <strong>별도 합성할 문구:</strong> {clip.infoLines.join(" / ")}
          </p>
          <p className="muted small-copy">
            라벨 좌표는 계획값입니다. 실제 영상에서 대상을 확인한 뒤 맞춰야 하며, 자동 추적 결과가
            아닙니다.
          </p>
        </>
      ) : clip.infoLines.length > 0 ? (
        <>
          <p className="muted small-copy">
            혼합형 설명 장면({scene}): 사람 없는 클레이·화이트 3D 모형 세계입니다. INFO 에는 강조와
            인포그래픽(굵은 화살표·치수선·강조 링·한글 라벨·숫자)을 완성하고, 글자는 아래 문구와
            정확히 같아야 합니다. 업로드 때 글자를 자동 대조하고(다르면 거부, 이미지 재생성은 크레딧
            0), 사람이 없는지는 눈으로 확인합니다. 실사 시작 이미지는 참조로 첨부하지 마세요.
          </p>
          <p className="small-copy">
            <strong>넣을 문구(정확히):</strong> {clip.infoLines.join(" / ")}
          </p>
        </>
      ) : (
        <p className="muted small-copy">
          혼합형 설명 장면({scene}): 사람 없는 클레이·화이트 3D 모형 세계입니다. INFO 에는
          글자·숫자·이름표·지시선을 넣지 않고 강조만 더합니다(설명 세계의 글자는 앱 자막 한 줄뿐).
          업로드 때 글자 유무를 자동 검사하고, 사람이 없는지는 눈으로 확인합니다. 실사 시작 이미지는
          참조로 첨부하지 마세요.
        </p>
      )}
      <p className="small-copy">
        <strong>물체:</strong>{" "}
        {clip.objects
          .map(
            (object) =>
              `${object.subjectId}(${EXPLAINER_COLOR_LABELS[object.color]}${object.traits ? `: ${object.traits}` : ""})`,
          )
          .join(" / ")}
      </p>
      {clip.actions.length > 0 ? (
        <ol className="small-copy">
          {clip.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      ) : null}
      {clip.emphasis.length > 0 ? (
        <p className="small-copy">
          <strong>강조:</strong>{" "}
          {clip.emphasis
            .map(
              (item) =>
                `${EXPLAINER_EMPHASIS_LABELS[item.kind]} → ${item.target} (동작 ${item.afterAction + 1} 뒤)`,
            )
            .join(" / ")}
        </p>
      ) : null}
    </>
  );
}
export function FlowInfoClips({
  job,
  number,
  clips,
  canUpload,
  onUploadClip,
}: {
  readonly job: Job;
  readonly number: number;
  readonly clips: readonly FlowExportInfoClip[];
  readonly canUpload: boolean;
  readonly onUploadClip: (id: InfoClipId, file: File) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (clips.length === 0) return null;
  const render = job.renders.find((item) => item.number === number);
  const artifact = (name: string | null | undefined) =>
    name ? job.artifacts.find((item) => item.name === name) : undefined;
  const uploadImage = async (id: InfoClipId, which: "clean" | "info", file: File) => {
    const key = `${id}-${which}`;
    setPending(key);
    setErrors((current) => ({ ...current, [key]: "" }));
    try {
      await api.post(`jobs/${job.id}/videos/${number}/info/${id}/${which}`, {
        body: file,
        headers: { "Content-Type": file.type || "image/png" },
        timeout: false,
      });
    } catch (cause) {
      const message = await errorMessage(cause);
      setErrors((current) => ({ ...current, [key]: message }));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="stack">
      <h4>설명 컷 · CLEAN → INFO → 영상 {clips.length}개</h4>
      <ul className="stack flow-clips">
        {clips.map((clip) => {
          const id = clip.id as InfoClipId;
          const explainer = flowClipIsExplainerScene(clip);
          const expectsLabels = infoClipExpectsText(clip);
          const state = render?.infoImages[id];
          const video = artifact(render?.clips[id]?.name);
          return (
            <li className="flow-clip flow-info-clip stack-tight" key={clip.id}>
              <strong>
                {clip.id} · {stages[clip.stage as keyof typeof stages] ?? clip.stage}
              </strong>
              {explainer ? (
                <ExplainerScene clip={clip} />
              ) : expectsLabels ? (
                <p>
                  {clip.explanation
                    ? "화살표·연결선·라벨을 함께 넣은 INFO 이미지를 완성한 뒤 영상으로 만듭니다. "
                    : ""}
                  <strong>넣을 문구(정확히):</strong> {clip.infoLines.join(" / ")}
                </p>
              ) : (
                <>
                  <p className="muted small-copy">
                    {clip.explanation
                      ? "이 설명 컷에는 이름표 문구가 없습니다. INFO 이미지의 구조·비교 그래픽을 완성한 뒤 영상으로 만듭니다. 글자·숫자·라벨을 추가하지 마세요."
                      : "INFO 이미지에는 글자·숫자·라벨을 넣지 않습니다. 글자는 앱이 콜아웃으로 그리고, 업로드 때 글자 유무를 자동 검사합니다."}
                    그래픽은 중간 띠(높이 {thresholds().INFO_GRAPHIC_BAND_TOP}~
                    {thresholds().INFO_GRAPHIC_BAND_BOTTOM}%) 안에 아래 순서로 넣습니다.
                  </p>
                  {clip.graphicOrder.length > 0 ? (
                    <ol className="small-copy">
                      {clip.graphicOrder.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ol>
                  ) : null}
                </>
              )}
              <details>
                <summary>Flow 프롬프트 보기 (CLEAN · INFO · 영상)</summary>
                <p className="muted small-copy">CLEAN 프롬프트</p>
                <pre className="flow-prompt">{clip.cleanPrompt}</pre>
                <p className="muted small-copy">INFO 프롬프트</p>
                <pre className="flow-prompt">{clip.infoPrompt}</pre>
                <p className="muted small-copy">영상 프롬프트</p>
                <pre className="flow-prompt">{clip.motionPrompt}</pre>
              </details>
              {(["clean", "info"] as const).map((which) => {
                const key = `${clip.id}-${which}`;
                const saved = artifact(which === "clean" ? state?.clean : state?.info);
                const infoLabel = expectsLabels
                  ? "INFO 이미지 (지정 문구 자동 대조)"
                  : "INFO 이미지 (글자 없음 자동 확인)";
                const infoStatus = state?.verified
                  ? " · 글자 확인 통과"
                  : expectsLabels
                    ? " · 글자 불일치"
                    : clip.labelLayer
                      ? " · 검사 미통과"
                      : " · 글자 발견";
                return (
                  <label className="stack-tight" key={which}>
                    <span>
                      {which === "clean" ? "CLEAN 이미지" : infoLabel}
                      {saved ? " · 업로드됨" : ""}
                      {which === "info" && state?.info ? infoStatus : ""}
                    </span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={!canUpload || pending === key}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadImage(id, which, file);
                        event.target.value = "";
                      }}
                    />
                    {errors[key] ? <Notice tone="error">{errors[key]}</Notice> : null}
                  </label>
                );
              })}
              {state?.problems.length ? (
                <Notice tone="warning">{state.problems.join(" ")}</Notice>
              ) : null}
              <label className="stack-tight">
                <span>전환 영상 (MP4){video ? " · 업로드됨" : ""}</span>
                <input
                  type="file"
                  accept="video/mp4"
                  disabled={!canUpload || !state?.verified}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onUploadClip(id, file);
                    event.target.value = "";
                  }}
                />
              </label>
              {clip.labelLayer ? (
                <p className="muted small-copy">
                  글자 없는 원본을 올리면 03 라벨·연결선이 자동 합성됩니다. 완성본에서 대상 위치와
                  가독성을 확인하세요.
                </p>
              ) : !state?.verified ? (
                <p className="muted small-copy">
                  {expectsLabels
                    ? "INFO 이미지의 글자 확인을 통과해야 영상을 올릴 수 있습니다."
                    : "INFO 이미지에 읽히는 글자가 없어야 영상을 올릴 수 있습니다."}
                </p>
              ) : null}
              {video ? (
                <Button onClick={() => window.open(video.url, "_blank")}>영상 보기</Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
