import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor } from "../src/model.ts";
import {
  BREATH_MS,
  CROSSFADE_MS,
  DONE_MS,
  DRAFT_MS,
  KeyLight,
  displayGain,
  isAnimated,
  paint,
  tone,
} from "../web/animation.ts";

const level = (status: Parameters<typeof tone>[0], ms: number) =>
  tone(status, ms).level;

test("working breathes smoothly with the hardware's 3.2 second period", () => {
  assert.equal(BREATH_MS, 3200);
  assert.ok(Math.abs(level("working", 0) - 0.12) < 1e-9);
  assert.ok(Math.abs(level("working", BREATH_MS / 2) - 1) < 1e-9);
  assert.ok(
    Math.abs(level("working", 700) - level("working", 700 + BREATH_MS)) < 1e-9,
  );
  let previous = level("working", 0);
  for (let ms = 5; ms <= BREATH_MS; ms += 5) {
    const next = level("working", ms);
    assert.ok(Math.abs(next - previous) < 0.02, `jump at ${ms}ms`);
    previous = next;
  }
});

test("the preview agrees with the colors the keyboard receives", () => {
  const scaled = (status: Parameters<typeof tone>[0], ms: number) => {
    const t = tone(status, ms);
    return t.rgb.map((v) => v * t.level);
  };
  // Steady statuses and the breath match colorFor exactly.
  for (const [status, ms] of [
    ["error", 0],
    ["merged", 0],
    ["waiting", 0],
    ["idle", 0],
    ["working", 0],
    ["working", BREATH_MS / 2],
  ] as const)
    assert.deepEqual(
      scaled(status, ms).map(Math.round),
      [...colorFor(status, ms, 1)],
      `${status} at ${ms}ms`,
    );
  // Blinks agree away from their edges: on in the first half, off in the second.
  for (const [status, period] of [
    ["done", DONE_MS],
    ["drafting", DRAFT_MS],
  ] as const) {
    const on = colorFor(status, period / 4, 1);
    const off = colorFor(status, (period * 3) / 4, 1);
    scaled(status, period / 4).forEach((v, i) =>
      assert.ok(Math.abs(v - on[i]!) <= 0.06 * 255, `${status} on`),
    );
    scaled(status, (period * 3) / 4).forEach((v, i) =>
      assert.ok(Math.abs(v - off[i]!) <= 0.06 * 255, `${status} off`),
    );
  }
});

test("drafting pulses fast and finished blinks green", () => {
  assert.ok(level("drafting", DRAFT_MS / 4) > 0.95);
  assert.ok(level("drafting", (DRAFT_MS * 3) / 4) < 0.05);
  assert.ok(level("done", DONE_MS / 4) > 0.95);
  assert.ok(level("done", (DONE_MS * 3) / 4) < 0.05);
  assert.deepEqual(tone("done", 0).rgb, [0, 255, 0]);
  assert.deepEqual(tone("drafting", 0).rgb, [255, 190, 0]);
  // A blink fades through intermediate levels instead of snapping.
  const seen = new Set<number>();
  for (let ms = 0; ms < DRAFT_MS; ms += 4)
    seen.add(Math.round(level("drafting", ms) * 20));
  assert.ok(seen.size > 3);
});

test("error, merged and needs-input stay steady; idle is dim; unassigned is off", () => {
  for (const status of ["error", "merged", "waiting", "idle"] as const)
    assert.equal(level(status, 0), level(status, 777));
  assert.equal(level("error", 0), 1);
  assert.equal(level("merged", 0), 1);
  assert.equal(level("waiting", 0), 1);
  assert.equal(level("idle", 0), 0.18);
  assert.equal(level("unassigned", 500), 0);
  assert.deepEqual(tone("error", 0).rgb, [255, 35, 35]);
  assert.deepEqual(tone("merged", 0).rgb, [175, 70, 255]);
  assert.deepEqual(tone("waiting", 0).rgb, [25, 65, 255]);
  assert.equal(
    isAnimated("working") && isAnimated("drafting") && isAnimated("done"),
    true,
  );
  assert.equal(
    ["error", "merged", "waiting", "idle", "unassigned"].some((s) =>
      isAnimated(s as "idle"),
    ),
    false,
  );
});

test("reduced motion holds steady colors that still tell statuses apart", () => {
  for (const status of ["working", "drafting", "done"] as const) {
    assert.equal(tone(status, 0, true).level, tone(status, 1234, true).level);
    assert.ok(tone(status, 0, true).level > 0.5);
  }
  assert.notDeepEqual(
    tone("working", 0, true).rgb,
    tone("waiting", 0, true).rgb,
  );
});

test("brightness scales the preview and keeps 0 dark and 100 full", () => {
  const full = tone("error", 0);
  assert.deepEqual(paint(full, 1), [255, 35, 35]);
  assert.deepEqual(paint(full, 0), [0, 0, 0]);
  let previous = -1;
  for (let b = 0; b <= 1; b += 0.05) {
    const red = paint(full, b)[0];
    assert.ok(red >= previous);
    previous = red;
  }
  // Linear hardware light is gamma encoded for the screen.
  assert.ok(displayGain(0.5) > 0.5 && displayGain(0.5) < 1);
  assert.equal(displayGain(1), 1);
  assert.equal(displayGain(0), 0);
  assert.equal(displayGain(2), 1);
});

test("a status change fades from the painted color instead of jumping", () => {
  const light = new KeyLight();
  light.setStatus("error", 0, true);
  assert.deepEqual(light.update(0, 1, false), [255, 35, 35]);
  light.setStatus("merged", 1000);
  assert.equal(light.fading(1000), true);
  assert.deepEqual(light.update(1000, 1, false), [255, 35, 35]);
  const mid = light.update(1000 + CROSSFADE_MS / 2, 1, false);
  assert.ok(mid[0] < 255 && mid[0] > 175);
  assert.ok(mid[2] > 35 && mid[2] < 255);
  assert.deepEqual(light.update(1000 + CROSSFADE_MS, 1, false), [175, 70, 255]);
  assert.equal(light.fading(1000 + CROSSFADE_MS), false);
  // Repeating the same status does not restart the fade.
  light.setStatus("merged", 5000);
  assert.equal(light.fading(5000), false);
});

test("instant changes (reduced motion) skip the crossfade", () => {
  const light = new KeyLight();
  light.setStatus("error", 0, true);
  light.update(0, 1, true);
  light.setStatus("done", 10, true);
  assert.equal(light.fading(10), false);
  assert.deepEqual(light.update(10, 1, true), [0, 255, 0]);
});
