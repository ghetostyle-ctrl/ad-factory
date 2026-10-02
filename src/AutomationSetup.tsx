import { Play } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { AutomationStartSchema } from "../shared/automation";
import type { Job } from "../shared/schema";
import { errorMessage, postJob } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

export function AutomationSetup({
  job,
  geminiConnected,
  onClose,
  onSaved,
}: {
  readonly job: Job;
  readonly geminiConnected: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [imageCount, setImageCount] = useState(job.sourceSnapshot ? 3 : 1);
  const [videoCount, setVideoCount] = useState(0);
  const [videoModel, setVideoModel] = useState<
    "veo-3.1-lite-generate-preview" | "veo-3.1-fast-generate-preview" | "veo-3.1-generate-preview"
  >("veo-3.1-lite-generate-preview");
  const videoRate =
    videoModel === "veo-3.1-generate-preview"
      ? 0.4
      : videoModel === "veo-3.1-fast-generate-preview"
        ? 0.1
        : 0.05;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = AutomationStartSchema.safeParse({
      confirmation: confirmed,
      policy: { mode: "creative", imageCount, videoCount, videoModel },
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
      description="영상은 대본·컷·필요 소스·Flow 지시를 먼저 설계한 뒤 이미지를 제작합니다."
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
          <div className="form-grid">
            <Field
              label="영상 대본·Veo 원본 클립 수"
              help="0~10개 · 영상마다 30초~1분(무작위) 대본과 컷 설계를 이미지 제작 전에 저장합니다."
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
            <Field label="영상 생성 모델">
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
                <option value="veo-3.1-lite-generate-preview">Veo 3.1 Lite</option>
                <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
                <option value="veo-3.1-generate-preview">Veo 3.1 Standard</option>
              </select>
            </Field>
          </div>
        )}
        <Notice>
          {job.sourceSnapshot
            ? `소재별 타깃·상황·메시지가 다른 광고안 ${imageCount}개를 설계합니다. 이미지 API 호출은 최대 ${imageCount * 2}회입니다.`
            : "광고안 1개를 설계하고 이미지를 최초 1회, 필요하면 수정 1회 생성합니다. 이미지 API 호출은 최대 2회입니다."}{" "}
          {videoCount > 0
            ? ` 영상 ${videoCount}개의 30초~1분 대본·컷·소스·Flow·편집 지시를 먼저 작성하고 Veo 8초 원본 클립을 생성합니다. Gemini API 키와 모델별 영상 사용료가 필요합니다.`
            : ""}{" "}
          실제 API 사용료가 발생할 수 있습니다. Meta 광고 등록·게시·광고비 집행은 진행하지 않습니다.
        </Notice>
        {videoCount > 0 && !geminiConnected && (
          <Notice tone="warning">
            Gemini API 키가 아직 없습니다. 이미지를 만든 뒤 영상 단계에서 키 연결을 기다립니다.
          </Notice>
        )}
        {videoCount > 0 && (
          <p className="muted small-copy">
            Veo 영상 예상 요금: 약 US${(videoCount * 8 * videoRate).toFixed(2)} (720p·8초,
            2026-09-27 기준). 이미지·텍스트 API 비용은 별도입니다.{" "}
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
          <span>위 자료와 이미지·영상 생성 횟수로 소재를 자동 제작합니다.</span>
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
