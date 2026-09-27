import { useEffect, useRef, useState } from "react";
import { type MediaAnalysisStatus, MediaAnalysisStatusSchema } from "../shared/media-analysis";
import type { MediaAsset } from "../shared/media-assets";
import { api, errorMessage } from "./api";
import { Button, Notice } from "./primitives";

export function MediaAnalysisCard({
  projectId,
  sourceId,
  asset,
}: {
  readonly projectId: string;
  readonly sourceId: string;
  readonly asset: MediaAsset;
}) {
  const [analysis, setAnalysis] = useState<MediaAnalysisStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<(() => void) | null>(null);
  const path = `projects/${projectId}/sources/${sourceId}/media/${asset.id}/analysis`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const result = MediaAnalysisStatusSchema.parse(await api.get(path).json());
        if (!active) return;
        setAnalysis(result);
        if (result.status === "running") timer = setTimeout(() => void load(), 2000);
      } catch (cause) {
        if (active) setError(await errorMessage(cause));
      }
    };
    poll.current = () => void load();
    void load();
    return () => {
      active = false;
      poll.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [path]);
  const start = async () => {
    setError(null);
    try {
      const result = MediaAnalysisStatusSchema.parse(await api.post(path).json());
      setAnalysis(result);
      if (result.status === "running") poll.current?.();
    } catch (cause) {
      setError(await errorMessage(cause));
    }
  };
  const report = analysis?.report;
  return (
    <div className="stack media-analysis-card">
      {analysis?.status === "not_started" && (
        <div className="cluster">
          <Button onClick={() => void start()}>
            {asset.kind === "video" ? "컷별 영상 분석 시작" : "이미지 화면 분석 시작"}
          </Button>
          <span className="muted small-copy">OpenAI API 호출 비용이 발생합니다.</span>
        </div>
      )}
      {analysis?.status === "running" && (
        <Notice>원본 파일을 분석하고 있습니다. 결과를 자동으로 확인합니다.</Notice>
      )}
      {analysis?.status === "error" && (
        <Notice tone="error">
          {analysis.error} <Button onClick={() => void start()}>다시 분석</Button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {report && (
        <details className="evidence-details">
          <summary>
            {report.kind === "video" ? "컷별 영상 분석" : "이미지 화면 분석"} · 관측{" "}
            {report.cuts.length}개
          </summary>
          <div className="stack">
            <p className="muted small-copy">
              {report.sampling} · 모델 {report.model} · 원본 SHA-256 {report.assetSha256}
            </p>
            <div className="media-analysis-scroll">
              <table className="media-analysis-table">
                <thead>
                  <tr>
                    <th>구간</th>
                    <th>화면 구성</th>
                    <th>화면 글자</th>
                    <th>메시지</th>
                    <th>들리는 말</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cuts.map((cut) => (
                    <tr key={`${cut.startSec}-${cut.endSec}`}>
                      <th>
                        {cut.startSec.toFixed(cut.startSec % 1 ? 1 : 0)}~
                        {cut.endSec.toFixed(cut.endSec % 1 ? 1 : 0)}초
                      </th>
                      <td>{cut.screenComposition || "확인 불가"}</td>
                      <td>{cut.onScreenText || "확인 불가"}</td>
                      <td>{cut.messageText || "확인 불가"}</td>
                      <td>
                        {report.transcript
                          .filter(
                            (segment) =>
                              segment.startSec < cut.endSec && segment.endSec > cut.startSec,
                          )
                          .map((segment) => segment.text)
                          .join(" ") || "전사 없음"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.limitations.map((item) => (
              <p className="muted small-copy" key={item}>
                {item}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
