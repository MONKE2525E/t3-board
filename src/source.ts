import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, Status } from "./model.ts";

const ACTIVE = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const RUN_ORDER = `CASE WHEN status IN ('running','starting','preparing','waiting') THEN 0
  WHEN status='queued' THEN 1 ELSE 2 END, ordinal DESC`;
interface ThreadRow {
  thread_id: string;
  title: string;
  payload_json: string;
  project: string;
  run_id: string | null;
  status: string | null;
  requested_at: string | null;
  updated_at: string;
  has_background_work: number;
}
export class LocalT3Source {
  private db: DatabaseSync | null = null;
  ignoredThreadIds = new Set<string>();
  readonly path: string;
  readonly includeSubagents: boolean;
  constructor(
    path = process.env.T3_BOARD_DB ??
      join(homedir(), ".t3", "userdata", "statev2.sqlite"),
    includeSubagents = process.env.T3_BOARD_INCLUDE_SUBAGENTS === "1",
  ) {
    this.path = path;
    this.includeSubagents = includeSubagents;
  }
  read(): Agent[] {
    this.db ??= new DatabaseSync(this.path, { readOnly: true });
    this.db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 500;");
    const lifecycle = this.db
      .prepare(
        `SELECT thread_id,
      json_extract(payload_json,'$.lineage.parentThreadId') parent_id,
      json_extract(payload_json,'$.lineage.relationshipToParent') relationship,
      (archived_at IS NOT NULL OR deleted_at IS NOT NULL
        OR COALESCE(json_extract(payload_json,'$.settledOverride'),'')='settled'
        OR json_extract(payload_json,'$.settledAt') IS NOT NULL) ignored
      FROM orchestration_v2_projection_threads`,
      )
      .all() as {
      thread_id: string;
      parent_id: string | null;
      relationship: string | null;
      ignored: number;
    }[];
    this.ignoredThreadIds = new Set();
    const children = new Map<string, string[]>();
    const pending: string[] = [];
    for (const t of lifecycle) {
      if (t.ignored) {
        this.ignoredThreadIds.add(t.thread_id);
        pending.push(t.thread_id);
      }
      if (t.relationship === "subagent" && t.parent_id) {
        const siblings = children.get(t.parent_id) ?? [];
        siblings.push(t.thread_id);
        children.set(t.parent_id, siblings);
      }
    }
    // Traverse once in memory. Recursive JSON joins repeatedly scanned the
    // whole thread table and blocked the keyboard's realtime refresh.
    for (let i = 0; i < pending.length; i++) {
      for (const child of children.get(pending[i]!) ?? []) {
        if (!this.ignoredThreadIds.has(child)) {
          this.ignoredThreadIds.add(child);
          pending.push(child);
        }
      }
    }
    if (!this.includeSubagents)
      for (const t of lifecycle)
        if (t.relationship === "subagent")
          this.ignoredThreadIds.add(t.thread_id);
    // Async questions can remain open while the provider continues working.
    // Read request metadata only, without selecting questions or answers.
    const needsInput = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT q.thread_id
        FROM orchestration_v2_projection_runtime_requests q
        JOIN orchestration_v2_projection_nodes n ON n.node_id=q.node_id
        JOIN orchestration_v2_projection_runs r ON r.run_id=n.run_id
        JOIN orchestration_v2_projection_threads t ON t.thread_id=q.thread_id
        WHERE q.status='pending' AND q.resolved_at IS NULL
          AND q.kind IN ('user_input','command','file-read','file-change','mcp-elicitation','permission','auth_refresh')
          AND r.status NOT IN ('rolled_back','cancelled','failed')
          AND n.status NOT IN ('cancelled','failed')
          AND (json_extract(t.payload_json,'$.activeProviderThreadId') IS NULL
            OR n.provider_thread_id=json_extract(t.payload_json,'$.activeProviderThreadId'))
          AND COALESCE(json_extract(q.payload_json,'$.responseCapability.type'),'live')<>'not_resumable'`,
          )
          .all() as { thread_id: string }[]
      ).map((q) => q.thread_id),
    );
    // Only titles, lifecycle records, and PR snapshots are read. Conversation content is never selected.
    const threads = this.db
      .prepare(
        `SELECT t.thread_id,t.title,t.payload_json,t.updated_at,
      COALESCE(p.title,'T3 Code') project,r.run_id,r.status,r.requested_at,
      (EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_threads pt,
          json_each(pt.payload_json,'$.pendingBackgroundTasks') task
        WHERE pt.thread_id=t.thread_id
          AND (json_extract(t.payload_json,'$.activeProviderThreadId') IS NULL
            OR pt.provider_thread_id=json_extract(t.payload_json,'$.activeProviderThreadId'))
          AND json_extract(task.value,'$.kind') IN ('subagent','monitor','background_task')
      ) OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items item
        WHERE item.thread_id=t.thread_id
          AND item.type IN ('subagent','dynamic_tool')
          AND item.status IN ('pending','running','waiting')
          AND (item.type<>'dynamic_tool' OR COALESCE(json_extract(item.payload_json,'$.input.persistent'),0)<>1)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs old
            WHERE old.run_id=item.run_id AND old.status='rolled_back')
      )) has_background_work
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id=t.project_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=(
        SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=t.thread_id ORDER BY ${RUN_ORDER} LIMIT 1)
      WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
      AND r.run_id IS NOT NULL
      AND COALESCE(json_extract(t.payload_json,'$.settledOverride'),'') <> 'settled'
      AND json_extract(t.payload_json,'$.settledAt') IS NULL
      AND (${this.includeSubagents ? 1 : 0}=1 OR COALESCE(json_extract(t.payload_json,'$.lineage.relationshipToParent'),'')<>'subagent')
      ORDER BY CASE WHEN r.status IN ('running','starting','preparing','queued','waiting') THEN 0 ELSE 1 END,t.updated_at DESC
      LIMIT 1000`,
      )
      .all() as unknown as ThreadRow[];
    const agents: Agent[] = [];
    for (const t of threads) {
      if (this.ignoredThreadIds.has(t.thread_id)) continue;
      const payload = JSON.parse(t.payload_json) as {
        lineage?: { parentThreadId?: string };
        pullRequests?: { source?: string; watch?: object | null }[];
      };
      // Built-in PR watches live on the thread, outside the provider roster.
      // Match T3's monitor derivation; merely linking a PR is not a watch.
      const watching = payload.pullRequests?.some(
        (pr) => pr.source !== "stack-dismissed" && pr.watch != null,
      );
      let status: Status = ACTIVE.has(t.status ?? "")
        ? t.status === "waiting"
          ? "waiting"
          : "working"
        : t.status === "failed"
          ? "error"
          : t.status === "completed"
            ? "done"
            : "idle";
      // A finished turn can still own live delegated work. T3's Working
      // section keeps that parent waiting until its background tasks finish.
      if (
        (t.has_background_work || watching) &&
        (status === "done" || status === "idle")
      )
        status = "working";
      const merges = this.db
        .prepare(
          `SELECT snapshot_json FROM projection_thread_pull_requests WHERE thread_id=? AND source<>'stack-dismissed'`,
        )
        .all(t.thread_id) as { snapshot_json: string | null }[];
      const merged = merges.some((m) => {
        if (!m.snapshot_json) return false;
        const snapshot = JSON.parse(m.snapshot_json) as {
          state?: string;
          mergedAt?: string;
        };
        return (
          snapshot.state?.toLowerCase() === "merged" &&
          !!snapshot.mergedAt &&
          (!t.requested_at ||
            Date.parse(snapshot.mergedAt) >= Date.parse(t.requested_at))
        );
      });
      if (merged && !watching && status !== "error") status = "merged";
      if (needsInput.has(t.thread_id) && status !== "error") status = "waiting";
      agents.push({
        id: t.thread_id,
        title: t.title || "Untitled agent",
        project: t.project,
        status,
        runId: t.run_id ?? undefined,
        updatedAt: t.updated_at,
        sentAt: t.requested_at ?? undefined,
        parentId: payload.lineage?.parentThreadId,
      });
    }
    // Provider-native subagents have no independent app thread. Include them without double-counting T3 children.
    const native = this.includeSubagents
      ? (this.db
          .prepare(
            `SELECT subagent_id,thread_id,status,updated_at,
      json_extract(payload_json,'$.title') title,run_id FROM orchestration_v2_projection_subagents
      WHERE child_thread_id IS NULL AND status IN ('pending','queued','running','completed','failed')
      AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id=orchestration_v2_projection_subagents.thread_id ORDER BY ${RUN_ORDER} LIMIT 1)
      AND thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE archived_at IS NULL AND deleted_at IS NULL AND json_extract(payload_json,'$.settledAt') IS NULL)
      ORDER BY updated_at DESC LIMIT 1000`,
          )
          .all() as {
          subagent_id: string;
          thread_id: string;
          status: string;
          updated_at: string;
          title: string | null;
          run_id: string;
        }[])
      : [];
    for (const child of native) {
      const parent = agents.find((a) => a.id === child.thread_id);
      if (!parent) continue;
      agents.push({
        id: `native:${child.subagent_id}`,
        title: child.title ?? "Subagent",
        project: parent.project,
        parentId: parent.id,
        runId: child.run_id,
        updatedAt: child.updated_at,
        status:
          child.status === "completed"
            ? "done"
            : child.status === "failed"
              ? "error"
              : "working",
      });
    }
    return agents.sort(
      (a, b) =>
        Number(!["working", "waiting"].includes(a.status)) -
        Number(!["working", "waiting"].includes(b.status)),
    );
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}

export function demoAgents(): Agent[] {
  const states: Status[] = [
    "working",
    "done",
    "error",
    "merged",
    "waiting",
    "working",
    "idle",
  ];
  const names = [
    "Build authentication",
    "Polish the dashboard",
    "Repair failing checks",
    "Ship keyboard support",
    "Review the API",
    "Write integration tests",
    "Explore search",
  ];
  return states.map((status, i) => ({
    id: `demo:${i}`,
    title: names[i]!,
    project: i < 4 ? "T3 Board" : "Workspace",
    status,
    runId: `demo-run:${i}`,
    updatedAt: new Date().toISOString(),
  }));
}
