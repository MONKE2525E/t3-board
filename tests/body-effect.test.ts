import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_KEYS,
  DEFAULT_BODY_EFFECT,
  effectColor,
  type BodyEffect,
} from "../src/effects.ts";
import {
  LatestSaver,
  averageColor,
  bodyColors,
  clampSpeed,
  normalizeHex,
  previewTime,
  sameEffect,
  speedText,
} from "../web/body-effect.ts";
import { paint } from "../web/animation.ts";

const wave: BodyEffect = {
  ...DEFAULT_BODY_EFFECT,
  mode: "wave",
  colorA: "#ff0000",
  colorB: "#0000ff",
};

test("hex input accepts #rgb and #rrggbb and rejects the rest", () => {
  assert.equal(normalizeHex("#FFaa00"), "#ffaa00");
  assert.equal(normalizeHex("ffaa00"), "#ffaa00");
  assert.equal(normalizeHex(" #f0a "), "#ff00aa");
  for (const bad of ["", "#12", "#12345", "#1234567", "#gg0000", "red"])
    assert.equal(normalizeHex(bad), null, bad);
});

test("speed helpers stay inside the contract", () => {
  assert.equal(clampSpeed(0), 0.25);
  assert.equal(clampSpeed(9), 3);
  assert.equal(clampSpeed(1.5), 1.5);
  assert.equal(speedText(1), "1× · 8.0s cycle");
  assert.equal(speedText(2), "2× · 4.0s cycle");
});

test("effects compare by every field", () => {
  assert.ok(sameEffect(wave, { ...wave }));
  assert.ok(!sameEffect(wave, { ...wave, speed: 1.05 }));
  assert.ok(!sameEffect(wave, { ...wave, direction: "vertical" }));
});

test("the preview paints the colors the keyboard computes", () => {
  const colors = bodyColors(wave, 1234, 1, false);
  assert.equal(colors.length, BODY_KEYS.length);
  colors.forEach((rgb, i) => {
    const linear = effectColor(wave, BODY_KEYS[i]!, 1234, 1);
    // At full brightness, the display gain is 1 and the colors are identical.
    assert.deepEqual(rgb, paint({ rgb: linear, level: 1 }, 1));
    assert.deepEqual(rgb, linear);
  });
});

test("brightness is applied once", () => {
  const solid: BodyEffect = { ...DEFAULT_BODY_EFFECT };
  const [first] = bodyColors(solid, 0, 0.5, false);
  assert.deepEqual(first, paint({ rgb: [255, 255, 255], level: 1 }, 0.5));
  assert.deepEqual(bodyColors(solid, 0, 0, false)[0], [0, 0, 0]);
});

test("reduced motion holds a lit, still frame", () => {
  const breathe: BodyEffect = { ...wave, mode: "breathe", speed: 2 };
  assert.equal(previewTime(breathe, 12345, true), 2000);
  assert.deepEqual(
    bodyColors(breathe, 0, 1, true),
    bodyColors(breathe, 99999, 1, true),
  );
  // The held frame is the brightest point of the breath, not the dim one.
  const lit = Math.max(...bodyColors(breathe, 0, 1, true).flat());
  const dim = Math.max(...bodyColors(breathe, 0, 1, false).flat());
  assert.ok(lit > dim);
  assert.equal(previewTime(breathe, 12345, false), 12345);
});

test("the average color follows the keys", () => {
  assert.deepEqual(
    averageColor([
      [0, 0, 0],
      [100, 200, 50],
    ]),
    [50, 100, 25],
  );
  assert.deepEqual(averageColor([]), [0, 0, 0]);
});

function saver(sendMs = 50) {
  const sent: number[] = [];
  const saved: [number, boolean][] = [];
  const errors: unknown[] = [];
  let fail = false;
  const instance = new LatestSaver<number, string>({
    throttleMs: 400,
    gapMs: 250,
    send: (value) =>
      new Promise((resolve, reject) =>
        setTimeout(() => {
          sent.push(value);
          if (fail) reject(new Error("nope"));
          else resolve(`ok ${value}`);
        }, sendMs),
      ),
    onSaved: (_result, value, newer) => saved.push([value, newer]),
    onError: (error) => errors.push(error),
  });
  return {
    instance,
    sent,
    saved,
    errors,
    failNext: () => (fail = true),
    recover: () => (fail = false),
  };
}

test("a drag collapses into few writes and always sends the last value", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { instance, sent, saved } = saver();
  for (let i = 1; i <= 60; i++) {
    instance.push(i);
    t.mock.timers.tick(33);
  }
  instance.push(61, true);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => resolve());
    t.mock.timers.tick(300);
  }
  assert.equal(sent.at(-1), 61);
  assert.ok(sent.length < 15, `${sent.length} writes for 61 edits`);
  assert.equal(saved.at(-1)?.[1], false);
  assert.ok(!instance.busy);
});

test("an edit during a save is sent next, not dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { instance, sent } = saver(100);
  instance.push(1, true);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(10);
  instance.push(2, true);
  instance.push(3, true);
  assert.ok(instance.busy);
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(100);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.deepEqual(sent, [1, 3]);
});

test("a failed save drops pending edits and reports once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { instance, sent, errors, failNext, recover } = saver(10);
  failNext();
  instance.push(1, true);
  instance.push(2);
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(100);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(errors.length, 1);
  assert.deepEqual(sent, [1]);
  assert.ok(!instance.busy);
  // The queue works again afterwards.
  recover();
  instance.push(3, true);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(100);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.deepEqual(sent, [1, 3]);
});
