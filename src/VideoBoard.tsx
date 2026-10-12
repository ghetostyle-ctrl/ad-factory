import { Download, Hand, LayoutGrid, List, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { pendingFlowClips, videoScriptFor, waitingVideoNumber } from "../shared/flow-mode";
import { jobProgress } from "../shared/next-action";
import type { Artifact, Job } from "../shared/schema";
import { pendingScriptApprovals } from "../shared/script-approval";
import { pendingScriptDraft } from "../shared/script-drafts";
import { agentUiState, automationUiState, PHASE_LABELS, type UiState } from "../shared/ui-state";
import { Button, Dialog, Segmented, StatusDot } from "./primitives";

type BoardItem = {
  readonly number: number;
  readonly title: string;
  readonly hasScript: boolean;
  readonly state: UiState;
  readonly posterUrl: string | null;
  readonly durationMs: number | null;
  readonly download: Artifact | null;
};

const CLIP_PHASES = new Set(["voice", "stills", "startImages", "clips", "graphics", "assemble"]);
const FLOW_IMAGE_PHASES = new Set(["image", "stills", "startImages"]);
const stateHead = (state: UiState) => state.label.split(" · ")[0] ?? state.label;
const stateTail = (state: UiState) => state.label.split(" · ").slice(1).join(" · ");

// 영상 한 편의 상태. 문구는 ui-state 의 어휘(완료·당신 차례·진행 중·대기)를 그대로 쓰고, 단계 이름은 PHASE_LABELS 에서 읽는다.
function videoState(job: Job, number: number, done: boolean): UiState {
  if (done) return agentUiState("completed");
  const automation = job.automation;
  if (automation?.policy.mode !== "creative") return agentUiState("idle");
  const draft = pendingScriptDraft(job);
  const base = automationUiState(automation, job);
  if (draft) return draft.number === number ? base : agentUiState("idle");
  const current = waitingVideoNumber(job);
  if (automation.status === "waiting") {
    if (automation.phase === "script")
      return pendingScriptApprovals(job).includes(number) ? base : agentUiState("idle");
    if (current !== number) return agentUiState("idle");
    if (FLOW_IMAGE_PHASES.has(automation.phase)) return base;
    const script = videoScriptFor(job, number);
    const total = script ? script.veoClips.length + script.infoClips.length : 0;
    const missing = pendingFlowClips(job, number).length;
    return { ...base, label: `${stateHead(base)} · 클립 ${total - missing}/${total}` };
  }
  if (current !== number) return agentUiState("idle");
  if (
    (automation.status === "running" || automation.status === "queued") &&
    CLIP_PHASES.has(automation.phase)
  )
    return agentUiState("running", PHASE_LABELS[automation.phase]);
  if (["blocked", "attention", "stopped"].includes(automation.status)) return base;
  return agentUiState("idle");
}

export function videoBoardItems(job: Job): BoardItem[] {
  const total = jobProgress(job).total;
  return Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    const render = job.renders.find((item) => item.number === number);
    const finalName = render?.final?.name ?? `video-final-${number}.mp4`;
    const download = job.artifacts.find((item) => item.name === finalName) ?? null;
    const done = Boolean(render?.final) || download !== null;
    const script = videoScriptFor(job, number);
    return {
      number,
      title: script?.title ?? `영상 ${number}`,
      hasScript: script !== undefined,
      state: videoState(job, number, done),
      posterUrl: render?.final
        ? `/api/jobs/${job.id}/videos/${number}/poster.jpg?v=${render.final.digest}`
        : null,
      durationMs: render?.final?.durationMs ?? null,
      download,
    };
  });
}
const seconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}초`;

function useNarrow(query = "(max-width: 760px)"): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    media.addEventListener("change", sync);
    sync();
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

function Thumb({
  item,
  failed,
  onFail,
  small = false,
}: {
  readonly item: BoardItem;
  readonly failed: boolean;
  readonly onFail: () => void;
  readonly small?: boolean;
}) {
  const poster = item.posterUrl !== null && !failed;
  const yourTurn = item.state.family === "yourTurn";
  return (
    <span className={`video-thumb ${poster ? "" : "video-thumb-empty"} ${small ? "is-small" : ""}`}>
      {poster ? (
        <img
          src={item.posterUrl ?? undefined}
          alt={`영상 ${item.number} 포스터`}
          loading="lazy"
          decoding="async"
          onError={onFail}
        />
      ) : (
        !small && (
          <span className="video-empty-text">{item.hasScript ? "대본 준비됨" : "대기"}</span>
        )
      )}
      {!small && <span className="video-no">{item.number}</span>}
      {!small && poster && item.durationMs !== null && (
        <span className="video-dur">
          <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {seconds(item.durationMs)}
        </span>
      )}
      {!small && !poster && yourTurn && (
        <span className="video-turn">
          <Hand size={14} strokeWidth={1.75} aria-hidden="true" />
          {stateTail(item.state)}
        </span>
      )}
    </span>
  );
}

export function VideoBoard({
  job,
  onOpenVideo,
  onDownloadAll,
}: {
  readonly job: Job;
  readonly onOpenVideo: (number: number) => void;
  readonly onDownloadAll: () => void;
}) {
  const [mode, setMode] = useState<"board" | "list">("board");
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const narrow = useNarrow();
  const items = videoBoardItems(job);
  if (items.length === 0) return null;
  const done = items.filter((item) => item.state.family === "done").length;
  const list = mode === "list" && !narrow;
  const fail = (number: number) => setFailed((current) => new Set(current).add(number));
  return (
    <section className="video-board" aria-labelledby="video-board-title">
      <div className="board-head">
        <h2 id="video-board-title">영상 {items.length}편</h2>
        <span className="board-sub">카드를 열면 재생 · 대본 · 제작 소스</span>
        <span className="board-spacer" />
        {!narrow && (
          <Segmented
            label="영상 보기 방식"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "board",
                label: (
                  <>
                    <LayoutGrid size={14} strokeWidth={1.75} aria-hidden="true" />
                    보드
                  </>
                ),
              },
              {
                value: "list",
                label: (
                  <>
                    <List size={14} strokeWidth={1.75} aria-hidden="true" />
                    목록
                  </>
                ),
              },
            ]}
          />
        )}
        {done > 0 && (
          <Button size="sm" onClick={onDownloadAll}>
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            완성 {done}편 모두 받기
          </Button>
        )}
      </div>
      <ul className={list ? "video-lines" : "video-grid"}>
        {items.map((item) => (
          <li className={list ? "video-line" : "video-card"} key={item.number}>
            <button
              type="button"
              className="video-open"
              aria-label={`영상 ${item.number} ${item.title} 열기`}
              onClick={() => onOpenVideo(item.number)}
            >
              <Thumb
                item={item}
                failed={failed.has(item.number)}
                onFail={() => fail(item.number)}
                small={list}
              />
              <span className="video-text">
                <span className="video-k">영상 {item.number}</span>
                <span className="video-title">{item.title}</span>
              </span>
            </button>
            <div className="video-meta">
              <StatusDot state={item.state} />
              {list && item.durationMs !== null && (
                <span className="video-line-dur">{seconds(item.durationMs)}</span>
              )}
              {item.download && (
                <a
                  className="video-download"
                  href={item.download.url}
                  download={item.download.name}
                  aria-label={`영상 ${item.number} MP4 받기`}
                  title="MP4 받기"
                >
                  <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// 완성 영상을 한곳에서 받는 목록. 브라우저가 여러 파일을 한꺼번에 받는 것을 막기 때문에 파일마다 받기 링크를 둔다.
export function FinalsDialog({
  job,
  numbers,
  onClose,
}: {
  readonly job: Job;
  readonly numbers: readonly number[] | null;
  readonly onClose: () => void;
}) {
  const items = videoBoardItems(job).filter(
    (item) => item.download !== null && (numbers === null || numbers.includes(item.number)),
  );
  return (
    <Dialog
      title={`완성 영상 ${items.length}편 받기`}
      description="영상마다 받기 버튼을 눌러 MP4 파일을 저장해요."
      onClose={onClose}
      wide
    >
      <ul className="finals-list">
        {items.map((item) => (
          <li key={item.number}>
            <span className="finals-no">영상 {item.number}</span>
            <span className="finals-title">{item.title}</span>
            <span className="finals-dur">
              {item.durationMs === null ? "" : seconds(item.durationMs)}
            </span>
            {item.download && (
              <a
                className="button button-secondary button-sm"
                href={item.download.url}
                download={item.download.name}
              >
                <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                받기
              </a>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
