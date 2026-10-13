import { DatabaseSync } from "node:sqlite";

export function sourceFixture(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,node_id TEXT,kind TEXT,status TEXT,resolved_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT,run_id TEXT,status TEXT,provider_thread_id TEXT);
    CREATE TABLE projection_projects(project_id TEXT,title TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,requested_at TEXT);
    CREATE TABLE projection_thread_pull_requests(thread_id TEXT,source TEXT,snapshot_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT,thread_id TEXT,status TEXT,updated_at TEXT,payload_json TEXT,run_id TEXT,child_thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,run_id TEXT,role TEXT,streaming INTEGER,created_at TEXT,updated_at TEXT,payload_json TEXT);
    INSERT INTO projection_projects VALUES('p','Fixture project');
  `);
  const at = new Date().toISOString();
  const thread = (id: string, status?: string, payload: object = {}) => {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES(?, 'p', ?, ?, ?, NULL, NULL)",
    ).run(id, id, JSON.stringify(payload), at);
    if (status)
      db.prepare(
        "INSERT INTO orchestration_v2_projection_runs VALUES(?, ?, 1, ?, ?)",
      ).run(`run:${id}`, id, status, at);
  };
  const message = (
    id: string,
    threadId: string,
    streaming = false,
    updatedAt = at,
    role = "assistant",
  ) => {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_messages VALUES(?, ?, NULL, ?, ?, ?, ?, ?)",
    ).run(
      id,
      threadId,
      role,
      Number(streaming),
      updatedAt,
      updatedAt,
      JSON.stringify({ text: "PRIVATE_TEXT_MUST_NOT_BE_RETURNED" }),
    );
  };
  return { db, thread, message, at };
}
