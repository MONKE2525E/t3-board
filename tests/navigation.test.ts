import { test } from "node:test";
import assert from "node:assert/strict";
import { Board } from "../src/model.ts";
import { assignedThread } from "../src/navigation.ts";

test("shortcuts follow current light assignments, release and settlement", () => {
  const board = new Board();
  const agents = ["first", "second"].map((id) => ({
    id,
    title: id,
    project: "test",
    status: "working" as const,
    updatedAt: "now",
  }));
  board.reconcile(agents);
  assert.equal(assignedThread(board.slots(), "Escape"), "first");
  assert.equal(assignedThread(board.slots(), "F1"), "second");
  board.reconcile([...agents].reverse());
  assert.equal(assignedThread(board.slots(), "F1"), "second");
  board.reconcile(agents, Date.now(), new Set(["second"]));
  assert.equal(assignedThread(board.slots(), "F1"), null);
  board.release(0);
  assert.equal(assignedThread(board.slots(), "Esc"), null);
  assert.equal(assignedThread(board.slots(), "Delete"), null);
});

test("draft placeholders, provider-native children, and invalid keys cannot navigate", () => {
  const board = new Board();
  board.reserve("draft:example");
  assert.equal(assignedThread(board.slots(), "Esc"), null);
  assert.throws(() => assignedThread(board.slots(), "F13"), /Invalid/);
  assert.throws(() => assignedThread(board.slots(), "../F1"), /Invalid/);
});
