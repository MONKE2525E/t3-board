import type { RGB, Status } from "../src/model.ts";

// Client-side lighting animation. The keyboard runs these patterns at 10 Hz
// (see colorFor in src/model.ts). The preview draws the same patterns every
// frame so they read as continuous motion rather than 250 ms polling steps.

export type LightStatus = Status | "unassigned";
export interface Tone {
  rgb: RGB;
  /** 0 to 1 share of the status color, before brightness. */
  level: number;
}

const YELLOW: RGB = [255, 190, 0];
const BASE: Record<LightStatus, RGB> = {
  working: YELLOW,
  drafting: YELLOW,
  waiting: [25, 65, 255],
  done: [0, 255, 0],
  error: [255, 35, 35],
  merged: [175, 70, 255],
  idle: [255, 255, 255],
  unassigned: [0, 0, 0],
};
export const BREATH_MS = 3200;
export const DRAFT_MS = 320;
export const DONE_MS = 1100;
/** Time to blend from one status color to the next. */
export const CROSSFADE_MS = 240;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
// Square wave with short ramps, so a blink fades instead of snapping.
const softBlink = (elapsedMs: number, period: number, edge: number) =>
  clamp01(0.5 + Math.sin((elapsedMs * Math.PI * 2) / period) * edge);

/** True when the status changes over time. */
export const isAnimated = (status: LightStatus) =>
  status === "working" || status === "drafting" || status === "done";

export function tone(
  status: LightStatus,
  elapsedMs: number,
  reducedMotion = false,
): Tone {
  const rgb = BASE[status];
  switch (status) {
    case "working":
      return {
        rgb,
        level: reducedMotion
          ? 0.85
          : 0.12 +
            (0.88 * (1 - Math.cos((elapsedMs * Math.PI * 2) / BREATH_MS))) / 2,
      };
    case "drafting":
      return {
        rgb,
        level: reducedMotion ? 1 : softBlink(elapsedMs, DRAFT_MS, 0.8),
      };
    case "done":
      return {
        rgb,
        level: reducedMotion ? 1 : softBlink(elapsedMs, DONE_MS, 0.7),
      };
    case "idle":
      return { rgb, level: 0.18 };
    case "unassigned":
      return { rgb, level: 0 };
    default:
      return { rgb, level: 1 };
  }
}

/**
 * Hardware brightness scales linear light. Screens encode light with a gamma,
 * so scale in linear space and re-encode. 100% stays full, 0% stays dark.
 */
export const displayGain = (linear: number) => clamp01(linear) ** (1 / 2.2);

/** Display color for a tone at the given brightness (0 to 1). */
export function paint(t: Tone, brightness: number): RGB {
  const gain = displayGain(t.level * clamp01(brightness));
  return [
    Math.round(t.rgb[0] * gain),
    Math.round(t.rgb[1] * gain),
    Math.round(t.rgb[2] * gain),
  ];
}

/** Blend two painted colors; `progress` runs from 0 (from) to 1 (to). */
export function blend(from: RGB, to: RGB, progress: number): RGB {
  const p = clamp01(progress);
  const eased = p * p * (3 - 2 * p);
  return [
    Math.round(from[0] + (to[0] - from[0]) * eased),
    Math.round(from[1] + (to[1] - from[1]) * eased),
    Math.round(from[2] + (to[2] - from[2]) * eased),
  ];
}

/**
 * Per-key animation state. It keeps the last painted color so a status change
 * fades from what was on screen instead of jumping.
 */
export class KeyLight {
  status: LightStatus = "unassigned";
  color: RGB = [0, 0, 0];
  private from: RGB = [0, 0, 0];
  private changedAt = Number.NEGATIVE_INFINITY;

  setStatus(status: LightStatus, now: number, instant = false) {
    if (status === this.status) return;
    this.from = this.color;
    this.status = status;
    this.changedAt = instant ? Number.NEGATIVE_INFINITY : now;
  }

  /** True while a crossfade is still running at `now`. */
  fading(now: number) {
    return now - this.changedAt < CROSSFADE_MS;
  }

  update(now: number, brightness: number, reducedMotion: boolean): RGB {
    const target = paint(tone(this.status, now, reducedMotion), brightness);
    this.color = this.fading(now)
      ? blend(this.from, target, (now - this.changedAt) / CROSSFADE_MS)
      : target;
    return this.color;
  }
}
