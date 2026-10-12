import { type KeyboardEvent, useRef } from "react";
import type { Job } from "../shared/schema";

// 작업 화면 탭 5개(docs/UI-V2-2026-10-12.md 4절). URL ?job=&tab=&n= 의 tab 값과 같은 키를 쓴다.
export const JOB_TAB_KEYS = ["overview", "scripts", "evidence", "files", "log"] as const;
export type JobTabKey = (typeof JOB_TAB_KEYS)[number];
export function isJobTabKey(value: string | null): value is JobTabKey {
  return JOB_TAB_KEYS.some((key) => key === value);
}
export const JOB_PANEL_ID = "job-panel";
export const jobTabId = (key: JobTabKey) => `job-tab-${key}`;

export function jobTabInfo(
  key: JobTabKey,
  job: Job,
): { readonly label: string; readonly count: number } {
  switch (key) {
    case "overview":
      return { label: "개요", count: 0 };
    case "scripts":
      return { label: "대본·영상", count: job.videoScripts.length };
    case "evidence":
      return { label: "기획 근거", count: job.creativePlan?.hypotheses.length ?? 0 };
    case "files":
      return { label: "파일", count: job.artifacts.length };
    case "log":
      return { label: "기록", count: job.events.length };
  }
}

export function JobTabs({
  job,
  tab,
  onTab,
}: {
  readonly job: Job;
  readonly tab: JobTabKey;
  readonly onTab: (tab: JobTabKey) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = JOB_TAB_KEYS.length - 1;
    const target =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const key = JOB_TAB_KEYS[target];
    if (!key) return;
    onTab(key);
    list.current?.querySelector<HTMLButtonElement>(`#${jobTabId(key)}`)?.focus();
  };
  return (
    <div className="job-tabs" role="tablist" aria-label="작업 화면" ref={list}>
      {JOB_TAB_KEYS.map((key, index) => {
        const { label, count } = jobTabInfo(key, job);
        const selected = key === tab;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            id={jobTabId(key)}
            className="job-tab"
            aria-selected={selected}
            aria-controls={JOB_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onTab(key)}
            onKeyDown={(event) => move(event, index)}
          >
            {label}
            {count > 0 && <span className="job-tab-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
