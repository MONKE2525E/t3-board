import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  LocalSources,
  SOURCE_STALE_GRACE_MS,
  sourceLocations,
} from "../src/sources.ts";
import { LocalT3Source } from "../src/source.ts";
import { Board } from "../src/model.ts";
import { assignedThread } from "../src/navigation.ts";
import { sourceFixture } from "./support/source-fixture.ts";

test("default discovery reads both installations and explicit database overrides remain exclusive", () => {
  const defaults = sourceLocations({}, "/test-home");
  assert.deepEqual(
    defaults.map((s) => s.path),
    [
      "/test-home/.t3/userdata/statev2.sqlite",
      "/test-home/.t3-grokbot-dev/userdata/statev2.sqlite",
    ],
  );
  assert.equal(
    sourceLocations({ T3_BOARD_DB: "/custom.sqlite" }, "/home").length,
    1,
  );
  assert.equal(
    sourceLocations({ T3_BOARD_A3_DB: "/a3.sqlite" }, "/home")[1]!.path,
    "/a3.sqlite",
  );
  const explicit = sourceLocations({
    T3_BOARD_DBS: ["/first", "/second"].join(delimiter),
    T3_BOARD_DB: "/ignored",
  });
  assert.deepEqual(
    explicit.map(({ path, label, primary }) => ({ path, label, primary })),
    [
      { path: "/first", label: "T3 Code", primary: true },
      { path: "/second", label: "T3 source 2", primary: false },
    ],
  );
});

test("colliding thread IDs and lifecycle exclusions remain separate; active agents take keys first", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-sources-"));
  const t3 = sourceFixture(join(dir, "t3.sqlite"));
  const a3 = sourceFixture(join(dir, "a3.sqlite"));
  const source = new LocalSources(
    [
      { path: join(dir, "t3.sqlite"), label: "T3 Code", primary: true },
      { path: join(dir, "a3.sqlite"), label: "A3 Code" },
    ],
    true,
  );
  try {
    t3.thread("shared", "completed");
    a3.thread("shared", "running");
    a3.thread("child", "running", {
      lineage: { parentThreadId: "shared", relationshipToParent: "subagent" },
    });
    t3.thread("ignored", "running");
    a3.thread("ignored", "completed", { settledAt: a3.at });
    const agents = source.read();
    assert.equal(agents[0]!.status, "working");
    assert.equal(agents.length, 4);
    const a3Parent = agents.find((a) => a.id.endsWith(":shared"))!;
    assert.equal(
      agents.find((a) => a.id.endsWith(":child"))!.parentId,
      a3Parent.id,
    );
    assert.equal(a3Parent.project, "A3 Code · Fixture project");
    assert.ok(!source.ignoredThreadIds.has("ignored"));
    const board = new Board();
    board.reconcile(agents, Date.now(), source.ignoredThreadIds);
    assert.equal(board.slots().filter((s) => s.agent).length, 4);
    assert.equal(
      assignedThread(
        board.slots(),
        board.slots().find((s) => s.agent?.id === a3Parent.id)!.key,
      ),
      null,
      "A3 cannot be sent to the T3-only desktop socket",
    );
    const before = board.slots().map((s) => s.agent?.id);
    board.reconcile(source.read(), Date.now(), source.ignoredThreadIds);
    assert.deepEqual(
      board.slots().map((s) => s.agent?.id),
      before,
    );
    a3.db.exec(
      "UPDATE orchestration_v2_projection_threads SET archived_at='now' WHERE thread_id='shared'",
    );
    const remaining = source.read();
    assert.ok(remaining.some((a) => a.id === "shared"));
    assert.ok(
      !remaining.some(
        (a) => a.id === a3Parent.id || a.parentId === a3Parent.id,
      ),
    );
  } finally {
    source.close();
    t3.db.close();
    a3.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("missing optional A3 is discovered later and a broken source retains its last agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-discovery-"));
  const t3Path = join(dir, "t3.sqlite");
  const a3Path = join(dir, "a3.sqlite");
  const t3 = sourceFixture(t3Path);
  t3.thread("t3-agent", "running");
  symlinkSync(t3Path, join(dir, "alias.sqlite"));
  let now = Date.now();
  const source = new LocalSources(
    [
      { path: t3Path, label: "T3 Code", primary: true },
      { path: a3Path, label: "A3 Code", optional: true },
      { path: join(dir, "alias.sqlite"), label: "Alias" },
    ],
    false,
    () => now,
  );
  let a3: ReturnType<typeof sourceFixture> | undefined;
  try {
    assert.equal(source.read().length, 1);
    assert.equal(source.states.length, 1);
    assert.ok(!source.states.some((s) => s.label === "Alias"));
    writeFileSync(a3Path, "broken sqlite");
    assert.equal(source.read().length, 1);
    assert.equal(source.states[1]!.connected, false);
    rmSync(a3Path);
    a3 = sourceFixture(a3Path);
    a3.thread("a3-agent", "running");
    const connectedAgents = source.read();
    assert.equal(connectedAgents.length, 2);
    assert.ok(source.states.every((s) => s.connected));
    const board = new Board();
    board.reconcile(connectedAgents, Date.now(), source.ignoredThreadIds);
    const a3Agent = connectedAgents.find((agent) => agent.id.endsWith(":a3-agent"))!;
    const a3Key = board.slots().find((slot) => slot.agent?.id === a3Agent.id)!.key;
    a3.db.exec("DROP TABLE orchestration_v2_projection_threads");
    const duringFailure = source.read();
    assert.equal(duringFailure.length, 2);
    assert.ok(duringFailure.some((agent) => agent.id === a3Agent.id));
    assert.equal(source.states[1]!.connected, false);
    assert.equal(source.states[1]!.stale, true);
    board.reconcile(duringFailure, Date.now(), source.ignoredThreadIds);
    assert.equal(
      board.slots().find((slot) => slot.agent?.id === a3Agent.id)?.key,
      a3Key,
    );
    a3.db.close();
    a3 = undefined;
    rmSync(a3Path);
    a3 = sourceFixture(a3Path);
    a3.thread("a3-agent", "running");
    assert.equal(source.read().length, 2);
    assert.ok(source.states.every((s) => s.connected));
    a3.db.close();
    a3 = undefined;
    rmSync(a3Path);
    const missingDuringGrace = source.read();
    assert.equal(missingDuringGrace.length, 2);
    assert.equal(source.states[1]!.connected, false);
    assert.equal(source.states[1]!.stale, true);
    board.reconcile(missingDuringGrace, Date.now(), source.ignoredThreadIds);
    assert.equal(
      board.slots().find((slot) => slot.agent?.id === a3Agent.id)?.key,
      a3Key,
    );
    now += SOURCE_STALE_GRACE_MS + 1;
    const afterGrace = source.read();
    assert.equal(afterGrace.length, 1);
    assert.equal(source.states[1]!.stale, false);
    board.reconcile(afterGrace, Date.now(), source.ignoredThreadIds);
    assert.ok(!board.slots().some((slot) => slot.agent?.id === a3Agent.id));
    const laterAfterGrace = source.read();
    assert.equal(laterAfterGrace.length, 1);
    assert.equal(source.states[1]!.label, "A3 Code");
    assert.equal(source.states[1]!.connected, false);
    assert.equal(source.states[1]!.stale, false);
    a3 = sourceFixture(a3Path);
    a3.thread("a3-agent", "running");
    const recovered = source.read();
    assert.equal(recovered.length, 2);
    assert.ok(source.states.every((s) => s.connected));
    board.reconcile(recovered, Date.now(), source.ignoredThreadIds);
    source.close();
    assert.equal(source.read().length, 2);
    t3.db.close();
    a3.db.close();
    a3 = undefined;
    source.close();
    rmSync(t3Path);
    rmSync(a3Path);
    now += SOURCE_STALE_GRACE_MS + 1;
    assert.deepEqual(source.read(), []);
    assert.ok(source.states.every((state) => !state.connected && !state.stale));
  } finally {
    source.close();
    if (t3.db.isOpen) t3.db.close();
    a3?.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("Grok Bot observations without app runs use native message lifecycle metadata and expire stale streams", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-bots-"));
  const fixture = sourceFixture(join(dir, "state.sqlite"));
  const source = new LocalT3Source(join(dir, "state.sqlite"));
  try {
    fixture.thread("empty");
    fixture.thread("grok-bot:empty");
    for (const id of [
      "live",
      "finished",
      "stale",
      "user",
      "archived",
      "settled",
      "deleted",
    ]) {
      fixture.thread(`grok-bot:${id}`);
      fixture.message(
        id,
        `grok-bot:${id}`,
        id === "live" || id === "stale",
        id === "stale" ? "2020-01-01" : fixture.at,
        id === "user" ? "user" : "assistant",
      );
    }
    fixture.db
      .exec(`UPDATE orchestration_v2_projection_threads SET archived_at='now' WHERE thread_id='grok-bot:archived';
      UPDATE orchestration_v2_projection_threads SET deleted_at='now' WHERE thread_id='grok-bot:deleted';
      UPDATE orchestration_v2_projection_threads SET payload_json='{"settledAt":"now"}' WHERE thread_id='grok-bot:settled';`);
    const agents = source.read();
    assert.deepEqual(
      new Map(agents.map((a) => [a.id, a.status])),
      new Map([
        ["grok-bot:live", "working"],
        ["grok-bot:finished", "done"],
        ["grok-bot:stale", "idle"],
        ["grok-bot:user", "idle"],
      ]),
    );
    assert.ok(!JSON.stringify(agents).includes("PRIVATE_TEXT"));
    const board = new Board();
    board.reconcile(agents);
    const live = agents.find((a) => a.id === "grok-bot:live")!;
    assert.ok(live.runId);
    fixture.db.exec(
      "UPDATE orchestration_v2_projection_messages SET streaming=0 WHERE message_id='live'",
    );
    const finished = source.read();
    board.reconcile(finished);
    assert.equal(board.slots()[0]!.status, "done");
    assert.equal(finished.find((a) => a.id === live.id)!.runId, live.runId);
    board.release(0);
    board.reconcile(source.read());
    assert.ok(!board.slots().some((s) => s.agent?.id === live.id));
    fixture.message(
      "next",
      live.id,
      true,
      new Date(Date.now() + 10).toISOString(),
    );
    board.reconcile(source.read());
    assert.ok(board.slots().some((s) => s.agent?.id === live.id));
  } finally {
    source.close();
    fixture.db.close();
    rmSync(dir, { recursive: true });
  }
});
