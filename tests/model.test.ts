import { test } from "node:test";
import assert from "node:assert/strict";
import { Board, colorFor, LAYOUT, type Agent } from "../src/model.ts";
import { frameReports } from "../src/keyboard.ts";
const agent = (
  id: string,
  status: Agent["status"] = "working",
  runId = "run1",
): Agent => ({
  id,
  title: id,
  project: "Test",
  status,
  runId,
  updatedAt: "2026-10-05T00:00:00Z",
});
test("assignments stay on their keys across status updates and reordered input", () => {
  const b = new Board();
  b.reconcile([agent("a"), agent("b")]);
  b.reconcile([agent("b", "done"), agent("a", "error")]);
  assert.equal(b.slots()[0]!.agent!.id, "a");
  assert.equal(b.slots()[0]!.status, "error");
  assert.equal(b.slots()[1]!.status, "done");
  b.reconcile([agent("b", "done"), agent("c")]);
  assert.equal(b.slots()[0]!.agent!.id, "c");
  assert.equal(b.slots()[1]!.agent!.id, "b");
});
test("14-slot limit, release suppression, and new run reassignment", () => {
  const b = new Board();
  const agents = Array.from({ length: 15 }, (_, i) => agent(String(i)));
  b.reconcile(agents);
  assert.equal(b.slots().filter((s) => s.agent).length, 14);
  assert.equal(b.overflow, 1);
  b.release(0);
  b.reconcile(agents);
  assert.equal(b.slots()[0]!.agent!.id, "14");
  assert.equal(b.overflow, 0);
  b.release(1);
  b.reconcile([agent("0", "working", "run2"), ...agents.slice(2)]);
  assert.equal(b.slots()[1]!.agent!.id, "0");
  assert.equal(b.slots()[1]!.status, "drafting");
});
test("draft key is stable while typing and expires when the bridge stops", () => {
  const b = new Board();
  b.reconcile([agent("a")], 1000);
  b.reserve("draft:new", "New agent", 1000);
  b.reconcile([agent("a")], 2000);
  assert.equal(b.slots(2000)[1]!.status, "drafting");
  b.reserve("draft:new", "New agent", 3000);
  b.reconcile([agent("a")], 6000);
  assert.equal(b.slots(6000)[1]!.agent!.id, "draft:new");
  b.reconcile([agent("a")], 7100);
  assert.equal(b.slots(7100)[1]!.agent, null);
});
test("new messages pulse yellow then resume their lifecycle status", () => {
  const b = new Board();
  b.reconcile([agent("a")], 1000);
  b.reconcile([agent("a", "working", "run2")], 2000);
  assert.equal(b.slots(2001)[0]!.status, "drafting");
  assert.equal(b.slots(3501)[0]!.status, "working");
});
test("color timing matches requested animations and clamps brightness", () => {
  assert.deepEqual(colorFor("error", 0, 1), [255, 35, 35]);
  assert.deepEqual(colorFor("merged", 0, 1), [175, 70, 255]);
  assert.deepEqual(colorFor("waiting", 0, 1), [25, 65, 255]);
  assert.deepEqual(colorFor("waiting", 1600, 1), [25, 65, 255]);
  assert.deepEqual(colorFor("unassigned", 0), [0, 0, 0]);
  assert.deepEqual(colorFor("drafting", 161, 1), [0, 0, 0]);
  assert.deepEqual(colorFor("done", 0, 1), [0, 255, 0]);
  assert.deepEqual(colorFor("done", 0, 0.5), [0, 128, 0]);
  assert.deepEqual(colorFor("done", 551, 1), [0, 0, 0]);
  assert.ok(colorFor("working", 1600, 1)[0] > colorFor("working", 0, 1)[0]);
  assert.deepEqual(colorFor("error", 0, 0), [0, 0, 0]);
});
test("frame addresses F1 separately with unused top row off and body white", () => {
  const b = new Board();
  b.reconcile([agent("esc", "idle"), agent("f1", "error")]);
  const frame = b.frame(Date.now() + 2000, 1);
  assert.equal(frame.length, 512);
  assert.deepEqual(Array.from(frame.subarray(9, 12)), [255, 35, 35]);
  assert.deepEqual(Array.from(frame.subarray(13, 16)), [0, 0, 0]);
  assert.deepEqual(
    Array.from(frame.subarray(19 * 4 + 1, 19 * 4 + 4)),
    [255, 255, 255],
  );
  assert.equal(
    new Set(LAYOUT.flat().map((k) => k.led)).size,
    LAYOUT.flat().length,
  );
  const reports = frameReports(frame);
  assert.equal(reports.length, 10);
  assert.equal(reports[0]![2], 0x20);
  assert.equal(reports.at(-1)![2], 2);
  assert.deepEqual(
    Buffer.concat(reports.slice(1, 9).map((p) => p.subarray(1))),
    frame,
  );
});

test("settlement immediately clears an existing agent and its draft reservation", () => {
  const board = new Board();
  board.reconcile([agent("settling")], 1000);
  board.reserve("settling", "Draft", 1100);
  board.reconcile([], 1200, new Set(["settling"]));
  assert.equal(board.draft, null);
  assert.equal(board.slots(1200)[0]!.agent, null);
  assert.deepEqual(board.slots(1200)[0]!.color, [0, 0, 0]);
});
