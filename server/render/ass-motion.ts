import { type CalloutMotion, type MotionPoint, motionPointAt } from "../../shared/callout-motion";
import type { TimelineCallout, TimelineCut } from "../../shared/render-timeline";
import { assColor, assDialogue, assEscape } from "./ass-primitives";
import type { FontSet } from "./fonts";
import { fitText } from "./text-fit";
import { type RenderProfile, renderColors, THEME, themePx, type VisualPolicy } from "./theme";

type MotionCallout = TimelineCallout & { readonly motion: CalloutMotion };
type Surface = {
  readonly profile: RenderProfile;
  readonly font: FontSet;
  readonly top: number;
  readonly policy: VisualPolicy;
};
type Box = { readonly center: MotionPoint; readonly w: number; readonly h: number };
const n = (value: number) => Math.round(value);
const pos = (point: MotionPoint) => `\\an5\\pos(${n(point.x)},${n(point.y)})`;
const polygon = (points: readonly MotionPoint[]) => {
  const first = points[0];
  if (!first) return "";
  const tail = points
    .slice(1)
    .map((point) => `l ${n(point.x)} ${n(point.y)}`)
    .join(" ");
  return `{\\p1}m ${n(first.x)} ${n(first.y)} ${tail}{\\p0}`;
};

// A reviewed screen-space path is sampled on the output frame grid. It is not automatic object tracking.
export function motionCalloutEvents(
  callout: MotionCallout,
  cut: TimelineCut,
  surface: Surface,
): string[] {
  if (callout.motion.verification !== "verified") return [];
  const { profile, font, policy } = surface;
  const { width: W, height: H } = profile;
  const start = Math.max(cut.startMs, callout.startMs);
  const end = Math.min(cut.endMs, callout.endMs);
  if (end <= start) return [];
  const colors = renderColors(policy);
  const accent = assColor(colors.accents[callout.color] ?? colors.accent);
  const ink = assColor(colors.text);
  const background = assColor(colors.background);
  const pad = Math.max(2, W * 0.018);
  const fit = fitText(assEscape(callout.text, Number.POSITIVE_INFINITY), {
    font,
    base: themePx(profile, THEME.callout.label),
    maxWidth: W * 0.46 - 2 * pad,
    maxLines: 2,
  });
  const size = { w: fit.widthPx + 2 * pad, h: fit.heightPx + 2 * pad };
  const rectangle = polygon([
    { x: 0, y: 0 },
    { x: size.w, y: 0 },
    { x: size.w, y: size.h },
    { x: 0, y: size.h },
  ]);
  const radius = Math.max(2, H * 0.004);
  const dot = polygon(
    Array.from({ length: 16 }, (_, index) => ({
      x: radius + radius * Math.cos((index * Math.PI) / 8),
      y: radius + radius * Math.sin((index * Math.PI) / 8),
    })),
  );
  const step = 1000 / Math.max(1, Math.min(60, profile.fps));
  const events: string[] = [];
  for (let frame = Math.floor(start / step); frame * step < end; frame++) {
    const startMs = Math.max(start, frame * step);
    const endMs = Math.min(end, (frame + 1) * step);
    const sample = motionPointAt(
      callout.motion,
      (startMs - cut.startMs) / (cut.endMs - cut.startMs),
    );
    if (!sample || endMs <= startMs) continue;
    const target = { x: sample.target.x * W, y: sample.target.y * H };
    const left = W * THEME.safe.side + size.w / 2;
    const right = W * (1 - THEME.safe.side) - size.w / 2;
    const top = H * surface.top + size.h / 2;
    const bottom = H * THEME.callout.floor - size.h / 2;
    const center = {
      x: Math.min(right, Math.max(left, sample.label.x * W)),
      y: Math.min(bottom, Math.max(top, sample.label.y * H)),
    };
    // Preserve the real target location. Only the readable label is clamped into the safe area.
    const targetVisible =
      sample.target.x >= THEME.safe.side &&
      sample.target.x <= 1 - THEME.safe.side &&
      sample.target.y >= surface.top &&
      sample.target.y <= THEME.callout.floor;
    if (targetVisible) {
      const box: Box = { ...size, center };
      const line = leaderVector(box, target, Math.max(1, H * 0.0025));
      if (line) {
        events.push(
          assDialogue({
            startMs,
            endMs,
            style: "MotionLeader",
            layer: 2,
            text: `{\\an7\\pos(0,0)\\1c${accent}&\\bord0}${line}`,
          }),
        );
        events.push(
          assDialogue({
            startMs,
            endMs,
            style: "MotionTarget",
            layer: 3,
            text: `{${pos(target)}\\1c${accent}&\\bord0}${dot}`,
          }),
        );
      }
    }
    events.push(
      assDialogue({
        startMs,
        endMs,
        style: "CalloutShape",
        layer: 3,
        text: `{${pos(center)}\\1c${background}&\\1a&H10&\\bord0}${rectangle}`,
      }),
    );
    events.push(
      assDialogue({
        startMs,
        endMs,
        style: "Callout",
        layer: 4,
        text: `{${pos(center)}\\fs${fit.size}\\1c${ink}&\\bord0}${fit.lines.join("\\N")}`,
      }),
    );
  }
  return events;
}

// The leader begins at the label border, so its line never crosses the lettering.
function leaderVector(box: Box, target: MotionPoint, thickness: number): string | null {
  const dx = target.x - box.center.x;
  const dy = target.y - box.center.y;
  if (Math.abs(dx) <= box.w / 2 && Math.abs(dy) <= box.h / 2) return null;
  const factor = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy),
  );
  const from = { x: box.center.x + dx * factor, y: box.center.y + dy * factor };
  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  const nx = ((-(target.y - from.y) / distance) * thickness) / 2;
  const ny = (((target.x - from.x) / distance) * thickness) / 2;
  return polygon([
    { x: from.x + nx, y: from.y + ny },
    { x: target.x + nx, y: target.y + ny },
    { x: target.x - nx, y: target.y - ny },
    { x: from.x - nx, y: from.y - ny },
  ]);
}
