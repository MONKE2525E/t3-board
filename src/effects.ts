import type { RGB } from "./model.ts";
import { KEYS } from "../web/geometry.ts";

const bodyGeometry = KEYS.filter((key) => key.slot === null);
const minX = Math.min(...bodyGeometry.map((key) => key.x + key.w / 2));
const maxX = Math.max(...bodyGeometry.map((key) => key.x + key.w / 2));
const minY = Math.min(...bodyGeometry.map((key) => key.y + key.h / 2));
const maxY = Math.max(...bodyGeometry.map((key) => key.y + key.h / 2));
export const BODY_KEYS = bodyGeometry.map((key) => ({
  led: key.led,
  x: (key.x + key.w / 2 - minX) / (maxX - minX),
  y: (key.y + key.h / 2 - minY) / (maxY - minY),
}));

export const BODY_MODES = [
  "solid",
  "gradient",
  "wave",
  "breathe",
  "rainbow",
  "spectrum",
  "chase",
] as const;
export type BodyMode = (typeof BODY_MODES)[number];
export type GradientDirection = "horizontal" | "vertical" | "diagonal";
export interface BodyEffect {
  mode: BodyMode;
  colorA: string;
  colorB: string;
  direction: GradientDirection;
  /** Animation rate multiplier. One cycle is eight seconds at 1x. */
  speed: number;
}
export const DEFAULT_BODY_EFFECT: Readonly<BodyEffect> = {
  mode: "solid",
  colorA: "#ffffff",
  colorB: "#8b5cf6",
  direction: "horizontal",
  speed: 1,
};
export function validateBodyEffect(value: unknown): BodyEffect {
  if (!value || typeof value !== "object")
    throw new Error("Invalid body effect.");
  const v = value as Record<string, unknown>;
  if (
    !BODY_MODES.some((mode) => mode === v.mode) ||
    !["horizontal", "vertical", "diagonal"].includes(String(v.direction)) ||
    typeof v.colorA !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(v.colorA) ||
    typeof v.colorB !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(v.colorB) ||
    typeof v.speed !== "number" ||
    !Number.isFinite(v.speed) ||
    v.speed < 0.25 ||
    v.speed > 3
  )
    throw new Error(
      "Choose a supported effect, two hex colors, a direction, and speed from 0.25 to 3.",
    );
  return {
    mode: v.mode as BodyMode,
    colorA: v.colorA.toLowerCase(),
    colorB: v.colorB.toLowerCase(),
    direction: v.direction as GradientDirection,
    speed: v.speed,
  };
}
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const rgb = (hex: string): RGB =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as RGB;
// Hold each chosen color across a quarter of the gradient. Blend smoothly
// through the middle instead of mixing both colors across the whole board.
const colorMix = (position: number) => {
  const t = clamp((position - 0.25) / 0.5);
  return t * t * (3 - 2 * t);
};
export const effectAnimated = (effect: BodyEffect) =>
  effect.mode !== "solid" && effect.mode !== "gradient";
export const effectSpectrum = (effect: BodyEffect) =>
  effect.mode === "rainbow" || effect.mode === "spectrum";

/** Fully saturated RGB hue, wrapped so the cycle has no seam. */
const spectrumColor = (turns: number): RGB => {
  const hue = (((turns % 1) + 1) % 1) * 6;
  const secondary = 1 - Math.abs((hue % 2) - 1);
  const colors = [
    [1, secondary, 0],
    [secondary, 1, 0],
    [0, 1, secondary],
    [0, secondary, 1],
    [secondary, 0, 1],
    [1, 0, secondary],
  ];
  return colors[Math.floor(hue)]!.map((v) => v * 255) as unknown as RGB;
};
/** Position is the physical key center normalized across the keyboard, from 0 to 1. */
export function effectColor(
  effect: BodyEffect,
  position: { x: number; y: number },
  elapsedMs: number,
  brightness = 1,
): RGB {
  const point =
    effect.direction === "vertical"
      ? clamp(position.y)
      : effect.direction === "diagonal"
        ? clamp((position.x + position.y) / 2)
        : clamp(position.x);
  const phase = (elapsedMs * effect.speed * Math.PI * 2) / 8000;
  if (effectSpectrum(effect)) {
    const hue = (effect.mode === "rainbow" ? point : 0) - phase / (Math.PI * 2);
    return spectrumColor(hue).map((v) =>
      Math.round(v * clamp(brightness)),
    ) as unknown as RGB;
  }
  const positionMix =
    effect.mode === "solid"
      ? 0
      : effect.mode === "wave"
        ? (1 - Math.cos(point * Math.PI * 2 - phase)) / 2
        : point;
  const mix = colorMix(positionMix);
  const level =
    effect.mode === "breathe"
      ? 0.025 + (0.975 * (1 - Math.cos(phase))) / 2
      : effect.mode === "wave"
        ? 1 - 0.95 * Math.sin(positionMix * Math.PI) ** 8
        : effect.mode === "chase"
          ? 0.025 +
            0.975 * ((1 + Math.cos(point * Math.PI * 2 - phase)) / 2) ** 12
          : 1;
  const a = rgb(effect.colorA),
    b = rgb(effect.colorB);
  const mixed = a.map((v, i) => v + (b[i]! - v) * mix);
  // Mixing red and blue should give bright magenta, not a half-bright muddy
  // midpoint. Preserve the endpoint intensity, including deliberately dim colors.
  const peak = Math.max(...mixed);
  const targetPeak = Math.max(...a) * (1 - mix) + Math.max(...b) * mix;
  const gain = peak > 0 ? targetPeak / peak : 0;
  return mixed.map((v) =>
    Math.round(v * gain * level * clamp(brightness)),
  ) as unknown as RGB;
}
