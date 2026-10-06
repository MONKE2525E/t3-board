import type { RGB } from "../src/model.ts";
import {
  BODY_KEYS,
  effectColor,
  type BodyEffect,
  type BodyMode,
  type GradientDirection,
} from "../src/effects.ts";
import { paint } from "./animation.ts";

// Pure helpers for the body lighting panel: option lists, the preview colors
// and the save queue. The DOM wiring lives in body-panel.ts.

export const MODES: { id: BodyMode; label: string; note: string }[] = [
  { id: "solid", label: "Solid", note: "One color on every key." },
  {
    id: "gradient",
    label: "Gradient",
    note: "Bold colors with a smooth transition.",
  },
  {
    id: "wave",
    label: "Wave",
    note: "Color bands move across the board with a dark gap between them.",
  },
  { id: "breathe", label: "Breathe", note: "The gradient fades in and out." },
];

export const DIRECTIONS: {
  id: GradientDirection;
  label: string;
  /** Rotation of the arrow icon, in degrees. */
  angle: number;
}[] = [
  { id: "horizontal", label: "Left to right", angle: 0 },
  { id: "vertical", label: "Top to bottom", angle: 90 },
  { id: "diagonal", label: "Diagonal", angle: 45 },
];

// Saturated pairs read best on RGB switches. Pastels wash out to white.
export const PRESETS: { name: string; a: string; b: string }[] = [
  { name: "Sunset", a: "#ff6b35", b: "#d62976" },
  { name: "Ocean", a: "#00c2ff", b: "#4f46e5" },
  { name: "Aurora", a: "#2dd4a0", b: "#7c3aed" },
  { name: "Ember", a: "#ff3d00", b: "#ffb300" },
  { name: "Neon", a: "#ff3df0", b: "#22e6ff" },
];

export const SPEED = { min: 0.25, max: 3, step: 0.05 } as const;

export const sameEffect = (a: BodyEffect, b: BodyEffect) =>
  a.mode === b.mode &&
  a.colorA === b.colorA &&
  a.colorB === b.colorB &&
  a.direction === b.direction &&
  a.speed === b.speed;

/** Accepts #rgb or #rrggbb with an optional leading #. Returns #rrggbb. */
export function normalizeHex(text: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const digits = match[1]!.toLowerCase();
  return `#${
    digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits
  }`;
}

export const clampSpeed = (speed: number) =>
  Math.min(SPEED.max, Math.max(SPEED.min, speed));

/** "1×" for the speed multiplier and the cycle length it gives. */
export const speedText = (speed: number) =>
  `${Number(speed.toFixed(2))}× · ${(8 / speed).toFixed(1)}s cycle`;

/**
 * Time passed to effectColor. Reduced motion holds a still frame at the
 * midpoint of the cycle, where a breathe is fully lit.
 */
export const previewTime = (
  effect: BodyEffect,
  now: number,
  reduced: boolean,
) => (reduced ? 4000 / effect.speed : now);

/** Display colors for every body key, in BODY_KEYS order. */
export function bodyColors(
  effect: BodyEffect,
  now: number,
  brightness: number,
  reduced: boolean,
): RGB[] {
  const time = previewTime(effect, now, reduced);
  // effectColor returns linear light. paint applies brightness and the display
  // gamma, so pass full brightness to effectColor to scale only once.
  return BODY_KEYS.map((key) =>
    paint({ rgb: effectColor(effect, key, time, 1), level: 1 }, brightness),
  );
}

export function averageColor(colors: readonly RGB[]): RGB {
  const sum = [0, 0, 0];
  for (const color of colors) for (let i = 0; i < 3; i++) sum[i]! += color[i]!;
  const n = Math.max(1, colors.length);
  return sum.map((v) => Math.round(v / n)) as unknown as RGB;
}

export interface SaverOptions<T, R> {
  send(value: T): Promise<R>;
  /** Called after a send succeeds. `newer` is true when a later value waits. */
  onSaved(result: R, sent: T, newer: boolean): void;
  /** Called after a send fails. Pending values are dropped before the call. */
  onError(error: unknown): void;
  /** Wait before sending a value that is still being dragged. */
  throttleMs?: number;
  /** Minimum gap between a finished send and the next. */
  gapMs?: number;
}

/**
 * Latest-value save queue. One request is in flight at a time and every edit
 * during it collapses into a single follow-up request carrying the newest
 * value, so a drag can neither drop its final value nor flood the server.
 */
export class LatestSaver<T, R = unknown> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: T | undefined;
  private dirty = false;
  private saving = false;

  private readonly options: SaverOptions<T, R>;

  constructor(options: SaverOptions<T, R>) {
    this.options = options;
  }

  /** True while a value is waiting to be sent or being sent. */
  get busy() {
    return this.dirty || this.saving || this.timer !== undefined;
  }

  /** Queue a value. `immediate` skips the throttle for discrete changes. */
  push(value: T, immediate = false) {
    this.latest = value;
    this.dirty = true;
    if (immediate) {
      this.clear();
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.options.throttleMs ?? 400);
    }
  }

  /** Send the queued value now, for example before the page is hidden. */
  flushNow() {
    this.clear();
    return this.flush();
  }

  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async flush() {
    if (this.saving || !this.dirty) return;
    this.saving = true;
    this.dirty = false;
    const sent = this.latest as T;
    let result: R;
    try {
      result = await this.options.send(sent);
    } catch (error) {
      this.saving = false;
      this.dirty = false;
      this.clear();
      this.options.onError(error);
      return;
    }
    this.saving = false;
    if (this.dirty && this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.options.gapMs ?? 250);
    this.options.onSaved(result, sent, this.dirty);
  }
}
