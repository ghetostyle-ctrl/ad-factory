import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type CalloutMotion, motionPointAt } from "../shared/callout-motion";
import { Button, Field } from "./primitives";

export type CalloutPreviewItem = {
  readonly cutStartMs: number;
  readonly cutDurationMs: number;
  readonly text: string;
};

export function CalloutPreview({
  url,
  item,
  motion,
  selectedAt,
}: {
  readonly url: string;
  readonly item: CalloutPreviewItem;
  readonly motion: CalloutMotion;
  readonly selectedAt: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [progress, setProgress] = useState(selectedAt);
  const [playing, setPlaying] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const { cutStartMs, cutDurationMs } = item;
  const seek = (at: number) => {
    const media = video.current;
    if (media) {
      media.pause();
      media.currentTime =
        (cutStartMs + Math.min(at * cutDurationMs, Math.max(0, cutDurationMs - 40))) / 1000;
    }
    setProgress(at);
    setPlaying(false);
  };
  useEffect(() => {
    const media = video.current;
    if (media) {
      media.pause();
      media.currentTime =
        (cutStartMs + Math.min(selectedAt * cutDurationMs, Math.max(0, cutDurationMs - 40))) / 1000;
    }
    setProgress(selectedAt);
    setPlaying(false);
  }, [selectedAt, cutStartMs, cutDurationMs]);
  const position = motionPointAt(motion, progress);
  return (
    <div className="stack callout-preview">
      <div className="callout-preview-frame">
        <video
          ref={video}
          src={url}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={() => seek(selectedAt)}
          onError={() =>
            setMediaError("영상 미리보기를 읽지 못했습니다. 편집기를 다시 열어 주세요.")
          }
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const media = video.current;
            if (!media || media.paused) return;
            const at = (media.currentTime * 1000 - cutStartMs) / cutDurationMs;
            if (at >= 1) {
              media.pause();
              media.currentTime = (cutStartMs + Math.max(0, cutDurationMs - 40)) / 1000;
              setProgress(1);
            } else setProgress(Math.max(0, at));
          }}
        >
          <track kind="captions" />
        </video>
        {position && (
          <div className="callout-preview-overlay" aria-hidden="true">
            <svg viewBox="0 0 1000 1000" preserveAspectRatio="none">
              <title>대상과 설명 문구를 잇는 위치 미리보기</title>
              <line
                x1={position.target.x * 1000}
                y1={position.target.y * 1000}
                x2={position.label.x * 1000}
                y2={position.label.y * 1000}
              />
            </svg>
            <span
              className="callout-preview-target"
              style={{ left: `${position.target.x * 100}%`, top: `${position.target.y * 100}%` }}
            />
            <span
              className="callout-preview-label"
              style={{ left: `${position.label.x * 100}%`, top: `${position.label.y * 100}%` }}
            >
              {item.text}
            </span>
          </div>
        )}
      </div>
      <Field
        label={`미리보기 ${(cutStartMs / 1000 + (progress * cutDurationMs) / 1000).toFixed(2)}초`}
      >
        <input
          type="range"
          min="0"
          max="100"
          step="0.1"
          value={progress * 100}
          onChange={(event) => seek(Number(event.target.value) / 100)}
        />
      </Field>
      <Button
        onClick={() => {
          const media = video.current;
          if (!media) return;
          if (playing) media.pause();
          else {
            if (progress >= 1) media.currentTime = cutStartMs / 1000;
            void media.play().catch((error: unknown) => {
              if (error instanceof Error)
                setMediaError("재생을 시작하지 못했습니다. 다시 눌러 주세요.");
            });
          }
        }}
      >
        {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {playing ? "일시 정지" : "이 구간 재생"}
      </Button>
      {mediaError && (
        <p role="alert" className="small-copy">
          {mediaError}
        </p>
      )}
      <p className="muted small-copy">
        점은 대상, 상자는 문구의 중심입니다. 사이 구간도 재생하며 같은 대상을 따라가는지 확인하세요.
      </p>
      <p className="muted small-copy">
        현재 완성본 위에 새 위치를 미리 보여줍니다. 기존 문구는 다시 조립한 뒤 교체됩니다.
      </p>
    </div>
  );
}
