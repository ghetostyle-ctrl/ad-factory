import { Clapperboard, Download, Play } from "lucide-react";
import { useState } from "react";
import { jobProgress } from "../shared/next-action";
import type { Job } from "../shared/schema";
import { videoBoardItems } from "./VideoBoard";
import "./tabs.css";

const seconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}초`;

// 모든 작업의 현재 완성본을 작업별로 모아 보는 화면(사이드바 '완성 영상'). 카드를 열면 onOpen(작업, 영상 번호).
type FinishedItem = ReturnType<typeof videoBoardItems>[number];
const isFinished = (item: FinishedItem) => item.download !== null || item.posterUrl !== null;

function FinishedCard({
  item,
  onOpen,
}: {
  readonly item: FinishedItem;
  readonly onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const poster = item.posterUrl !== null && !failed;
  return (
    <li className="fv-card">
      <button
        type="button"
        className={`fv-open ${poster ? "" : "is-empty"}`}
        aria-label={`영상 ${item.number} ${item.title} 열기`}
        onClick={onOpen}
      >
        <span className="fv-thumb">
          {poster ? (
            <img
              src={item.posterUrl ?? undefined}
              alt={`영상 ${item.number} 포스터`}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          ) : (
            <Clapperboard size={20} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className="fv-no">{item.number}</span>
          {item.durationMs !== null && (
            <span className="fv-dur">
              <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              {seconds(item.durationMs)}
            </span>
          )}
        </span>
        <span className="fv-k">영상 {item.number}</span>
        <span className="fv-title">{item.title}</span>
      </button>
      {item.download && (
        <a
          className="fv-get"
          href={item.download.url}
          download={item.download.name}
          aria-label={`영상 ${item.number} MP4 받기`}
          title="MP4 받기"
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export function FinishedVideos({
  jobs,
  onOpen,
}: {
  readonly jobs: readonly Job[];
  readonly onOpen: (jobId: string, number: number) => void;
}) {
  // 완성본이 있는 작업을 먼저 둔다(순서는 원래 목록을 유지).
  const sections = jobs.map((job) => {
    const items = videoBoardItems(job).filter(isFinished);
    return { job, items, total: jobProgress(job).total };
  });
  const ordered = [
    ...sections.filter((s) => s.items.length > 0),
    ...sections.filter((s) => s.items.length === 0),
  ];
  if (ordered.length === 0)
    return (
      <section className="panel empty-small">
        <Clapperboard size={20} strokeWidth={1.75} aria-hidden="true" />
        <h3>아직 작업이 없어요</h3>
        <p>작업을 만들고 시작하면 완성된 영상이 여기에 모여요.</p>
      </section>
    );
  return (
    <div className="fv-sections">
      {ordered.map(({ job, items, total }) => (
        <section className="fv-section" key={job.id} aria-label={`${job.name} 완성 영상`}>
          <header className="fv-head">
            <h2>{job.name}</h2>
            <span className="fv-count">
              {items.length}
              {total > 0 && ` / ${total}`}편 완성
            </span>
          </header>
          {items.length === 0 ? (
            <p className="fv-empty">아직 완성 영상이 없어요</p>
          ) : (
            <ul className="fv-grid">
              {items.map((item) => (
                <FinishedCard
                  key={item.number}
                  item={item}
                  onOpen={() => onOpen(job.id, item.number)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
