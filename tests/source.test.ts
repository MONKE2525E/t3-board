import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalT3Source } from "../src/source.ts";
import { Board } from "../src/model.ts";
test("reads live lifecycle and PR merges, omits archived and empty threads, and deduplicates native children", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-test-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,node_id TEXT,kind TEXT,status TEXT,resolved_at TEXT,payload_json TEXT);
 CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT,run_id TEXT,status TEXT,provider_thread_id TEXT);
 CREATE TABLE projection_projects(project_id TEXT,title TEXT);
 CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
 CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,requested_at TEXT);
 CREATE TABLE projection_thread_pull_requests(thread_id TEXT,source TEXT,snapshot_json TEXT);
 CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT,thread_id TEXT,status TEXT,updated_at TEXT,payload_json TEXT,run_id TEXT,child_thread_id TEXT);
 CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
 CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT,payload_json TEXT);
 INSERT INTO projection_projects VALUES('p','Test project');`);
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,NULL)",
  );
  const run = db.prepare(
    "INSERT INTO orchestration_v2_projection_runs VALUES(?,?,1,?,?)",
  );
  for (const [id, status] of [
    ["a", "running"],
    ["b", "completed"],
    ["c", "failed"],
    ["d", "completed"],
  ]) {
    insert.run(id, "p", id, "{}", "2026-10-05");
    run.run(id, id, status, "2026-10-05T00:00:00Z");
  }
  insert.run("empty", "p", "empty", "{}", "2026-10-05");
  db.exec(
    "INSERT INTO orchestration_v2_projection_runs VALUES('cancelled-queue','a',2,'cancelled','2026-10-05T00:10:00Z')",
  );
  insert.run(
    "active-child",
    "p",
    "active-child",
    JSON.stringify({
      lineage: { parentThreadId: "a", relationshipToParent: "subagent" },
    }),
    "2026-10-05",
  );
  run.run("active-child", "active-child", "running", "2026-10-05");
  insert.run(
    "settled",
    "p",
    "settled",
    '{"settledAt":"2026-10-05"}',
    "2026-10-05",
  );
  run.run("settled", "settled", "completed", "2026-10-05");
  insert.run(
    "override",
    "p",
    "override",
    '{"settledOverride":"settled"}',
    "2026-10-05",
  );
  run.run("override", "override", "running", "2026-10-05");
  for (const [id, parent] of [
    ["child", "override"],
    ["grandchild", "child"],
  ]) {
    insert.run(
      id,
      "p",
      id,
      JSON.stringify({
        lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
      }),
      "2026-10-05",
    );
    run.run(id, id, "running", "2026-10-05");
  }
  const pr = db.prepare(
    "INSERT INTO projection_thread_pull_requests VALUES(?,?,?)",
  );
  pr.run(
    "b",
    "explicit",
    JSON.stringify({ state: "merged", mergedAt: "2026-10-05T01:00:00Z" }),
  );
  pr.run(
    "a",
    "explicit",
    JSON.stringify({ state: "merged", mergedAt: "2026-10-04T00:00:00Z" }),
  );
  db.exec(
    `INSERT INTO orchestration_v2_projection_subagents VALUES('native','a','running','2026-10-05','{"title":"Native child"}','a',NULL),('linked','a','running','2026-10-05','{}','a','d'),('old','a','completed','2026-10-04','{}','old-run',NULL),('settled-child','override','running','2026-10-05','{}','override',NULL);`,
  );
  db.close();
  const source = new LocalT3Source(path, true);
  const sidebarSource = new LocalT3Source(path, false);
  try {
    const visible = sidebarSource.read();
    assert.equal(visible.length, 4);
    assert.ok(visible.every((a) => !a.parentId));
    assert.ok(sidebarSource.ignoredThreadIds.has("active-child"));
    const agents = source.read();
    assert.equal(agents.length, 6);
    assert.equal(agents.find((a) => a.id === "a")!.status, "working");
    assert.equal(agents.find((a) => a.id === "a")!.runId, "a");
    assert.equal(agents.find((a) => a.id === "b")!.status, "merged");
    assert.equal(agents.find((a) => a.id === "c")!.status, "error");
    assert.equal(agents.find((a) => a.id === "d")!.status, "done");
    assert.equal(agents.find((a) => a.id === "native:native")!.parentId, "a");
    assert.ok(
      agents.findIndex((a) => a.id === "native:native") <
        agents.findIndex((a) => a.id === "b"),
    );
    assert.ok(source.ignoredThreadIds.has("override"));
    assert.ok(source.ignoredThreadIds.has("child"));
    assert.ok(source.ignoredThreadIds.has("grandchild"));
    const writer = new DatabaseSync(path);
    writer
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='a'",
      )
      .run('{"settledOverride":"settled"}');
    writer.close();
    assert.equal(
      source.read().some((a) => a.id === "a" || a.id === "native:native"),
      false,
    );
  } finally {
    source.close();
    sidebarSource.close();
    rmSync(dir, { recursive: true });
  }
});

test("a completed parent stays working while delegated background work is pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-background-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,node_id TEXT,kind TEXT,status TEXT,resolved_at TEXT,payload_json TEXT);
 CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT,run_id TEXT,status TEXT,provider_thread_id TEXT);
 CREATE TABLE projection_projects(project_id TEXT,title TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,requested_at TEXT);
    CREATE TABLE projection_thread_pull_requests(thread_id TEXT,source TEXT,snapshot_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT,payload_json TEXT);`);
  for (const id of ["delegated", "monitor", "failed", "ordinary", "obsolete"]) {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES(?, 'p', ?, ?, '2026-10-05', NULL, NULL)",
    ).run(id, id, JSON.stringify({ activeProviderThreadId: `provider:${id}` }));
    db.prepare(
      "INSERT INTO orchestration_v2_projection_runs VALUES(?, ?, 2, ?, '2026-10-05')",
    ).run(id, id, id === "failed" ? "failed" : "completed");
  }
  // Background tasks can outlive the turn in which they were started.
  db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES('earlier', 'delegated', 1, 'completed', '2026-10-04'), ('rollback', 'obsolete', 1, 'rolled_back', '2026-10-04');
    INSERT INTO orchestration_v2_projection_turn_items VALUES
      ('delegated', 'earlier', 'subagent', 'running', '{}'),
      ('failed', 'failed', 'subagent', 'running', '{}'),
      ('ordinary', 'ordinary', 'command_execution', 'running', '{}'),
      ('ordinary', 'ordinary', 'dynamic_tool', 'running', '{"input":{"persistent":true}}'),
      ('obsolete', 'rollback', 'subagent', 'running', '{}');
    INSERT INTO orchestration_v2_projection_provider_threads VALUES
      ('provider:monitor', 'monitor', '{"pendingBackgroundTasks":[{"taskId":"watch","kind":"monitor"}]}'),
      ('old:ordinary', 'ordinary', '{"pendingBackgroundTasks":[{"taskId":"old","kind":"subagent"}]}'),
      ('provider:ordinary', 'ordinary', '{"pendingBackgroundTasks":[{"taskId":"shell","kind":"command"}]}');`);
  const source = new LocalT3Source(path, false);
  try {
    const statuses = new Map(source.read().map((a) => [a.id, a.status]));
    assert.equal(statuses.get("delegated"), "working");
    assert.equal(statuses.get("monitor"), "working");
    assert.equal(statuses.get("failed"), "error");
    assert.equal(statuses.get("ordinary"), "done");
    assert.equal(statuses.get("obsolete"), "done");
    db.exec(`UPDATE orchestration_v2_projection_turn_items SET status='completed' WHERE thread_id='delegated';
      UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"pendingBackgroundTasks":[]}' WHERE thread_id='monitor';`);
    const finished = new Map(source.read().map((a) => [a.id, a.status]));
    assert.equal(finished.get("delegated"), "done");
    assert.equal(finished.get("monitor"), "done");
  } finally {
    source.close();
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test("open input requests override running and merged status, then clear on resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-input-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projection_projects(project_id TEXT,title TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,requested_at TEXT);
    CREATE TABLE projection_thread_pull_requests(thread_id TEXT,source TEXT,snapshot_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,node_id TEXT,kind TEXT,status TEXT,resolved_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT,run_id TEXT,status TEXT,provider_thread_id TEXT);`);
  for (const id of [
    "asking",
    "merged",
    "resolved",
    "cancelled",
    "rollback",
    "old-session",
    "tool",
    "unresumable",
    "failed",
    "approval",
  ]) {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES(?, 'p', ?, '{\"activeProviderThreadId\":\"current\"}', '2026-10-05', NULL, NULL)",
    ).run(id, id);
    db.prepare(
      "INSERT INTO orchestration_v2_projection_runs VALUES(?, ?, 2, ?, '2026-10-05')",
    ).run(id, id, id === "failed" ? "failed" : "running");
    db.prepare(
      "INSERT INTO orchestration_v2_projection_nodes VALUES(?, ?, 'running', ?)",
    ).run(id, id, id === "old-session" ? "old" : "current");
    db.prepare(
      "INSERT INTO orchestration_v2_projection_runtime_requests VALUES(?, ?, ?, ?, NULL, ?)",
    ).run(
      id,
      id,
      id === "tool"
        ? "dynamic_tool_call"
        : id === "approval"
          ? "permission"
          : "user_input",
      id === "resolved"
        ? "resolved"
        : id === "cancelled"
          ? "cancelled"
          : "pending",
      JSON.stringify({
        responseCapability: {
          type: id === "unresumable" ? "not_resumable" : "message",
        },
      }),
    );
  }
  db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES('rolled', 'rollback', 1, 'rolled_back', '2026-10-04');
    UPDATE orchestration_v2_projection_nodes SET run_id='rolled' WHERE node_id='rollback';
    INSERT INTO projection_thread_pull_requests VALUES('merged', 'explicit', '{"state":"merged","mergedAt":"2026-10-06"}');`);
  const source = new LocalT3Source(path, false);
  try {
    const statuses = new Map(source.read().map((a) => [a.id, a.status]));
    assert.equal(statuses.get("asking"), "waiting");
    assert.equal(statuses.get("merged"), "waiting");
    assert.equal(statuses.get("approval"), "waiting");
    assert.equal(statuses.get("failed"), "error");
    for (const id of [
      "resolved",
      "cancelled",
      "rollback",
      "old-session",
      "tool",
      "unresumable",
    ])
      assert.equal(statuses.get(id), "working", id);
    db.exec(
      "UPDATE orchestration_v2_projection_runtime_requests SET status='resolved',resolved_at='2026-10-05' WHERE thread_id='asking'",
    );
    assert.equal(
      source.read().find((a) => a.id === "asking")!.status,
      "working",
    );
  } finally {
    source.close();
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test("built-in PR watches stay working between turns and release when unwatched", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-pr-watch-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projection_projects(project_id TEXT,title TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,requested_at TEXT);
    CREATE TABLE projection_thread_pull_requests(thread_id TEXT,source TEXT,snapshot_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,node_id TEXT,kind TEXT,status TEXT,resolved_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT,run_id TEXT,status TEXT,provider_thread_id TEXT);`);
  const watch = { startedAt: "2026-10-06T00:00:00Z" };
  for (const [id, pullRequests] of [
    ["watching", [{ source: "explicit", watch }]],
    ["linked", [{ source: "explicit" }]],
    ["dismissed", [{ source: "stack-dismissed", watch }]],
    ["null", [{ source: "explicit", watch: null }]],
    [
      "multiple",
      [
        { source: "stack-dismissed", watch },
        { source: "explicit", watch },
      ],
    ],
    ["failed", [{ source: "explicit", watch }]],
    ["input", [{ source: "explicit", watch }]],
    ["merged", [{ source: "explicit", watch }]],
    ["settled", [{ source: "explicit", watch }]],
  ] as const) {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES(?, 'p', ?, ?, '2026-10-06', NULL, NULL)",
    ).run(
      id,
      id,
      JSON.stringify({
        pullRequests,
        ...(id === "settled" ? { settledAt: "2026-10-06" } : {}),
      }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_runs VALUES(?, ?, 1, ?, '2026-10-06')",
    ).run(id, id, id === "failed" ? "failed" : "completed");
  }
  db.exec(`INSERT INTO projection_thread_pull_requests VALUES('merged', 'explicit', '{"state":"merged","mergedAt":"2026-10-06T01:00:00Z"}');
    INSERT INTO orchestration_v2_projection_nodes VALUES('input', 'input', 'completed', 'provider');
    INSERT INTO orchestration_v2_projection_runtime_requests VALUES('input', 'input', 'user_input', 'pending', NULL, '{}');`);
  const source = new LocalT3Source(path, false);
  try {
    const agents = source.read();
    const statuses = new Map(agents.map((a) => [a.id, a.status]));
    const board = new Board();
    board.reconcile(agents);
    const slot = board.slots().find((s) => s.agent?.id === "watching")!;
    assert.equal(slot.status, "working");
    const frame = board.frame();
    assert.equal(frame[slot.led * 4 + 3], 0);
    assert.ok(frame[slot.led * 4 + 1]! > frame[slot.led * 4 + 2]!);
    for (const id of ["watching", "multiple", "merged"])
      assert.equal(statuses.get(id), "working", id);
    for (const id of ["linked", "dismissed", "null"])
      assert.equal(statuses.get(id), "done", id);
    assert.equal(statuses.get("failed"), "error");
    assert.equal(statuses.get("input"), "waiting");
    assert.equal(statuses.has("settled"), false);
    // Removing one of several watches still leaves the other monitor active.
    db.prepare(
      "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='multiple'",
    ).run(
      JSON.stringify({
        pullRequests: [{ source: "explicit" }, { source: "explicit", watch }],
      }),
    );
    assert.equal(
      source.read().find((a) => a.id === "multiple")!.status,
      "working",
    );
    db.exec(
      `UPDATE orchestration_v2_projection_threads SET payload_json='{"pullRequests":[{"source":"explicit"}]}' WHERE thread_id IN ('watching', 'merged');`,
    );
    const finished = new Map(source.read().map((a) => [a.id, a.status]));
    assert.equal(finished.get("watching"), "done");
    assert.equal(finished.get("merged"), "merged");
  } finally {
    source.close();
    db.close();
    rmSync(dir, { recursive: true });
  }
});
