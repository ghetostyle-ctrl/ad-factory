import { isExplainerCut, isLiveCut } from "../shared/hybrid-script-rules";
import { CHAIN_STEP_LABELS } from "../shared/persuasion-chain";
import type { VisualPolicyId } from "../shared/video-planning";
import {
  type Callout,
  CLIP_PHASE_RANGES_MS,
  CLIP_PHASES,
  type ClipPhaseId,
  type ClipPlan,
  calloutWordInText,
  type ExplainerEmphasis,
  type ExplainerObject,
  type InfoClip,
  isClipPlanEmpty,
  isExplainerScene,
  isHybrid,
  type VideoCut,
  type VideoScript,
  voiceCutRange,
  voicePurposeOf,
} from "../shared/video-script";
import { ExplanationPlan } from "./ExplanationPlan";

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
// 장면 계획(2026-10-06): 클립 구간·콜아웃·설명 컷 단계의 한국어 라벨. 값은 shared/video-script.ts 의 enum 과 같다.
const phases = {
  early: "초반",
  mid: "중반",
  late: "후반",
} as const satisfies Record<ClipPhaseId, string>;
const calloutKinds = {
  label: "라벨",
  ring: "링",
  arrow: "화살표",
  check: "체크",
} as const satisfies Record<Callout["kind"], string>;
const calloutAnchors = {
  subject: "대상",
  left: "왼쪽",
  right: "오른쪽",
  top: "위",
  bottom: "아래",
} as const satisfies Record<Callout["anchor"], string>;
const stages = {
  real_cause: "진짜 원인",
  criteria: "봐야 할 기준",
  mechanism: "우리 상품이 푸는 방식",
  verification: "직접 확인하는 방법",
} as const satisfies Record<InfoClip["stage"], string>;
// 혼합형(2026-10-07): 시각 정책·설명 장면의 한국어 라벨. 값은 shared/video-planning.ts·shared/video-script.ts 의 enum 과 같다.
const policies = {
  immersive_explanations_v1: "입체 설명(이전 기준)",
  hybrid_explainer_v1: "혼합형 · 실사 + 3D 설명",
} as const satisfies Record<VisualPolicyId, string>;
const sceneTypes = {
  process: "과정",
  comparison: "비교",
  analogy: "비유",
} as const satisfies Record<Exclude<InfoClip["sceneType"], "">, string>;
const explainerColors = {
  accent1: "강조색 1",
  accent2: "강조색 2",
  neutral: "중립(클레이·화이트)",
} as const satisfies Record<ExplainerObject["color"], string>;
const emphasisKinds = {
  color_code: "색 구분",
  outline: "빨간 외곽선",
  glow_line: "흰 발광선",
  ghost_object: "반투명 비유 오브젝트",
} as const satisfies Record<ExplainerEmphasis["kind"], string>;
function isPurpose(value: string): value is keyof typeof purposes {
  return value in purposes;
}
// 대본 카드 머리글의 시각 정책 배지 문구. 정책이 없는 예전 대본은 빈 문자열(배지 없음).
export function visualPolicyLabel(policy: VisualPolicyId | undefined): string {
  return policy ? policies[policy] : "";
}
// 혼합형 대본에서만 컷이 실사인지 설명 장면인지 표시한다(H2: 고통·결과·행동 비트는 실사, 메커니즘·비교 비트만 설명 세계).
// 둘 다 아닌 컷(카드뉴스·모션그래픽)은 혼합형 규칙이 거부하므로 위험 배지로 보인다.
function CutWorldBadge({
  cut,
  hybrid,
}: {
  readonly cut: Pick<VideoCut, "source" | "veoClip">;
  readonly hybrid: boolean;
}) {
  if (!hybrid) return null;
  if (isExplainerCut(cut)) return <span className="badge badge-accent">설명 장면</span>;
  if (isLiveCut(cut)) return <span className="badge badge-neutral">실사</span>;
  return <span className="badge badge-danger">실사·설명 아님</span>;
}
// 클립 구간 라벨: 한국어 이름과 초 범위를 함께 적는다(예: 초반 0~3초). 화면·테스트가 같이 쓴다.
export function clipPhaseLabel(phase: ClipPhaseId): string {
  const [from, to] = CLIP_PHASE_RANGES_MS[phase];
  return `${phases[phase]} ${from / 1000}~${to / 1000}초`;
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
  const hasCallouts = script.voiceover.some((voice) => voice.callouts.length > 0);
  const hybrid = isHybrid(script);
  return (
    <>
      <p className="muted small-copy">
        한 문장에 연결된 여러 컷을 함께 보여 줍니다. 문장과 컷의 목적은 다를 수 있고, 화면에만
        표시하는 숫자도 사용할 수 있습니다. 말과 그림의 의미가 맞는지는 AI 검토와 함께 확인하세요.
        {hasCallouts &&
          " 콜아웃은 적힌 어절이 발음되는 순간 그려지므로, 문장을 고칠 때 그 어절은 남겨 두세요."}
        {hybrid &&
          " 혼합형 대본입니다: 고통·믿는 원인·결과·행동 문장의 컷은 실사, 원인·조건·사실·이유 문장만 설명 장면(I1~I3)을 쓸 수 있습니다. 콜아웃은 실사 컷에서만 그려집니다."}
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
                {voice.chainStep !== "" && (
                  <>
                    <br />
                    <span className="badge badge-neutral">
                      {CHAIN_STEP_LABELS[voice.chainStep]}
                    </span>
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
                {voice.callouts.length > 0 && (
                  <ul className="script-cuts" aria-label={`${index + 1}번째 문장의 콜아웃`}>
                    {voice.callouts.map((callout) => {
                      // 문장을 고쳐 어절이 사라지면 저장 규칙(hard)에 걸리므로 여기서 먼저 알린다.
                      const present = calloutWordInText(callout.word, voice.text);
                      return (
                        <li
                          key={`${callout.kind}-${callout.anchor}-${callout.word}-${callout.text}`}
                        >
                          <span className="script-cut-head">
                            콜아웃 · {callout.word} → {callout.text}
                            <span className="badge badge-neutral">
                              {calloutKinds[callout.kind]}
                            </span>
                            <span className="badge badge-neutral">
                              {calloutAnchors[callout.anchor]}
                            </span>
                            {!present && (
                              <span className="badge badge-danger">문장에 없는 어절</span>
                            )}
                          </span>
                          {!present && (
                            <span className="muted">
                              어절 "{callout.word}"가 문장에 없어 저장할 수 없습니다. 어절을
                              되살리거나 다시 쓰기로 콜아웃을 바꾸세요.
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
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
                            <CutWorldBadge cut={cut} hybrid={hybrid} />
                            {cut.phase !== "" && (
                              <span className="badge badge-accent">
                                {clipPhaseLabel(cut.phase)}
                              </span>
                            )}
                            {cut.purpose !== purpose && cut.purpose !== "rehook" && (
                              <span className="badge badge-warning">
                                목적 {purposes[cut.purpose]}
                              </span>
                            )}
                          </span>
                          <span>{cut.screenComposition}</span>
                          {cut.goal && <span className="muted">이해 목표: {cut.goal}</span>}
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
            <strong className="script-cut-head">
              컷 {index} · {cut.startSec}–{cut.endSec}초 · {purposes[cut.purpose]}
              {effects[cut.effect] && ` · ${effects[cut.effect]}`}
              <CutWorldBadge cut={cut} hybrid={hybrid} />
            </strong>
            <p>화면: {cut.screenComposition}</p>
            {cut.goal && <p>이해 목표: {cut.goal}</p>}
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
              {cut.phase !== "" && ` · ${clipPhaseLabel(cut.phase)} 구간`}
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

// Flow 8초 클립의 구간 계획(early·mid·late 의 카메라·움직임). 계획이 없는 예전 대본은 아무것도 그리지 않는다.
export function ClipPlanDetails({ plan }: { readonly plan: ClipPlan }) {
  if (isClipPlanEmpty(plan)) return null;
  return (
    <details className="evidence-details">
      <summary>구간 계획 · 카메라와 움직임 3단계</summary>
      <ul className="script-rules">
        {CLIP_PHASES.map((phase) => (
          <li key={phase}>
            <strong>{clipPhaseLabel(phase)}</strong>
            <br />
            카메라: {plan[phase].camera}
            <br />
            움직임: {plan[phase].action}
          </li>
        ))}
      </ul>
    </details>
  );
}

// 혼합형 설명 장면(H4, 읽기 전용): 물체(색은 영상 전체에서 고정)·동작 순서·강조 수단. 이름표·지시선·수치 박스는 없고(R2)
// 앱 콜아웃도 설명 컷에는 그리지 않는다(H7). 장면 필드가 없는 예전·immersive 설명 컷은 아무것도 그리지 않는다.
export function ExplainerScene({ clip }: { readonly clip: InfoClip }) {
  if (!isExplainerScene(clip)) return null;
  return (
    <div className="stack-tight">
      <ul className="script-cuts" aria-label={`설명 장면 ${clip.id}의 물체`}>
        {clip.objects.map((object) => (
          <li key={object.subjectId}>
            <span className="script-cut-head">
              <span className="badge badge-neutral">{object.subjectId}</span>
              {explainerColors[object.color]}
            </span>
          </li>
        ))}
      </ul>
      <details className="evidence-details">
        <summary>
          동작 순서 {clip.actions.length}단계 · 강조 {clip.emphasis.length}개
        </summary>
        <ol className="script-rules">
          {clip.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
        {clip.emphasis.length > 0 && (
          <ul className="script-rules">
            {clip.emphasis.map((item) => (
              <li key={`${item.kind}-${item.target}-${item.afterAction}`}>
                {emphasisKinds[item.kind]} · {item.target} · {item.afterAction + 1}번째 동작 뒤
              </li>
            ))}
          </ul>
        )}
        <p className="muted small-copy">
          {clip.infoLines.length > 0
            ? "설명 세계의 글자는 INFO 이미지의 인포그래픽 문구(아래)뿐이고 업로드 때 앱이 대조합니다. 콜아웃은 실사 컷에서만 그립니다."
            : "설명 세계에는 글자·이름표·지시선이 없습니다. 숫자는 말하고 자막으로만 보여 주며, 콜아웃은 실사 컷에서만 그립니다."}
        </p>
      </details>
    </div>
  );
}

// 제작 소스 선언: 등장 대상(id·외형), Veo 클립(시작 이미지·움직임·구간 계획), 설명 컷(CLEAN·INFO 프롬프트·그래픽 순서·구간 계획),
// 정지 이미지. 대본 카드의 '제작 소스' 접힘 영역이 쓴다. 예전 대본의 infoLines·motionPrompt 는 있을 때만 보인다.
// 혼합형(2026-10-07)은 설명 세계 기준(explainerAnchor)과 설명 장면(장면 종류·물체·동작·강조)을 더 보여 준다.
export function ScriptSources({ script }: { readonly script: VideoScript }) {
  return (
    <>
      {script.explainerAnchor && (
        <p>
          <strong>설명 세계 기준(explainerAnchor):</strong> {script.explainerAnchor}
        </p>
      )}
      {script.subjects.length > 0 && (
        <div className="stack-tight">
          <p>
            <strong>등장 대상:</strong> 모든 이미지 프롬프트가 아래 외형을 직접 적어야 같은 대상으로
            그려집니다.
          </p>
          <ul className="script-rules">
            {script.subjects.map((subject) => (
              <li key={subject.id}>
                <span className="badge badge-neutral">{subject.id}</span> {subject.traits}
              </li>
            ))}
          </ul>
        </div>
      )}
      {script.veoClips.map((clip) => (
        <div className="stack-tight" key={clip.id}>
          <p>
            <strong>Veo 클립 {clip.id}:</strong> 시작 이미지 — {clip.startImagePrompt}
            <br />
            움직임 — {clip.prompt}
          </p>
          <ClipPlanDetails plan={clip.plan} />
        </div>
      ))}
      {script.infoClips.map((clip) => (
        <div className="stack-tight" key={clip.id}>
          <p>
            <strong>
              {clip.sceneType === "" ? "설명 컷" : "설명 장면"} {clip.id} · {stages[clip.stage]}:
            </strong>{" "}
            {clip.sceneType !== "" && (
              <>
                <span className="badge badge-accent">{sceneTypes[clip.sceneType]}</span>{" "}
              </>
            )}
            CLEAN {clip.sceneType === "" ? "사진" : "장면"} — {clip.cleanPrompt}
            <br />
            INFO {clip.sceneType === "" ? "그래픽" : "강조"} — {clip.infoPrompt}
          </p>
          <ExplainerScene clip={clip} />
          {clip.infoLines.length > 0 && (
            <p className="muted small-copy">
              {clip.sceneType === "" ? "INFO 사진 문구(예전 대본)" : "INFO 인포그래픽 문구(정확히)"}
              : {clip.infoLines.join(" / ")}
            </p>
          )}
          <ExplanationPlan plan={clip.explanation} durationSec={8} />
          {clip.graphicOrder.length > 0 && (
            <details className="evidence-details">
              <summary>그래픽이 생기는 순서 {clip.graphicOrder.length}단계</summary>
              <ol className="script-rules">
                {clip.graphicOrder.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          )}
          {clip.motionPrompt && (
            <p className="muted small-copy">전환 영상 프롬프트(예전 대본): {clip.motionPrompt}</p>
          )}
          <ClipPlanDetails plan={clip.plan} />
        </div>
      ))}
      {script.stills.map((still) => (
        <p key={still.id}>
          <strong>정지 이미지 {still.id}:</strong> {still.prompt}
        </p>
      ))}
    </>
  );
}
