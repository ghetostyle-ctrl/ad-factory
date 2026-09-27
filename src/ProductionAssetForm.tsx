import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type ProductionAsset,
  ProductionAssetSchema,
  UpdateProductionAssetSchema,
} from "../shared/production-assets";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

const videoNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function ProductionAssetForm({
  asset,
  onClose,
  onSaved,
}: {
  readonly asset: ProductionAsset;
  readonly onClose: () => void;
  readonly onSaved: (asset: ProductionAsset) => void;
}) {
  const [targetMode, setTargetMode] = useState(asset.settings.targets.mode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const end = String(data.get("endSec") ?? "").trim();
    if (targetMode === "selected" && data.getAll("videoNumbers").length === 0) {
      setError("적용할 영상을 1개 이상 선택해 주세요.");
      return;
    }
    const parsed = UpdateProductionAssetSchema.safeParse({
      title: data.get("title"),
      settings: {
        usage: data.get("usage"),
        startSec: Number(data.get("startSec")),
        endSec: end ? Number(end) : null,
        placement: data.get("placement"),
        targets:
          targetMode === "all"
            ? { mode: "all" }
            : {
                mode: "selected",
                videoNumbers: data.getAll("videoNumbers").map(Number),
              },
        audio: data.get("audio"),
        notes: data.get("notes"),
      },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "사용 지침을 확인해 주세요.");
      return;
    }
    const { startSec, endSec } = parsed.data.settings;
    if (
      startSec >= asset.durationSec ||
      (endSec !== null && (endSec <= startSec || endSec > asset.durationSec))
    ) {
      setError(`사용 구간은 0초부터 ${asset.durationSec}초 사이이며, 끝은 시작보다 뒤여야 합니다.`);
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setError(null);
    try {
      const response = await api
        .put(`projects/${asset.projectId}/production-assets/${asset.id}`, {
          json: parsed.data,
          signal: abort.signal,
        })
        .json();
      const saved = ProductionAssetSchema.parse(response);
      if (!abort.signal.aborted) onSaved(saved);
    } catch (cause) {
      const message =
        cause instanceof Error ? await errorMessage(cause) : "사용 지침을 저장하지 못했습니다.";
      if (!abort.signal.aborted) setError(message);
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  };
  return (
    <Dialog
      title="제작 소스 설정"
      description={asset.filename}
      onClose={onClose}
      closeDisabled={pending}
      wide
    >
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset className="production-form-fields stack" disabled={pending}>
          <Field label="소스 이름">
            <input name="title" required maxLength={240} defaultValue={asset.title} />
          </Field>
          <div className="form-grid">
            <Field label="사용 방식">
              <select name="usage" defaultValue={asset.settings.usage}>
                <option value="required">필수 사용</option>
                <option value="optional">AI 선택</option>
              </select>
            </Field>
            <Field label="배치 위치">
              <select name="placement" defaultValue={asset.settings.placement}>
                <option value="auto">AI 판단</option>
                <option value="opening">도입부</option>
                <option value="middle">제품 설명</option>
                <option value="ending">마무리</option>
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="시작 (초)">
              <input
                name="startSec"
                type="number"
                min={0}
                max={asset.durationSec}
                step="any"
                required
                defaultValue={asset.settings.startSec}
              />
            </Field>
            <Field label="끝 (초)" help={`비워두면 원본 끝까지 · 전체 ${asset.durationSec}초`}>
              <input
                name="endSec"
                type="number"
                min={0}
                max={asset.durationSec}
                step="any"
                defaultValue={asset.settings.endSec ?? ""}
                placeholder="끝까지"
              />
            </Field>
          </div>
          <Field label="적용할 영상">
            <select
              value={targetMode}
              onChange={(event) =>
                setTargetMode(event.target.value === "selected" ? "selected" : "all")
              }
            >
              <option value="all">영상 10개 전체</option>
              <option value="selected">선택한 영상만</option>
            </select>
          </Field>
          {targetMode === "selected" && (
            <fieldset className="production-targets">
              <legend>영상 선택 (1개 이상)</legend>
              <div className="production-video-choices">
                {videoNumbers.map((number) => (
                  <label className="approval-check" key={number}>
                    <input
                      name="videoNumbers"
                      type="checkbox"
                      value={number}
                      defaultChecked={
                        asset.settings.targets.mode === "selected" &&
                        asset.settings.targets.videoNumbers.includes(number)
                      }
                    />
                    <span>영상 {number}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label="원본 소리">
            <select name="audio" defaultValue={asset.settings.audio}>
              <option value="mute">음소거</option>
              <option value="keep">유지</option>
            </select>
            {!asset.hasAudio && (
              <small className="muted">이 원본에는 오디오 트랙이 없습니다.</small>
            )}
          </Field>
          <Field label="추가 사용 지침 (선택)">
            <textarea
              name="notes"
              maxLength={2000}
              defaultValue={asset.settings.notes}
              placeholder="예: 제품 로고가 보이는 장면을 사용해 주세요."
            />
          </Field>
        </fieldset>
        <Notice>
          설정은 이후 만드는 작업과 제작 지시서에 저장됩니다. 이미 만든 작업은 바뀌지 않습니다.
        </Notice>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            {pending ? "설정 저장 중…" : "설정 저장"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
