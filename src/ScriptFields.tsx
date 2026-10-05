import { type VideoScript, voiceCutRange, voicePurposeOf } from "../shared/video-script";

const purposes = {
  hook: "후킹",
  pain: "페인포인트",
  story: "스토리·원인",
  mechanism: "메커니즘",
  proof: "근거·신뢰",
  offer: "혜택",
  cta: "행동 유도",
  rehook: "다시 붙잡기",
  problem: "문제",
  solution: "해결 장면",
} as const;
const sources = {
  approved_image: "대표 이미지",
  card_slide: "카드뉴스 장면",
  veo_clip: "Veo 클립",
  project_clip: "프로젝트 영상",
  motion_graphic: "모션그래픽",
  still_image: "정지 이미지",
} as const;
const graphics = {
  "": "",
  number: "숫자",
  checklist: "체크리스트",
  compare: "비교",
  question: "질문",
  callout: "강조 문구",
} as const;
const effects = {
  hard_cut: "",
  zoom_punch: "줌 펀치",
  whip_pan: "휙 넘김",
  text_pop: "텍스트 팝",
  split_screen: "화면 분할",
  speed_ramp: "속도 변화",
  shake: "흔들림",
  freeze_frame: "정지 화면",
} as const;
function isPurpose(value: string): value is keyof typeof purposes {
  return value in purposes;
}

type Props = {
  readonly script: VideoScript;
  readonly original: VideoScript;
  readonly voices: readonly string[];
  readonly captions: readonly string[];
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onVoiceChange: (index: number, text: string) => void;
  readonly onCaptionChange: (index: number, text: string) => void;
};
export function ScriptFields({
  script,
  original,
  voices,
  captions,
  editable,
  busy,
  onVoiceChange,
  onCaptionChange,
}: Props) {
  return (
    <>
      <p className="muted small-copy">
        한 문장에 연결된 여러 컷을 함께 보여 줍니다. 문장과 컷의 목적은 다를 수 있고, 화면에만
        표시하는 숫자도 사용할 수 있습니다. 말과 그림의 의미가 맞는지는 AI 검토와 함께 확인하세요.
      </p>
      <ol className="script-lines" aria-label="내레이션 문장">
        {script.voiceover.map((voice, index) => {
          const range = voiceCutRange(voice, script.cuts);
          const purpose = voicePurposeOf(voice, script.cuts);
          const label = isPurpose(purpose) ? purposes[purpose] : "";
          return (
            <li key={original.voiceover[index]?.startSec}>
              <span className="script-time">
                {index + 1} · {voice.startSec}–{voice.endSec}초
                {range && (
                  <>
                    <br />컷 {range[0]}
                    {range[1] !== range[0] && `~${range[1]}`}
                    {label && ` · ${label}`}
                  </>
                )}
              </span>
              <div className="stack-tight">
                {editable ? (
                  <textarea
                    className="script-line-input"
                    readOnly={busy}
                    rows={2}
                    value={voices[index] ?? ""}
                    aria-label={`${index + 1}번째 내레이션 문장`}
                    onChange={(event) => onVoiceChange(index, event.target.value)}
                  />
                ) : (
                  <p className="script-line-text">{voice.text}</p>
                )}
                {range && (
                  <ul className="script-cuts" aria-label={`${index + 1}번째 문장의 컷`}>
                    {script.cuts.slice(range[0], range[1] + 1).map((cut, offset) => {
                      const cutIndex = range[0] + offset;
                      const caption = cut.onScreenText;
                      return (
                        <li key={cutIndex}>
                          <span className="script-cut-head">
                            컷 {cutIndex} · {cut.startSec}–{cut.endSec}초 · {sources[cut.source]}
                            {cut.veoClip && ` ${cut.veoClip}`}
                            {cut.stillId && ` ${cut.stillId}`}
                            {cut.purpose !== purpose && cut.purpose !== "rehook" && (
                              <span className="badge badge-warning">
                                목적 {purposes[cut.purpose]}
                              </span>
                            )}
                          </span>
                          <span>{cut.screenComposition}</span>
                          {(caption || cut.graphicLines.length > 0) && (
                            <span className="muted">
                              {caption && `자막: ${caption.replace("\n", " / ")}`}
                              {caption && cut.graphicLines.length > 0 && " · "}
                              {cut.graphicLines.length > 0 &&
                                `글줄: ${cut.graphicLines.join(" / ")}`}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="stack">
        {script.cuts.map((cut, index) => (
          <section className="source-citation" key={`${cut.startSec}-${cut.endSec}`}>
            <strong>
              컷 {index} · {cut.startSec}–{cut.endSec}초 · {purposes[cut.purpose]}
              {effects[cut.effect] && ` · ${effects[cut.effect]}`}
            </strong>
            <p>화면: {cut.screenComposition}</p>
            {editable ? (
              <label className="script-caption">
                <span>자막</span>
                <textarea
                  rows={2}
                  readOnly={busy}
                  aria-label={`컷 ${index} 자막`}
                  value={captions[index] ?? ""}
                  placeholder="없음"
                  maxLength={120}
                  onChange={(event) => onCaptionChange(index, event.target.value)}
                />
                {captions[index]?.trim() !== cut.onScreenText && (
                  <span className="script-caption-preview muted">
                    저장될 자막: {cut.onScreenText.replaceAll("\n", " / ") || "없음"}
                  </span>
                )}
              </label>
            ) : (
              <p>자막: {cut.onScreenText || "없음"}</p>
            )}
            <p>내레이션: {cut.narration || "없음"}</p>
            <p className="muted small-copy">
              필요 소스: {sources[cut.source]}
              {cut.veoClip && ` ${cut.veoClip}`}
              {cut.stillId && ` ${cut.stillId}`}
              {cut.graphicKind && ` · ${graphics[cut.graphicKind]}`}
            </p>
            {cut.graphicLines.length > 0 && (
              <p className="muted small-copy">화면 글줄: {cut.graphicLines.join(" / ")}</p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
