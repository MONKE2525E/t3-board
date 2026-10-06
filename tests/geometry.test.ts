import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT, TOP_ROW } from "../src/model.ts";
import {
  CASE,
  DISPLAY,
  KEYS,
  KNOB,
  STATUS_KEYS,
  keyTitle,
} from "../web/geometry.ts";

const find = (name: string, led?: number) =>
  KEYS.find((k) => k.name === name && (led === undefined || k.led === led))!;
const pairs = (
  list: readonly { name?: string; label?: string; led: number }[],
) => list.map((k) => `${k.name ?? k.label}:${k.led}`).sort();

test("the preview draws the 81 keys of the ANSI AK820 Pro", () => {
  assert.equal(KEYS.length, 81);
  assert.equal(
    KEYS.some((k) => k.name === "End"),
    false,
  );
});

test("every drawn key keeps its LED address from the hardware layout", () => {
  const hardware = LAYOUT.flat().filter((k) => k.label !== "End");
  assert.deepEqual(pairs(KEYS), pairs(hardware));
  // The hardware frame still lights LED 122 white. It has no cap on this board.
  assert.ok(LAYOUT.flat().some((k) => k.label === "End" && k.led === 122));
});

test("agent slots are Esc, F1 to F12 and Delete in slot order", () => {
  assert.equal(STATUS_KEYS.length, 14);
  assert.deepEqual(
    STATUS_KEYS.map((k) => [k.name, k.led]),
    TOP_ROW.map((k) => [k.label, k.led]),
  );
  assert.deepEqual(
    STATUS_KEYS.map((k) => k.slot),
    Array.from({ length: 14 }, (_, i) => i),
  );
  assert.equal(keyTitle("Del"), "Delete");
});

test("function row is grouped Esc / F1-F4 / F5-F8 / F9-F12 / Delete", () => {
  const x = (name: string) => find(name).x - find("Esc").x;
  assert.equal(x("F1"), 1.25);
  assert.equal(x("F5"), 5.5);
  assert.equal(x("F9"), 9.75);
  assert.equal(x("Del"), 14);
  // Delete's right edge lines up with Backspace.
  const back = find("Back");
  assert.equal(find("Del").x + find("Del").w, back.x + back.w);
});

test("modifier widths match the physical keycaps", () => {
  assert.equal(find("Back").w, 2);
  assert.equal(find("Tab").w, 1.5);
  assert.equal(find("\\").w, 1.5);
  assert.equal(find("Caps").w, 1.75);
  assert.equal(find("Enter").w, 2.25);
  assert.equal(find("Shift", 73).w, 2.25);
  assert.equal(find("Shift", 84).w, 1.75);
  assert.equal(find("Space").w, 6.25);
  assert.equal(find("Ctrl", 91).w, 1.25);
  assert.equal(find("Alt", 93).w, 1.25);
  assert.equal(find("Alt", 95).w, 1);
});

test("rows end on the main block's right edge and spacing has no overlaps", () => {
  const edge = (name: string, led?: number) => {
    const key = find(name, led);
    return key.x + key.w;
  };
  const right = edge("Back");
  for (const [name, led] of [["\\"], ["Enter"], ["Del"]] as [string, number?][])
    assert.ok(Math.abs(edge(name, led) - right) < 1e-9, name);
  assert.ok(Math.abs(edge("Shift", 84) - (find("Shift", 84).x + 1.75)) < 1e-9);
  assert.ok(Math.abs(edge("Ctrl", 98) - find("Space").x - 6.25 - 3) < 1e-9);
  for (const a of KEYS)
    for (const b of KEYS) {
      if (a === b) continue;
      const overlap =
        a.x < b.x + b.w - 1e-9 &&
        b.x < a.x + a.w - 1e-9 &&
        a.y < b.y + b.h - 1e-9 &&
        b.y < a.y + a.h - 1e-9;
      assert.equal(overlap, false, `${a.name} overlaps ${b.name}`);
    }
});

test("Home, PgUp and PgDn form a separate column right of the main block", () => {
  const column = ["Home", "PgUp", "PgDn"].map((n) => find(n));
  assert.equal(new Set(column.map((k) => k.x)).size, 1);
  assert.ok(column[0]!.x - (find("Back").x + find("Back").w) > 0.4);
  assert.deepEqual(
    column.map((k) => k.y - column[0]!.y),
    [0, 1, 2],
  );
});

test("arrows form an inverted T offset below their rows, display beside the up arrow", () => {
  const up = find("↑"),
    left = find("←"),
    down = find("↓"),
    right = find("→");
  assert.equal(down.x, up.x);
  assert.equal(down.y - up.y, 1);
  assert.equal(left.y, down.y);
  assert.equal(right.y, down.y);
  assert.equal(down.x - left.x, 1);
  assert.equal(right.x - down.x, 1);
  const shift = find("Shift", 84);
  const ctrl = find("Ctrl", 98);
  assert.equal(up.y - shift.y, 0.25);
  assert.equal(left.y - ctrl.y, 0.25);
  // The display sits under PgDn and starts right after the up arrow.
  assert.ok(DISPLAY.x > up.x + up.w);
  assert.ok(DISPLAY.y >= find("PgDn").y + 1);
  assert.ok(DISPLAY.y + DISPLAY.h <= left.y);
});

test("everything fits inside the case, with the knob past Delete", () => {
  for (const k of KEYS) {
    assert.ok(k.x >= 0 && k.x + k.w <= CASE.w, k.name);
    assert.ok(k.y >= 0 && k.y + k.h <= CASE.h, k.name);
  }
  assert.ok(KNOB.x - KNOB.r > find("Del").x + 1);
  assert.ok(KNOB.x + KNOB.r <= CASE.w);
  assert.ok(KNOB.y - KNOB.r >= 0);
});
