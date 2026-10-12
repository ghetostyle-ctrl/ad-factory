import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Job } from "../shared/schema";
import { reportChecks, useRenderReports } from "./FinalVideo";
import { StatusDot } from "./primitives";
import { videoBoardItems } from "./VideoBoard";
import "./video-detail.css";

const seconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}초`;
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// 대본·영상 탭 왼쪽 영상 목록(마스터). 한 번에 한 편만 오른쪽(디테일)에 열린다. 이동은 호출한 쪽이 URL 의 n 으로 처리한다.
// 키보드: 목록에 포커스가 있을 때 ↑/↓, 어디서나 J/K(다음·이전) 와 숫자 1~9·0(=10). 입력 중에는 무시한다.
export function VideoList({
  job,
  number,
  onSelect,
}: {
  readonly job: Job;
  readonly number: number;
  readonly onSelect: (number: number) => void;
}) {
  const items = videoBoardItems(job);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const list = useRef<HTMLUListElement>(null);
  // 완성본이 있는 영상의 렌더 보고(확인할 점 수). 이미 받은 값이 있으면 다시 받지 않는다.
  const sources = items.flatMap((item) => {
    const render = job.renders.find((entry) => entry.number === item.number);
    const report = job.artifacts.find(
      (entry) => entry.name === `render-report-${item.number}.json`,
    );
    return render?.final && report
      ? [{ number: item.number, url: report.url, digest: render.final.digest }]
      : [];
  });
  const reports = useRenderReports(sources);
  const checks = new Map(
    sources.map((source, index) => [source.number, reportChecks(reports[index]).checks.length]),
  );
  const total = items.length;
  const done = items.filter((item) => item.state.family === "done").length;
  const turn = items.filter((item) => item.state.family === "yourTurn").length;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
      let next: number | null = null;
      // event.code 는 한글 입력 상태에서도 같은 물리 키를 가리킨다.
      if (event.code === "KeyJ") next = Math.min(total, number + 1);
      else if (event.code === "KeyK") next = Math.max(1, number - 1);
      else {
        const digit = /^Digit([0-9])$/u.exec(event.code)?.[1];
        if (digit !== undefined) {
          const target = digit === "0" ? 10 : Number(digit);
          if (target <= total) next = target;
        }
      }
      if (next === null || next === number) return;
      event.preventDefault();
      onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [number, total, onSelect]);
  // 가로 칩 행(≤900px)에서는 고른 칩이 보이게 가로로만 옮긴다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 선택한 영상 번호가 바뀔 때만 맞춘다.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const row = list.current;
    const chip = row?.querySelector<HTMLElement>("[aria-current='true']");
    if (row && chip)
      row.scrollTo({ left: chip.offsetLeft - row.clientWidth / 2 + chip.clientWidth / 2 });
  }, [number]);
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    const next = number + step;
    if (next < 1 || next > total) return;
    event.preventDefault();
    onSelect(next);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLButtonElement>(`[data-video="${next}"]`)?.focus(),
    );
  };
  if (total === 0) return null;
  return (
    <aside className="video-list" aria-label="영상 목록">
      <div className="video-list-head">
        <h2>영상 {total}편</h2>
        <span className="video-list-counts">
          {done > 0 && (
            <span className="count count-done">
              <i aria-hidden="true" />
              <span className="sr-only">완료 </span>
              {done}
            </span>
          )}
          {turn > 0 && (
            <span className="count count-turn">
              <i aria-hidden="true" />
              <span className="sr-only">당신 차례 </span>
              {turn}
            </span>
          )}
        </span>
      </div>
      <ul className="video-rows" ref={list} onKeyDown={move}>
        {items.map((item) => {
          const poster = item.posterUrl !== null && !failed.has(item.number);
          const warn = checks.get(item.number) ?? 0;
          const finished = item.state.family === "done";
          return (
            <li key={item.number}>
              <button
                type="button"
                className={`video-row ${finished ? "is-done" : ""}`}
                data-video={item.number}
                aria-current={item.number === number ? "true" : undefined}
                aria-label={`영상 ${item.number} ${item.title}`}
                onClick={() => onSelect(item.number)}
              >
                <span className={`row-thumb ${poster ? "" : "row-thumb-empty"}`}>
                  {poster && (
                    <img
                      src={item.posterUrl ?? undefined}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={() => setFailed((current) => new Set(current).add(item.number))}
                    />
                  )}
                </span>
                <span className="row-text">
                  <span className="row-title">{item.title}</span>
                  <span className="row-meta">
                    <span className="row-k">영상 {item.number}</span>
                    {finished && item.durationMs !== null && (
                      <span>{seconds(item.durationMs)}</span>
                    )}
                    {finished && warn > 0 && <span>확인할 점 {warn}</span>}
                    {!finished && <StatusDot state={item.state} />}
                  </span>
                </span>
                <span className="row-state">
                  <StatusDot state={item.state} hideLabel />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="video-list-hint" aria-hidden="true">
        <kbd>1</kbd>–<kbd>{total >= 10 ? "0" : String(total)}</kbd> 영상 전환 · <kbd>J</kbd>
        <kbd>K</kbd> 위아래
      </p>
    </aside>
  );
}
