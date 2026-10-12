import {
  Download,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Music,
  Play,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { videoScriptFor } from "../shared/flow-mode";
import type { AgentId, Artifact, Job } from "../shared/schema";
import { JobSchema } from "../shared/schema";
import { ArtifactContent } from "./ArtifactContent";
import { agentMeta } from "./agentMeta";
import { api, errorMessage } from "./api";
import { cleanConcept } from "./EvidenceTab";
import { ArtifactProvenance } from "./ModelProvenance";
import { Button, Dialog, Disclosure, Notice, Segmented } from "./primitives";
import { videoBoardItems } from "./VideoBoard";
import "./tabs.css";

// 파일 탭: 502개 안팎의 산출물을 "현재본만, 영상별로" 보여 준다.
// 이름 규칙(server 가 저장하는 이름)을 읽어 종류·영상 번호·시도·재조립 이전 버전을 가려낸다 — 새 규칙을 만들지 않고 이름만 해석한다.

export type FileCategory = "final" | "clip" | "image" | "voice" | "doc";
export type FileOwner = {
  readonly type: "video" | "ad" | "common";
  readonly number: number;
};
export type FileEntry = {
  readonly artifact: Artifact;
  readonly category: FileCategory;
  readonly owner: FileOwner;
  // 같은 파일의 시도·재조립 이전 버전은 같은 key 를 가진다(확장자 포함).
  readonly key: string;
  // 이름 끝의 시도 번호. 시도 개념이 없는 파일은 0.
  readonly attempt: number;
  // 재조립 때 서버가 남긴 이전 결과(…-before-reassembly-<uuid>)인지.
  readonly backup: boolean;
  readonly label: string;
  // 서버 목록 순서(클수록 최근).
  readonly order: number;
};
type Parsed = Pick<FileEntry, "category" | "owner" | "key" | "attempt" | "label">;

const BACKUP = /^(.+)-before-reassembly-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(\.[^.]+)$/u;
const common: FileOwner = { type: "common", number: 0 };
const video = (n: string): FileOwner => ({ type: "video", number: Number(n) });
const ad = (n: string): FileOwner => ({ type: "ad", number: Number(n) });
const at = (m: RegExpExecArray, index: number): string => m[index] ?? "";
const scriptKinds = {
  draft: "대본 초안",
  response: "대본 모델 응답",
  review: "대본 AI 검토",
  issues: "대본 문제 목록",
} as const;
const infoKinds = { info: "설명 장면", clean: "깨끗한 장면" } as const;

const RULES: readonly (readonly [RegExp, (m: RegExpExecArray) => Parsed])[] = [
  [
    /^video-final-(\d+)$/u,
    (m) => ({
      category: "final",
      owner: video(at(m, 1)),
      key: `final-${at(m, 1)}`,
      attempt: 0,
      label: `영상 ${at(m, 1)} 완성본`,
    }),
  ],
  [
    /^clip-(\d+)-([A-Z]\d?)-(\d+)$/u,
    (m) => ({
      category: "clip",
      owner: video(at(m, 1)),
      key: `clip-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: at(m, 2).startsWith("I") ? `설명 클립 ${at(m, 2)}` : `클립 ${at(m, 2)}`,
    }),
  ],
  [
    /^voice-(\d+)-(\d+)-(\d+)$/u,
    (m) => ({
      category: "voice",
      owner: video(at(m, 1)),
      key: `voice-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `내레이션 문장 ${Number(at(m, 2))}`,
    }),
  ],
  [
    /^voice-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 1)),
      key: `voice-${at(m, 1)}`,
      attempt: 0,
      label: "내레이션 타이밍",
    }),
  ],
  [
    /^start-(\d+)-([A-Z])-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: video(at(m, 1)),
      key: `start-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `시작 이미지 ${at(m, 2)}`,
    }),
  ],
  [
    /^start-review-(\d+)-([A-Z])-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 1)),
      key: `start-review-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `시작 이미지 ${at(m, 2)} 검토`,
    }),
  ],
  [
    /^still-(\d+)-(S\d+)-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: video(at(m, 1)),
      key: `still-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `정지 이미지 ${at(m, 2)}`,
    }),
  ],
  [
    /^still-review-(\d+)-(S\d+)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 1)),
      key: `still-review-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `정지 이미지 ${at(m, 2)} 검토`,
    }),
  ],
  [
    /^info-(\d+)-(I\d)-(info|clean)-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: video(at(m, 1)),
      key: `info-${at(m, 1)}-${at(m, 2)}-${at(m, 3)}`,
      attempt: Number(at(m, 4)),
      label: `${infoKinds[at(m, 3) === "info" ? "info" : "clean"]} ${at(m, 2)}`,
    }),
  ],
  [
    /^card-h(\d+)-(\d+)-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: ad(at(m, 1)),
      key: `card-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: `카드뉴스 ${at(m, 2)}장`,
    }),
  ],
  [
    /^card-review-h(\d+)-(\d+)(?:-(\d+))?$/u,
    (m) => ({
      category: "doc",
      owner: ad(at(m, 1)),
      key: `card-review-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3) || 0),
      label: `카드뉴스 ${at(m, 2)}장 검토`,
    }),
  ],
  [
    /^image-h(\d+)-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: ad(at(m, 1)),
      key: `image-${at(m, 1)}`,
      attempt: Number(at(m, 2)),
      label: "광고 이미지",
    }),
  ],
  [
    /^review-h(\d+)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: ad(at(m, 1)),
      key: `review-${at(m, 1)}`,
      attempt: Number(at(m, 2)),
      label: "광고 이미지 검토",
    }),
  ],
  [
    /^(render-report|flow-export|video-script|timeline|captions)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 2)),
      key: `${at(m, 1)}-${at(m, 2)}`,
      attempt: 0,
      label:
        {
          "render-report": "렌더 보고",
          "flow-export": "Flow 지시서",
          "video-script": "영상 대본",
          timeline: "타임라인",
          captions: "자막",
        }[at(m, 1)] ?? at(m, 1),
    }),
  ],
  [
    /^video-script-(draft|response|review|issues)-(\d+)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 2)),
      key: `video-script-${at(m, 1)}-${at(m, 2)}`,
      attempt: Number(at(m, 3)),
      label: scriptKinds[at(m, 1) as keyof typeof scriptKinds] ?? "대본 기록",
    }),
  ],
  [
    /^video-copy-(\d+)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: video(at(m, 1)),
      key: `video-copy-${at(m, 1)}`,
      attempt: Number(at(m, 2)),
      label: "카피 초안",
    }),
  ],
  [
    /^plan-(draft|critique)-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: common,
      key: `plan-${at(m, 1)}`,
      attempt: Number(at(m, 2)),
      label: at(m, 1) === "draft" ? "광고안 초안" : "광고안 AI 검토",
    }),
  ],
  [
    /^image-auto-(\d+)$/u,
    (m) => ({
      category: "image",
      owner: common,
      key: "image-auto",
      attempt: Number(at(m, 1)),
      label: "광고 이미지",
    }),
  ],
  [
    /^review-auto-(\d+)$/u,
    (m) => ({
      category: "doc",
      owner: common,
      key: "review-auto",
      attempt: Number(at(m, 1)),
      label: "광고 이미지 검토",
    }),
  ],
  [
    /^(strategy|creative|analysis)(?:-auto|-\d+)?$/u,
    (m) => ({
      category: "doc",
      owner: common,
      key: at(m, 0),
      attempt: 0,
      label:
        { strategy: "광고 전략", creative: "광고 기획", analysis: "성과 분석" }[at(m, 1)] ??
        at(m, 1),
    }),
  ],
  [
    /^source-plan-auto$/u,
    () => ({ category: "doc", owner: common, key: "source-plan", attempt: 0, label: "자료 기획" }),
  ],
  [
    /^instructions-plan$/u,
    () => ({
      category: "doc",
      owner: common,
      key: "instructions-plan",
      attempt: 0,
      label: "지시 파일 기록",
    }),
  ],
  [
    /^uploaded-\d+$/u,
    (m) => ({
      category: "image",
      owner: common,
      key: at(m, 0),
      attempt: 0,
      label: "업로드한 이미지",
    }),
  ],
];
const categoryOfKind = (kind: Artifact["kind"]): FileCategory =>
  kind === "image" ? "image" : kind === "video" ? "clip" : kind === "audio" ? "voice" : "doc";

export function classifyArtifact(artifact: Artifact, order: number): FileEntry {
  const backup = BACKUP.exec(artifact.name);
  const baseName = backup ? `${backup[1] ?? ""}${backup[2] ?? ""}` : artifact.name;
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extension = dot > 0 ? baseName.slice(dot) : "";
  for (const [pattern, parse] of RULES) {
    const matched = pattern.exec(stem);
    if (!matched) continue;
    const parsed = parse(matched);
    const category =
      parsed.category === "doc" && artifact.kind === "image" ? "image" : parsed.category;
    return {
      ...parsed,
      category,
      artifact,
      key: `${parsed.key}${extension}`,
      backup: backup !== null,
      order,
    };
  }
  return {
    artifact,
    category: categoryOfKind(artifact.kind),
    owner: common,
    key: baseName,
    attempt: 0,
    backup: backup !== null,
    label: artifact.name,
    order,
  };
}

// 같은 key 안에서 가장 늦은 시도(없으면 가장 늦게 저장된 것)가 현재본이고 나머지는 이전 버전이다.
// 재조립 이전 버전(backup)은 언제나 이전 버전이며, 현재본이 아예 없을 때만 가장 최근 백업을 현재본으로 본다.
export function splitVersions(entries: readonly FileEntry[]): {
  readonly current: FileEntry[];
  readonly previous: FileEntry[];
} {
  const byKey = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const list = byKey.get(entry.key);
    if (list) list.push(entry);
    else byKey.set(entry.key, [entry]);
  }
  const rank = (entry: FileEntry) => (entry.backup ? 0 : 1);
  const current: FileEntry[] = [];
  const previous: FileEntry[] = [];
  for (const list of byKey.values()) {
    const sorted = list
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a.attempt - b.attempt || a.order - b.order);
    const latest = sorted.pop();
    if (latest) current.push(latest);
    previous.push(...sorted.reverse());
  }
  return { current, previous };
}

export type FileGroupModel = {
  readonly id: string;
  readonly owner: FileOwner;
  readonly title: string;
  readonly subtitle: string;
  readonly current: readonly FileEntry[];
  readonly previous: readonly FileEntry[];
};
const CATEGORY_ORDER: Record<FileCategory, number> = {
  final: 0,
  image: 1,
  clip: 2,
  voice: 3,
  doc: 4,
};
const collator = new Intl.Collator("ko", { numeric: true });
const ownerRank = (owner: FileOwner) => (owner.type === "video" ? 0 : owner.type === "ad" ? 1 : 2);

export function buildFileGroups(artifacts: readonly Artifact[], job: Job): FileGroupModel[] {
  const entries = artifacts.map((artifact, index) => classifyArtifact(artifact, index));
  const { current, previous } = splitVersions(entries);
  const owners = new Map<string, FileOwner>();
  for (const entry of entries) owners.set(`${entry.owner.type}-${entry.owner.number}`, entry.owner);
  const sortEntries = (list: FileEntry[]) =>
    list.sort(
      (a, b) =>
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        collator.compare(a.label, b.label) ||
        a.attempt - b.attempt,
    );
  return [...owners.entries()]
    .sort(([, a], [, b]) => ownerRank(a) - ownerRank(b) || a.number - b.number)
    .map(([id, owner]) => {
      const own = (list: FileEntry[]) =>
        list.filter((entry) => `${entry.owner.type}-${entry.owner.number}` === id);
      const hypothesis =
        owner.type === "ad"
          ? job.creativePlan?.hypotheses.find((item) => item.id === `h${owner.number}`)
          : undefined;
      return {
        id,
        owner,
        title:
          owner.type === "video"
            ? `영상 ${owner.number}`
            : owner.type === "ad"
              ? `광고안 ${owner.number}`
              : "작업 공통",
        subtitle:
          owner.type === "video"
            ? (videoScriptFor(job, owner.number)?.title ?? "")
            : hypothesis
              ? cleanConcept(hypothesis.creative.concept)
              : "",
        current: sortEntries(own(current)),
        previous: own(previous),
      };
    });
}

type Kind = FileCategory | "all";
const KIND_LABELS: readonly (readonly [Kind, string])[] = [
  ["final", "완성 영상"],
  ["clip", "클립"],
  ["image", "이미지"],
  ["voice", "내레이션"],
  ["doc", "문서"],
  ["all", "전체"],
];
const extensionOf = (name: string) => (name.split(".").pop() ?? "").toUpperCase();
const seconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}초`;

function CategoryIcon({ category }: { readonly category: FileCategory }) {
  const props = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;
  if (category === "clip" || category === "final") return <Film {...props} />;
  if (category === "voice") return <Music {...props} />;
  if (category === "image") return <ImageIcon {...props} />;
  return <FileText {...props} />;
}

type FinalFacts = {
  readonly title: string;
  readonly posterUrl: string | null;
  readonly durationMs: number | null;
};
type PreviewTarget = { readonly artifact: Artifact; readonly label: string };

function FileRow({
  entry,
  onPreview,
  note,
}: {
  readonly entry: FileEntry;
  readonly onPreview: (target: PreviewTarget) => void;
  readonly note: string;
}) {
  return (
    <li className="file-row">
      <button
        type="button"
        className="file-row-main"
        title={entry.artifact.name}
        aria-label={`${entry.label} 미리보기`}
        onClick={() => onPreview({ artifact: entry.artifact, label: entry.label })}
      >
        <span className="file-icon">
          <CategoryIcon category={entry.category} />
        </span>
        <span className="file-row-text">
          <span className="file-row-label">{entry.label}</span>
          <span className="file-row-sub">
            {[extensionOf(entry.artifact.name), note].filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>
      <a
        className="file-get"
        href={entry.artifact.url}
        download={entry.artifact.name}
        aria-label={`${entry.label} 받기`}
        title="받기"
      >
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
      </a>
    </li>
  );
}

function ImageCard({
  entry,
  onPreview,
}: {
  readonly entry: FileEntry;
  readonly onPreview: (target: PreviewTarget) => void;
}) {
  return (
    <li className="file-card is-image">
      <button
        type="button"
        className="file-thumb"
        title={entry.artifact.name}
        aria-label={`${entry.label} 미리보기`}
        onClick={() => onPreview({ artifact: entry.artifact, label: entry.label })}
      >
        <img
          src={entry.artifact.url}
          alt={entry.label}
          loading="lazy"
          decoding="async"
          width={128}
          height={160}
        />
      </button>
      <div className="file-meta">
        <span className="file-label">{entry.label}</span>
        <a
          className="file-get is-small"
          href={entry.artifact.url}
          download={entry.artifact.name}
          aria-label={`${entry.label} 받기`}
          title="받기"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
    </li>
  );
}

function FinalCard({
  job,
  entry,
  facts,
  onPreview,
  wide = false,
}: {
  readonly job: Job;
  readonly entry: FileEntry;
  readonly facts: FinalFacts | undefined;
  readonly onPreview: (target: PreviewTarget) => void;
  readonly wide?: boolean;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const number = entry.owner.number;
  const poster = facts?.posterUrl && !posterFailed ? facts.posterUrl : null;
  return (
    <li className={`file-card is-final ${wide ? "is-wide" : ""}`}>
      <button
        type="button"
        className={`file-thumb is-poster ${poster ? "" : "is-empty"}`}
        title={entry.artifact.name}
        aria-label={`영상 ${number} 미리보기`}
        onClick={() => onPreview({ artifact: entry.artifact, label: entry.label })}
      >
        {poster ? (
          <img
            src={poster}
            alt={`영상 ${number} 포스터`}
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
          />
        ) : (
          <Film size={20} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="file-no">{number}</span>
        {!wide && facts?.durationMs != null && (
          <span className="file-dur">
            <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            {seconds(facts.durationMs)}
          </span>
        )}
      </button>
      <div className="file-meta is-stack">
        <span className="file-k">
          영상 {number}
          {wide && facts?.durationMs != null && ` · ${seconds(facts.durationMs)}`}
        </span>
        <strong className="file-title">{facts?.title || `영상 ${number}`}</strong>
      </div>
      <div className="file-actions">
        <a
          className="button button-secondary button-sm"
          href={entry.artifact.url}
          download={entry.artifact.name}
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
          받기
        </a>
        <a className="file-link" href={`?job=${job.id}&tab=scripts&n=${number}`}>
          대본·영상에서 열기
        </a>
      </div>
    </li>
  );
}

// 이전 버전 한 줄의 꼬리표. 같은 파일의 재조립 이전 버전은 이름이 같으므로 최근 것부터 번호를 붙인다.
function previousNote(entry: FileEntry, entries: readonly FileEntry[]): string {
  if (!entry.backup) return entry.attempt > 0 ? `시도 ${entry.attempt}` : "";
  const same = entries.filter((item) => item.backup && item.key === entry.key);
  return `재조립 전 · ${same.indexOf(entry) + 1}번째 이전`;
}

function PreviousVersions({
  entries,
  onPreview,
}: {
  readonly entries: readonly FileEntry[];
  readonly onPreview: (target: PreviewTarget) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <Disclosure variant="plain" summary={`이전 버전 ${entries.length}개`}>
      <ul className="file-rows is-previous">
        {entries.map((entry) => (
          <FileRow
            key={entry.artifact.id}
            entry={entry}
            onPreview={onPreview}
            note={previousNote(entry, entries)}
          />
        ))}
      </ul>
    </Disclosure>
  );
}

function FileGroup({
  job,
  group,
  kind,
  facts,
  onPreview,
}: {
  readonly job: Job;
  readonly group: FileGroupModel;
  readonly kind: Kind;
  readonly facts: ReadonlyMap<number, FinalFacts>;
  readonly onPreview: (target: PreviewTarget) => void;
}) {
  const matches = (entry: FileEntry) => kind === "all" || entry.category === kind;
  const current = group.current.filter(matches);
  const previous = group.previous.filter(matches);
  if (current.length === 0 && previous.length === 0) return null;
  const finals = current.filter((entry) => entry.category === "final");
  const images = current.filter((entry) => entry.category === "image");
  const rows = current.filter((entry) => entry.category !== "final" && entry.category !== "image");
  return (
    <section className="file-group" aria-label={group.title}>
      <header className="file-group-head">
        <h3>{group.title}</h3>
        {group.subtitle && <span className="file-group-sub">{group.subtitle}</span>}
        <span className="file-group-count">현재 {current.length}개</span>
      </header>
      {finals.length > 0 && (
        <ul className="file-finals">
          {finals.map((entry) => (
            <FinalCard
              key={entry.artifact.id}
              job={job}
              entry={entry}
              facts={facts.get(entry.owner.number)}
              onPreview={onPreview}
              wide
            />
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <ul className="file-media">
          {images.map((entry) => (
            <ImageCard key={entry.artifact.id} entry={entry} onPreview={onPreview} />
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <ul className="file-rows">
          {rows.map((entry) => (
            <FileRow
              key={entry.artifact.id}
              entry={entry}
              onPreview={onPreview}
              note={entry.attempt > 1 ? `시도 ${entry.attempt}` : ""}
            />
          ))}
        </ul>
      )}
      <PreviousVersions entries={previous} onPreview={onPreview} />
    </section>
  );
}

function FinalGallery({
  job,
  groups,
  facts,
  onPreview,
}: {
  readonly job: Job;
  readonly groups: readonly FileGroupModel[];
  readonly facts: ReadonlyMap<number, FinalFacts>;
  readonly onPreview: (target: PreviewTarget) => void;
}) {
  const cells = groups.flatMap((group) => {
    const finals = group.current.filter((entry) => entry.category === "final");
    const previous = group.previous.filter((entry) => entry.category === "final");
    return finals.map((entry) => ({ group, entry, previous }));
  });
  return (
    <ul className="final-gallery">
      {cells.map(({ group, entry, previous }) => (
        <li className="final-cell" key={group.id}>
          <ul className="final-cell-card">
            <FinalCard
              job={job}
              entry={entry}
              facts={facts.get(entry.owner.number)}
              onPreview={onPreview}
            />
          </ul>
          <PreviousVersions entries={previous} onPreview={onPreview} />
        </li>
      ))}
    </ul>
  );
}

export function FilesTab({
  job,
  filter,
  onRefresh,
}: {
  readonly job: Job | null;
  readonly filter: AgentId | null;
  readonly onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Kind | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => previewRequest.current?.abort(), []);
  const artifacts = job?.artifacts;
  const groups = useMemo(
    () =>
      job && artifacts
        ? buildFileGroups(
            artifacts.filter((item) => !filter || item.agentId === filter),
            job,
          )
        : [],
    [job, artifacts, filter],
  );
  const facts = useMemo(() => {
    const map = new Map<number, FinalFacts>();
    if (job)
      for (const item of videoBoardItems(job))
        map.set(item.number, {
          title: item.title,
          posterUrl: item.posterUrl,
          durationMs: item.durationMs,
        });
    return map;
  }, [job]);
  const counts = useMemo(() => {
    const result: Record<Kind, number> = { final: 0, clip: 0, image: 0, voice: 0, doc: 0, all: 0 };
    let previous = 0;
    for (const group of groups) {
      for (const entry of group.current) {
        result[entry.category] += 1;
        result.all += 1;
      }
      previous += group.previous.length;
    }
    return { ...result, previous };
  }, [groups]);

  const upload = async (file: File) => {
    if (!job) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("PNG 또는 JPEG 이미지를 선택해 주세요.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("15MB 이하의 이미지를 선택해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      JobSchema.parse(await api.post(`jobs/${job.id}/upload`, { body }).json());
      onRefresh();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const openArtifact = async (target: PreviewTarget) => {
    const { artifact } = target;
    previewRequest.current?.abort();
    const request = new AbortController();
    previewRequest.current = request;
    setPreview(target);
    setContent(null);
    setPreviewError(null);
    if (artifact.kind === "text" || artifact.kind === "json") {
      try {
        const text = z
          .string()
          .parse(
            await api.get(artifact.url.replace(/^\/api\//, ""), { signal: request.signal }).text(),
          );
        if (!request.signal.aborted && previewRequest.current === request) setContent(text);
      } catch (cause) {
        const message = await errorMessage(cause);
        if (!request.signal.aborted && previewRequest.current === request) setPreviewError(message);
      }
    }
  };
  const closePreview = () => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreview(null);
  };

  const kind: Kind = chosen ?? (counts.final > 0 ? "final" : "all");
  const visibleCount = counts[kind];
  return (
    <section className="files-tab" aria-label="파일">
      <header className="tab-head">
        <div>
          <h2>
            {filter ? `${agentMeta[filter].title} 파일` : "파일"}{" "}
            <span className="count-label">{counts.all}</span>
          </h2>
          <p>
            지금 쓰는 파일만 보여 줘요. 이전 시도와 다시 조립하기 전 파일은 영상마다 접어 두었어요.
          </p>
        </div>
        {job && !job.sourceSnapshot && !job.automation && (
          <label className={`button button-secondary upload-button ${pending ? "pending" : ""}`}>
            <Upload size={15} />
            <span>{pending ? "업로드 중" : "이미지 업로드 (선택)"}</span>
            <input
              aria-label="이미지 업로드 (선택)"
              type="file"
              accept="image/png,image/jpeg"
              disabled={
                pending ||
                job.status === "running" ||
                Boolean(job.staged) ||
                Boolean(job.automation)
              }
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
        )}
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {counts.all === 0 ? (
        <div className="panel empty-small">
          <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
          <h3>아직 파일이 없어요</h3>
          <p>
            {job
              ? "시작하면 이미지·내레이션·클립·완성 영상과 문서가 여기에 저장돼요."
              : "새 작업을 만들면 파일이 이곳에 모여요."}
          </p>
        </div>
      ) : (
        <>
          <div className="files-filter">
            <Segmented
              label="파일 종류"
              value={kind}
              onChange={setChosen}
              options={KIND_LABELS.map(([value, label]) => ({
                value,
                label: (
                  <>
                    {label}
                    <span className="seg-n">{counts[value]}</span>
                  </>
                ),
              }))}
            />
            {counts.previous > 0 && (
              <span className="files-previous-note">이전 버전 {counts.previous}개</span>
            )}
          </div>
          {job && visibleCount === 0 ? (
            <div className="panel empty-small">
              <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
              <h3>
                {kind === "final" ? "아직 완성된 영상이 없어요" : "이 종류의 파일이 아직 없어요"}
              </h3>
              <p>제작 중인 파일은 전체에서 볼 수 있어요.</p>
              <Button onClick={() => setChosen("all")}>전체 보기</Button>
            </div>
          ) : (
            job &&
            (kind === "final" ? (
              <FinalGallery job={job} groups={groups} facts={facts} onPreview={openArtifact} />
            ) : (
              <div className="file-groups">
                {groups.map((group) => (
                  <FileGroup
                    key={group.id}
                    job={job}
                    group={group}
                    kind={kind}
                    facts={facts}
                    onPreview={openArtifact}
                  />
                ))}
              </div>
            ))
          )}
        </>
      )}
      {preview && (
        <Dialog
          title={preview.label}
          description={preview.artifact.name}
          onClose={closePreview}
          wide
        >
          <div className="stack">
            <ArtifactProvenance artifact={preview.artifact} />
            {preview.artifact.kind === "image" ? (
              <img className="full-preview" src={preview.artifact.url} alt={preview.label} />
            ) : preview.artifact.kind === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: 자막은 영상 화면에 구워져 있어 별도 텍스트 트랙이 없다.
              <video
                className="full-preview"
                src={preview.artifact.url}
                controls
                preload="metadata"
              />
            ) : preview.artifact.kind === "audio" ? (
              // biome-ignore lint/a11y/useMediaCaption: 내레이션 음성은 대본 문장이 곧 자막이라 별도 텍스트 트랙이 없다.
              <audio className="full-preview" src={preview.artifact.url} controls />
            ) : previewError ? (
              <Notice tone="error">{previewError}</Notice>
            ) : (
              <ArtifactContent artifact={preview.artifact} content={content} />
            )}
            <a
              className="button button-secondary"
              href={preview.artifact.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              원본 열기
            </a>
          </div>
        </Dialog>
      )}
    </section>
  );
}
