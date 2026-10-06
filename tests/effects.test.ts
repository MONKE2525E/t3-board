import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_KEYS,
  DEFAULT_BODY_EFFECT,
  effectColor,
  validateBodyEffect,
  type BodyEffect,
} from "../src/effects.ts";
import { Board, TOP_ROW } from "../src/model.ts";
const gradient: BodyEffect = {
  mode: "gradient",
  colorA: "#ff0000",
  colorB: "#0000ff",
  direction: "horizontal",
  speed: 1,
};

test("two-color gradients span physical key centers in all three directions", () => {
  assert.equal(BODY_KEYS.length, 67);
  assert.ok(BODY_KEYS.every((k) => !TOP_ROW.some((top) => top.led === k.led)));
  const left = BODY_KEYS.find((k) => k.x === 0)!;
  const right = BODY_KEYS.find((k) => k.x === 1)!;
  assert.deepEqual(effectColor(gradient, left, 0), [255, 0, 0]);
  assert.deepEqual(effectColor(gradient, right, 0), [0, 0, 255]);
  assert.deepEqual(effectColor(gradient, { x: 0.5, y: 0 }, 0), [255, 0, 255]);
  assert.deepEqual(
    effectColor({ ...gradient, direction: "vertical" }, { x: 0, y: 1 }, 0),
    [0, 0, 255],
  );
  assert.deepEqual(
    effectColor({ ...gradient, direction: "diagonal" }, { x: 1, y: 0 }, 0),
    [255, 0, 255],
  );
});
test("wave and breathing animate smoothly, honor speed, brightness and the eight-second cycle", () => {
  const wave = { ...gradient, mode: "wave" } as BodyEffect;
  assert.deepEqual(effectColor(wave, { x: 0, y: 0 }, 0), [255, 0, 0]);
  assert.deepEqual(effectColor(wave, { x: 0, y: 0 }, 4000), [0, 0, 255]);
  assert.deepEqual(effectColor(wave, { x: 0, y: 0 }, 8000), [255, 0, 0]);
  assert.deepEqual(
    effectColor({ ...wave, speed: 2 }, { x: 0, y: 0 }, 2000),
    [0, 0, 255],
  );
  assert.deepEqual(effectColor(wave, { x: 0, y: 0 }, 2000, 0), [0, 0, 0]);
  const breathe = { ...gradient, mode: "breathe" } as BodyEffect;
  assert.ok(
    effectColor(breathe, { x: 0, y: 0 }, 0)[0] <
      effectColor(breathe, { x: 0, y: 0 }, 4000)[0],
  );
  for (const effect of [wave, breathe]) {
    let previous = effectColor(effect, { x: 0.3, y: 0.6 }, 0);
    for (let t = 10; t <= 8000; t += 10) {
      const next = effectColor(effect, { x: 0.3, y: 0.6 }, t);
      assert.ok(next.every((v, i) => Math.abs(v - previous[i]!) <= 8));
      previous = next;
    }
  }
});
test("body effects cannot overwrite assigned or unassigned status LEDs", () => {
  const board = new Board();
  board.reconcile([
    {
      id: "a",
      title: "a",
      project: "Test",
      status: "error",
      updatedAt: "2026-10-05",
    },
  ]);
  const now = Date.now() + 1600;
  const baseline = board.frame(now, 0.8);
  assert.deepEqual(
    Array.from(baseline.subarray(19 * 4 + 1, 19 * 4 + 4)),
    [204, 204, 204],
  );
  for (const mode of ["solid", "gradient", "wave", "breathe"] as const) {
    const frame = board.frame(now, 0.8, { ...gradient, mode });
    for (const key of TOP_ROW)
      assert.deepEqual(
        frame.subarray(key.led * 4, key.led * 4 + 4),
        baseline.subarray(key.led * 4, key.led * 4 + 4),
      );
    assert.notDeepEqual(
      frame.subarray(19 * 4 + 1, 19 * 4 + 4),
      baseline.subarray(19 * 4 + 1, 19 * 4 + 4),
    );
  }
});
test("body colors have distinct endpoint regions, bright blends and a visible wave gap", () => {
  assert.deepEqual(effectColor(gradient, { x: 0.2, y: 0 }, 0), [255, 0, 0]);
  assert.deepEqual(effectColor(gradient, { x: 0.8, y: 0 }, 0), [0, 0, 255]);
  const dim = { ...gradient, colorA: "#400000", colorB: "#000040" };
  assert.deepEqual(effectColor(dim, { x: 0.5, y: 0 }, 0), [64, 0, 64]);
  assert.deepEqual(
    effectColor({ ...gradient, colorA: "#000000" }, { x: 0, y: 0 }, 0),
    [0, 0, 0],
  );
  // Closely related blue colors still have a clear separation on LEDs.
  const blueWave: BodyEffect = {
    ...gradient,
    mode: "wave",
    colorA: "#00c2ff",
    colorB: "#0d00ff",
  };
  const band = Math.max(...effectColor(blueWave, { x: 0, y: 0 }, 0));
  const gap = Math.max(...effectColor(blueWave, { x: 0.25, y: 0 }, 0));
  assert.ok(band / gap >= 18, `${band}:${gap} band-to-gap contrast`);
  const breathe: BodyEffect = { ...gradient, mode: "breathe" };
  const trough = Math.max(...effectColor(breathe, { x: 0, y: 0 }, 0));
  const peak = Math.max(...effectColor(breathe, { x: 0, y: 0 }, 4000));
  assert.ok(peak / trough >= 35);
});
test("the device and preview use the same clock for moving body colors", () => {
  const board = new Board();
  const wave: BodyEffect = { ...gradient, mode: "wave", speed: 3 };
  const now = 1791244442523;
  const frame = board.frame(now, 0.7, wave);
  for (const key of BODY_KEYS)
    assert.deepEqual(
      Array.from(frame.subarray(key.led * 4 + 1, key.led * 4 + 4)),
      effectColor(wave, key, now, 0.7),
    );
});
test("invalid effects cannot enter saved settings or frame generation", () => {
  assert.deepEqual(
    validateBodyEffect(DEFAULT_BODY_EFFECT),
    DEFAULT_BODY_EFFECT,
  );
  assert.equal(
    validateBodyEffect({ ...gradient, colorA: "#ABCDEF" }).colorA,
    "#abcdef",
  );
  for (const value of [
    null,
    {},
    { ...gradient, mode: "random" },
    { ...gradient, direction: "reverse" },
    { ...gradient, colorB: "blue" },
    { ...gradient, speed: 0 },
    { ...gradient, speed: NaN },
    { ...gradient, speed: Infinity },
  ])
    assert.throws(() => validateBodyEffect(value));
});
