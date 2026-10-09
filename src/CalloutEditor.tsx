import { RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import type { CalloutMotion, MotionPoint } from "../shared/callout-motion";
import { type CalloutOverridesView, CalloutOverridesViewSchema } from "../shared/callout-overrides";
import { api, errorMessage } from "./api";
import { CalloutCoordinates, CalloutPoints, initialCalloutMotion } from "./CalloutCoordinates";
import { CalloutPreview } from "./CalloutPreview";
import { Button, Field, Notice } from "./primitives";
import "./callout-editor.css";

export function CalloutEditor({
  jobId,
  number,
}: {
  readonly jobId: string;
  readonly number: number;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CalloutOverridesView | null>(null);
  const [drafts, setDrafts] = useState<Record<number, CalloutMotion>>({});
  const [selected, setSelected] = useState(0);
  const [point, setPoint] = useState(0);
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [watched, setWatched] = useState(false);
  const [pending, setPending] = useState<"load" | "save" | "render" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const base = `jobs/${jobId}/videos/${number}`;
  const item = view?.callouts.find((entry) => entry.index === selected);
  const motion = item ? (drafts[selected] ?? initialCalloutMotion(item)) : null;
  const frame = motion?.keyframes[point];
  const resetChecks = () => {
    setChecked([]);
    setWatched(false);
  };
  const load = async () => {
    setPending("load");
    setError(null);
    try {
      const result = CalloutOverridesViewSchema.parse(
        await api.get(`${base}/callout-overrides`).json(),
      );
      setView(result);
      setDrafts({});
      setSelected(result.callouts[0]?.index ?? 0);
      setPoint(0);
      resetChecks();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  const updatePoint = (part: "target" | "label", axis: keyof MotionPoint, value: number) => {
    if (!motion || !Number.isFinite(value)) return;
    const keyframes = motion.keyframes.map((entry, index) =>
      index === point
        ? { ...entry, [part]: { ...entry[part], [axis]: Math.max(0, Math.min(100, value)) / 100 } }
        : entry,
    );
    setDrafts({ ...drafts, [selected]: { ...motion, keyframes } });
    setChecked(checked.filter((index) => index !== point));
    setWatched(false);
    setNotice(null);
  };
  const save = async () => {
    if (!view || !motion) return;
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const callouts = view.callouts.flatMap((entry) => {
        const saved = entry.index === selected ? motion : entry.motion;
        return saved && (entry.index === selected || saved.verification === "verified")
          ? [{ index: entry.index, targetId: saved.targetId, keyframes: saved.keyframes }]
          : [];
      });
      setView(
        CalloutOverridesViewSchema.parse(
          await api
            .put(`${base}/callout-overrides`, {
              json: { fingerprint: view.fingerprint, confirmReviewed: true, callouts },
            })
            .json(),
        ),
      );
      setNotice(
        "현재 설명선 위치를 저장했습니다. 아래 ‘저장한 위치로 다시 조립’을 눌러 영상에 반영하세요.",
      );
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  const render = async () => {
    setPending("render");
    setError(null);
    setNotice(null);
    try {
      await api.post(`${base}/reassemble`, { timeout: false });
      setVersion(Date.now());
      setNotice("저장한 설명선으로 다시 조립했습니다. 완성 영상을 재생해 확인하세요.");
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <details
      className="evidence-details callout-editor"
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded && !view && !pending) void load();
      }}
    >
      <summary>설명선 보정 (선택)</summary>
      <div className="stack callout-editor-body">
        <p className="muted small-copy">
          앱이 따로 얹는 설명선의 위치를 보정합니다. Flow 영상 안에 이미 포함된 글자와 선은 옮길 수
          없습니다. 위치 사이를 직선으로 연결하며 자동으로 대상을 추적하지 않습니다.
        </p>
        {pending === "load" && (
          <p role="status" className="muted small-copy">
            설명선을 불러오는 중입니다.
          </p>
        )}
        {error && (
          <Notice tone="error">
            {error}{" "}
            <Button size="sm" onClick={() => void load()} disabled={Boolean(pending)}>
              다시 불러오기
            </Button>
          </Notice>
        )}
        {notice && <Notice>{notice}</Notice>}
        {view?.sidecarStatus === "stale" && (
          <Notice tone="warning">
            영상 소스나 화면 구성이 바뀌어 이전 위치는 적용하지 않습니다. 새 화면에서 다시 확인해
            주세요.
          </Notice>
        )}
        {view && view.callouts.length === 0 && (
          <p className="muted small-copy">이 영상에는 위치를 조정할 설명선이 없습니다.</p>
        )}
        {view && item && motion && frame && (
          <>
            <Field label="조정할 설명선">
              <select
                value={selected}
                disabled={Boolean(pending)}
                onChange={(event) => {
                  setSelected(Number(event.target.value));
                  setPoint(0);
                  resetChecks();
                  setNotice(null);
                }}
              >
                {view.callouts.map((entry) => (
                  <option key={entry.index} value={entry.index}>
                    컷 {entry.cutIndex + 1} · {entry.text}
                  </option>
                ))}
              </select>
            </Field>
            <div className="callout-editor-grid">
              <CalloutPreview
                key={`${selected}-${version}`}
                url={`${view.finalUrl}${view.finalUrl.includes("?") ? "&" : "?"}preview=${version}`}
                item={item}
                motion={motion}
                selectedAt={frame.at}
              />
              <div className="stack callout-editor-controls">
                <p className="muted small-copy">
                  영상에서 문구가 표시되는 구간: {(item.startMs / 1000).toFixed(2)}–
                  {(item.endMs / 1000).toFixed(2)}초. 아래 위치는 컷 전체를 기준으로 정합니다.
                </p>
                <Field
                  label="설명할 대상"
                  help="예: 캡슐 껍질, 내부 오일. 같은 대상을 계속 가리키도록 확인하세요."
                >
                  <input
                    value={motion.targetId}
                    maxLength={80}
                    disabled={Boolean(pending)}
                    onChange={(event) => {
                      setDrafts({
                        ...drafts,
                        [selected]: { ...motion, targetId: event.target.value },
                      });
                      resetChecks();
                      setNotice(null);
                    }}
                  />
                </Field>
                <CalloutPoints
                  frames={motion.keyframes}
                  selected={point}
                  checked={checked}
                  disabled={Boolean(pending)}
                  onSelect={setPoint}
                />
                <CalloutCoordinates
                  position={frame}
                  disabled={Boolean(pending)}
                  checked={checked.includes(point)}
                  watched={watched}
                  onChange={updatePoint}
                  onCheck={(value) =>
                    setChecked(
                      value ? [...checked, point] : checked.filter((index) => index !== point),
                    )
                  }
                  onWatch={setWatched}
                />
                <Button
                  pending={pending === "save"}
                  disabled={
                    Boolean(pending) ||
                    !motion.targetId.trim() ||
                    checked.length !== motion.keyframes.length ||
                    !watched
                  }
                  onClick={() => void save()}
                >
                  <Save size={14} aria-hidden="true" />
                  현재 설명선 저장
                </Button>
              </div>
            </div>
            <div className="callout-editor-apply">
              <p className="muted small-copy">
                저장만으로 완성 영상은 바뀌지 않습니다. 다시 조립하면 기존 영상은 백업하고, 저장된
                소스와 음성으로 설명선을 반영합니다. 다른 설명선도 각각 확인하고 저장하세요. 유료
                생성은 없습니다.
              </p>
              <Button
                pending={pending === "render"}
                disabled={Boolean(pending) || view.sidecarStatus !== "current"}
                onClick={() => void render()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                저장한 위치로 다시 조립
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
