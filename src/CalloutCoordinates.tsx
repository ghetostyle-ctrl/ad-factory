import type { CalloutMotion, MotionPoint, MotionPosition } from "../shared/callout-motion";
import type { CalloutOverridesView } from "../shared/callout-overrides";
import { Button, Field } from "./primitives";

export function initialCalloutMotion(
  item: CalloutOverridesView["callouts"][number],
): CalloutMotion {
  if (item.motion) return { ...item.motion, verification: "planned" };
  const labelX = item.anchor === "left" ? 0.25 : item.anchor === "right" ? 0.75 : 0.5;
  return {
    targetId: item.targetId ?? `대상 ${item.index + 1}`,
    verification: "planned",
    keyframes: [0, 0.5, 1].map((at) => ({
      at,
      target: { x: 0.5, y: 0.5 },
      label: { x: labelX, y: 0.3 },
    })),
  };
}

export function CalloutPoints({
  frames,
  selected,
  checked,
  disabled,
  onSelect,
}: {
  readonly frames: CalloutMotion["keyframes"];
  readonly selected: number;
  readonly checked: readonly number[];
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <div className="callout-point-tabs">
      {frames.map((entry, index) => (
        <Button
          key={entry.at}
          aria-pressed={selected === index}
          disabled={disabled}
          onClick={() => onSelect(index)}
        >
          {index === 0 ? "시작" : index === frames.length - 1 ? "끝" : `중간 ${index}`} ·{" "}
          {(entry.at * 100).toFixed(0)}%{checked.includes(index) ? " · 확인" : ""}
        </Button>
      ))}
    </div>
  );
}

export function CalloutCoordinates({
  position,
  disabled,
  checked,
  watched,
  onChange,
  onCheck,
  onWatch,
}: {
  readonly position: MotionPosition;
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly watched: boolean;
  readonly onChange: (part: "target" | "label", axis: keyof MotionPoint, value: number) => void;
  readonly onCheck: (value: boolean) => void;
  readonly onWatch: (value: boolean) => void;
}) {
  return (
    <>
      <fieldset className="callout-coordinates" disabled={disabled}>
        <legend>선택한 시점의 위치 (%)</legend>
        {(["target", "label"] as const).map((part) => (
          <div className="callout-coordinate-row" key={part}>
            <strong>{part === "target" ? "대상 점" : "문구 중심"}</strong>
            {(["x", "y"] as const).map((axis) => (
              <Field
                key={axis}
                label={`${part === "target" ? "대상" : "문구"} ${axis === "x" ? "가로" : "세로"}`}
              >
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={Math.round(position[part][axis] * 1000) / 10}
                  onChange={(event) => onChange(part, axis, event.target.valueAsNumber)}
                />
              </Field>
            ))}
          </div>
        ))}
      </fieldset>
      <label className="callout-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheck(event.target.checked)}
        />
        <span>이 시점의 대상과 문구 위치를 확인했습니다.</span>
      </label>
      <label className="callout-check">
        <input
          type="checkbox"
          checked={watched}
          disabled={disabled}
          onChange={(event) => onWatch(event.target.checked)}
        />
        <span>사이 구간도 재생해 같은 대상을 가리키는지 확인했습니다.</span>
      </label>
    </>
  );
}
