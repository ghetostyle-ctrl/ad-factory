import { Play } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { AutomationStartSchema } from "../shared/automation";
import type { Job } from "../shared/schema";
import {
  DEFAULT_CHARS_PER_VIDEO,
  estimateMaxCompositionCost,
  estimateVideoCost,
  IMAGE_USD,
  TYPICAL_STILLS,
  TYPICAL_VEO_CLIPS,
} from "../shared/video-cost";
import {
  INFO_CLIPS_MAX,
  STILL_SHOTS_MAX,
  VEO_CLIP_SEC,
  VEO_SHOTS_MAX,
  voiceoverChars,
} from "../shared/video-script";
import { errorMessage, postJob } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

type VideoModel =
  | "veo-3.1-lite-generate-preview"
  | "veo-3.1-fast-generate-preview"
  | "veo-3.1-generate-preview";
// Veo 초당 단가(USD, 2026-10-03 공식 요금표 기준 추정, 미검증). 720p/1080p로 나눈다.
const videoRates: Record<VideoModel, { readonly "720p": number; readonly "1080p": number }> = {
  "veo-3.1-lite-generate-preview": { "720p": 0.05, "1080p": 0.08 },
  "veo-3.1-fast-generate-preview": { "720p": 0.1, "1080p": 0.15 },
  "veo-3.1-generate-preview": { "720p": 0.2, "1080p": 0.4 },
};

export function AutomationSetup({
  job,
  imageProvider = "openai",
  geminiConnected,
  typecastConnected,
  ffmpegReady,
  onClose,
  onSaved,
}: {
  readonly job: Job;
  readonly imageProvider?: "openai" | "flow";
  readonly geminiConnected: boolean;
  readonly typecastConnected: boolean;
  readonly ffmpegReady: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [imageCount, setImageCount] = useState(job.sourceSnapshot ? 3 : 1);
  const [videoCount, setVideoCount] = useState(0);
  const [videoModel, setVideoModel] = useState<VideoModel>("veo-3.1-generate-preview");
  const [videoResolution, setVideoResolution] = useState<"720p" | "1080p">("1080p");
  const [bgmMode, setBgmMode] = useState<"auto" | "none">("auto");
  const [clipReview, setClipReview] = useState(true);
  const [clipMode, setClipMode] = useState<"api" | "flow">(
    job.automation?.policy.mode === "creative" ? (job.automation.policy.clipMode ?? "api") : "flow",
  );
  // 영상 대본 확인(기본 required): 사용자가 대본을 승인해야 내레이션 합성부터 유료 제작을 시작한다.
  const [scriptApproval, setScriptApproval] = useState<"required" | "auto">("required");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = clipMode === "flow";
  const flowImages = imageProvider === "flow";
  const apiRate = videoRates[videoModel][videoResolution];
  // Flow 모드는 Veo API 를 부르지 않는다: API 클립 비용과 클립 프레임 검토 비용이 없다(Flow 크레딧은 구독에서 차감).
  const rate = flow ? 0 : apiRate;
  const chars =
    job.videoScripts.length > 0
      ? job.videoScripts.reduce((sum, script) => sum + voiceoverChars(script), 0) /
        job.videoScripts.length
      : DEFAULT_CHARS_PER_VIDEO;
  // 구성은 대본이 있으면 실제 평균(Veo 클립 수·정지 이미지 수), 없으면 대표 구성(클립 3개·정지 이미지 8장)으로 본다.
  const scripts = job.videoScripts;
  const clips =
    scripts.length > 0
      ? scripts.reduce((sum, script) => sum + script.veoClips.length, 0) / scripts.length
      : TYPICAL_VEO_CLIPS;
  const stills =
    scripts.length > 0
      ? scripts.reduce((sum, script) => sum + script.stills.length, 0) / scripts.length
      : TYPICAL_STILLS;
  const cost = estimateVideoCost({
    clips,
    stills,
    veoRatePerSec: rate,
    clipReview: clipReview && !flow,
    chars,
  });
  const worst = estimateMaxCompositionCost({
    veoRatePerSec: rate,
    clipReview: clipReview && !flow,
    chars,
  });
  const perVideoUsd = cost.totalUsd;
  const maxFactor = perVideoUsd > 0 ? cost.maxUsd / perVideoUsd : 1;
  const estimateUsd = videoCount * perVideoUsd;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = AutomationStartSchema.safeParse({
      confirmation: confirmed,
      policy: {
        mode: "creative",
        imageCount,
        videoCount,
        videoModel,
        videoResolution,
        bgm: { mode: bgmMode },
        clipReview,
        ...(flow ? { clipMode: "flow" } : {}),
        ...(videoCount > 0 ? { scriptApproval } : {}),
      },
    });
    if (!parsed.success) {
      setError("소재 제작 범위를 확인해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await postJob(`jobs/${job.id}/automation/start`, parsed.data);
      onSaved();
      onClose();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="소재 자동 제작"
      description="영상은 대본·컷·필요 소스를 먼저 설계한 뒤 이미지를 제작하고, 내레이션·Veo 클립·모션그래픽을 조립해 완성합니다."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <dl className="definition-list operation-definition">
          <div>
            <dt>작업</dt>
            <dd>{job.name}</dd>
          </div>
          {job.sourceSnapshot && (
            <div>
              <dt>고정된 프로젝트 자료</dt>
              <dd>
                {job.sourceSnapshot.projectName} · 버전 {job.sourceSnapshot.revision}
              </dd>
            </div>
          )}
        </dl>
        <Field label="이미지 소재 수" help="프로젝트 작업에서는 1~10개를 선택할 수 있습니다.">
          <input
            type="number"
            min={1}
            max={job.sourceSnapshot ? 10 : 1}
            step={1}
            value={imageCount}
            onChange={(event) => setImageCount(Number(event.target.value))}
          />
        </Field>
        {job.sourceSnapshot && (
          <>
            <div className="form-grid">
              <Field
                label="완성 영상 수"
                help="0~10개 · 설명과 장면에 맞춰 30초~최대 1분으로 기획하고 내레이션·자막·BGM을 넣은 세로 MP4를 저장합니다."
              >
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  value={videoCount}
                  onChange={(event) => setVideoCount(Number(event.target.value))}
                />
              </Field>
              <Field
                label="Veo 모델"
                {...(flow ? { help: "Flow 모드에서는 Flow에서 고를 추천 모델로만 쓰입니다." } : {})}
              >
                <select
                  value={videoModel}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "veo-3.1-lite-generate-preview" ||
                      value === "veo-3.1-fast-generate-preview" ||
                      value === "veo-3.1-generate-preview"
                    )
                      setVideoModel(value);
                  }}
                  disabled={videoCount === 0}
                >
                  <option value="veo-3.1-generate-preview">Veo 3.1 Standard (품질 우선)</option>
                  <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
                  <option value="veo-3.1-lite-generate-preview">Veo 3.1 Lite (저비용)</option>
                </select>
              </Field>
            </div>
            {videoCount > 0 && (
              <fieldset className="stack clip-mode">
                <legend>클립 생성 방식</legend>
                <label className="approval-check">
                  <input
                    type="radio"
                    name="clipMode"
                    checked={!flow}
                    onChange={() => setClipMode("api")}
                  />
                  <span>
                    <strong>Veo API 자동</strong>
                    <br />
                    <small className="muted">
                      Gemini API 키로 클립을 자동 생성합니다. 클립 1개(8초)당 약 US$
                      {(VEO_CLIP_SEC * apiRate).toFixed(2)}(추정)가 API 사용료로 청구됩니다.
                    </small>
                  </span>
                </label>
                <label className="approval-check">
                  <input
                    type="radio"
                    name="clipMode"
                    checked={flow}
                    onChange={() => setClipMode("flow")}
                  />
                  <span>
                    <strong>Google Flow 수동(웹 구독 크레딧)</strong>
                    <br />
                    <small className="muted">
                      Veo API를 부르지 않아 API 사용료와 Gemini 키가 필요 없습니다. Google AI Pro
                      구독의 Flow 크레딧을 쓰며 월 제공량과 모델별 소모량은 미검증입니다. 시작
                      이미지와 프롬프트를 내보낸 뒤 클립 단계에서 멈추고, 클립을 Flow에서 만들어
                      업로드하면 자동으로 이어집니다. 실사 클립 최대 {VEO_SHOTS_MAX}개와 3D 설명
                      클립 최대 {INFO_CLIPS_MAX}개를 각각 기획합니다.
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {videoCount > 0 && (
              <fieldset className="stack clip-mode">
                <legend>영상 대본 확인</legend>
                <label className="approval-check">
                  <input
                    type="radio"
                    name="scriptApproval"
                    checked={scriptApproval === "required"}
                    onChange={() => setScriptApproval("required")}
                  />
                  <span>
                    <strong>승인 후 제작(기본)</strong>
                    <br />
                    <small className="muted">
                      대본을 쓰고 AI 검토(말맛·설득력·사실 일치)를 거친 뒤 멈춥니다. 대본 카드에서
                      내레이션·자막을 고치거나 피드백으로 다시 쓰고 승인하면 내레이션 합성부터 유료
                      제작을 시작합니다.
                    </small>
                  </span>
                </label>
                <label className="approval-check">
                  <input
                    type="radio"
                    name="scriptApproval"
                    checked={scriptApproval === "auto"}
                    onChange={() => setScriptApproval("auto")}
                  />
                  <span>
                    <strong>자동 진행</strong>
                    <br />
                    <small className="muted">
                      AI 검토를 통과한 대본은 승인 없이 바로 제작합니다. 검토가 3회 생성 뒤에도
                      수정을 권하면 그 영상만 승인 대기로 멈추고 대본 카드에서 확인·승인해야
                      제작합니다.
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {videoCount > 0 && (
              <div className="form-grid">
                <Field
                  label="클립 해상도"
                  {...(flow ? { help: "Flow 모드에서는 Flow 화면에서 고릅니다." } : {})}
                >
                  <select
                    disabled={flow}
                    value={videoResolution}
                    onChange={(event) =>
                      setVideoResolution(event.target.value === "720p" ? "720p" : "1080p")
                    }
                  >
                    <option value="1080p">1080p</option>
                    <option value="720p">720p (업스케일)</option>
                  </select>
                </Field>
                <Field label="BGM" help="assets/bgm 라이브러리에서 가설 단계별 무드로 고릅니다.">
                  <select
                    value={bgmMode}
                    onChange={(event) =>
                      setBgmMode(event.target.value === "none" ? "none" : "auto")
                    }
                  >
                    <option value="auto">자동 선택(라이브러리가 비면 없음)</option>
                    <option value="none">넣지 않음</option>
                  </select>
                </Field>
                <label className="approval-check">
                  <input
                    type="checkbox"
                    checked={clipReview && !flow}
                    disabled={flow}
                    onChange={(event) => setClipReview(event.target.checked)}
                  />
                  <span>
                    {flow
                      ? "완성 클립 AI 검토는 API 모드에서만 합니다. Flow 클립은 업로드 전에 사람이 시작 이미지와 대조합니다."
                      : "완성 클립 프레임 3장을 AI가 검토하고 불합격이면 1회 재생성"}
                  </span>
                </label>
              </div>
            )}
          </>
        )}
        <Notice>
          {flowImages ? (
            <>
              이미지 제작은 Google Flow입니다. 대표·카드·정지·시작 이미지를 각 단계의 프롬프트로
              제작하고 확인 후 업로드합니다. 앱의 OpenAI 이미지 생성 호출은 없습니다. 검토 실패 시
              수정 이미지를 요청하며, 두 차례 검토 후에도 실패하면 결과를 보고하고 멈춥니다.{" "}
              {videoCount > 0
                ? `완성 영상 ${videoCount}편은 내레이션과 ${flow ? "Flow에서 업로드한" : "Veo API로 생성한"} 클립을 합성합니다.`
                : ""}{" "}
              글쓰기·검토는 선택한 AI의 사용량, Flow 생성은 Flow 크레딧, 영상 내레이션은 Typecast
              사용량이 소모됩니다. Meta 게시·집행은 하지 않습니다.
            </>
          ) : (
            <>
              {job.sourceSnapshot
                ? `소재별 타깃·상황·메시지가 다른 광고안 ${imageCount}개를 설계합니다. 이미지 API 호출은 최대 ${imageCount * 2}회입니다.`
                : "광고안 1개를 설계하고 이미지를 최초 1회, 필요하면 수정 1회 생성합니다. 이미지 API 호출은 최대 2회입니다."}{" "}
              {videoCount > 0
                ? flow
                  ? ` 완성 영상 ${videoCount}개(30~60초, 내레이션·자막·BGM 포함): 영상마다 Typecast 내레이션 → AI 정지 이미지 최대 ${STILL_SHOTS_MAX}장 → Veo 시작 이미지 → Flow 실사 클립 최대 ${VEO_SHOTS_MAX}개 + 3D 설명 클립 최대 ${INFO_CLIPS_MAX}개(각 ${VEO_CLIP_SEC}초, Google Flow에서 직접 만들어 업로드) → 모션그래픽·조립 순서로 진행합니다. 클립 단계에서 시작 이미지·프롬프트를 내보내고 멈춰 업로드를 기다립니다. Typecast·OpenAI 키와 ffmpeg가 필요하고 Gemini 키는 필요 없습니다.`
                  : ` 완성 영상 ${videoCount}개(30~60초, 내레이션·자막·BGM 포함): 영상마다 Typecast 내레이션 → AI 정지 이미지 최대 ${STILL_SHOTS_MAX}장(분위기·상황 컷, 카메라 무브로 재구성) → Veo 시작 이미지 → Veo ${VEO_CLIP_SEC}초 클립 최대 ${VEO_SHOTS_MAX}개(움직임이 필요한 실사 컷에만, 클립마다 생성 ≤2회, 재생성은 최대 1회) → 모션그래픽·조립 순서로 진행합니다. Gemini·Typecast·OpenAI 키와 ffmpeg가 필요합니다.`
                : ""}{" "}
              실제 API 사용료가 발생할 수 있습니다. Meta 광고 등록·게시·광고비 집행은 진행하지
              않습니다.
            </>
          )}
        </Notice>
        {videoCount > 0 && !flow && !geminiConnected && (
          <Notice tone="warning">
            Gemini API 키가 아직 없습니다. 이미지를 만든 뒤 내레이션 합성 전에 키 연결을 기다립니다.
          </Notice>
        )}
        {videoCount > 0 && !typecastConnected && (
          <Notice tone="warning">
            Typecast API 키가 아직 없습니다. 영상 단계는 내레이션 합성 전에 키 연결을 기다립니다.
          </Notice>
        )}
        {videoCount > 0 && !ffmpegReady && (
          <Notice tone="warning">
            이 서버에서 ffmpeg(libass·libx264) 또는 자막 폰트를 찾지 못했습니다. 영상 단계는 환경을
            고친 뒤 재개할 때까지 멈춥니다.
          </Notice>
        )}
        {videoCount > 0 && !flowImages && (
          <p className="muted small-copy">
            예상 비용(추정): 약 US${estimateUsd.toFixed(2)} — 영상당{" "}
            {scripts.length > 0 ? "대본 평균" : "대표 구성"}{" "}
            {flow
              ? `Flow 클립 ${clips.toFixed(1)}개(Veo API 비용 없음, Flow 크레딧은 구독에서 차감) US$0.00`
              : `Veo ${clips.toFixed(1)}클립×${VEO_CLIP_SEC}초×US$${rate.toFixed(2)}/초 = US$${cost.veoUsd.toFixed(2)}`}{" "}
            + 이미지 {(clips + stills).toFixed(1)}장(시작 이미지 {clips.toFixed(1)} + 정지 이미지{" "}
            {stills.toFixed(1)}, 장당 US${IMAGE_USD.toFixed(2)}) = US${cost.imageUsd.toFixed(2)}
            {clipReview && !flow ? ` + 클립 검토 US$${cost.reviewUsd.toFixed(2)}` : ""} + Typecast
            약 {Math.round(chars * 1.4)}자.{" "}
            {flow
              ? "이미지도 1회까지 다시 만들 수 있어 모두 일어나면"
              : "클립은 생성이 최대 2회(불합격 시 재생성 1회), 이미지도 1회까지 다시 만들 수 있어 모두 일어나면"}{" "}
            최대 약 {maxFactor.toFixed(1)}배(약 US$
            {(videoCount * cost.maxUsd).toFixed(2)})까지 늘어날 수 있습니다. 구성이 허용 최대(클립{" "}
            {VEO_SHOTS_MAX}개·정지 이미지 {STILL_SHOTS_MAX}장)이고 재시도까지 모두 일어나면 영상당
            약 US${worst.maxUsd.toFixed(2)}입니다.{" "}
            {flow
              ? `3D 설명 클립은 위 API 추정에서 제외되며, 클립당 CLEAN·INFO 이미지 2장 비용과 Flow 크레딧이 추가됩니다(최대 ${INFO_CLIPS_MAX}개). `
              : ""}
            실제 호출 단가는 미검증입니다.{" "}
            <a
              href="https://ai.google.dev/gemini-api/docs/pricing"
              target="_blank"
              rel="noreferrer"
            >
              Google 공식 요금표
            </a>
          </p>
        )}
        <label className="approval-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {flowImages
              ? `위 자료로 기획·대본을 작성하고, Flow에서 직접 만든 이미지를 확인 후 업로드합니다. 이미지 검토는 장당 최대 2회이며 선택한 AI의 사용량이 소모됩니다. ${flow ? "영상 클립도 Flow에서 만들어 업로드합니다." : "영상 클립은 선택한 Veo API 설정으로 생성합니다."}`
              : flow
                ? `위 자료와 이미지 생성 횟수(정지 이미지 최대 ${STILL_SHOTS_MAX}장×장당 생성 ≤2회, 시작 이미지 클립당 ≤2회)로 소재를 제작합니다. Veo 클립은 API로 만들지 않고 Flow에서 직접 만들어 올릴 때까지 멈춰 기다립니다.`
                : `위 자료와 이미지·영상 생성 횟수(클립 최대 ${VEO_SHOTS_MAX}개×클립당 생성 ≤2회, 정지 이미지 최대 ${STILL_SHOTS_MAX}장×장당 생성 ≤2회)로 소재를 자동 제작합니다.`}
          </span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!confirmed}>
            <Play size={15} />
            소재 제작 시작
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
