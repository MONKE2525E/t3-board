import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Agent } from "./model.ts";
import { LocalT3Source } from "./source.ts";

export interface SourceLocation {
  path: string;
  label: string;
  // Keep the original T3 IDs for the installed composer/navigation bridge.
  primary?: boolean;
  optional?: boolean;
}

export const SOURCE_STALE_GRACE_MS = 90_000;

export function sourceLocations(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): SourceLocation[] {
  // In explicit mode, the first entry is the regular T3 source used by the
  // desktop navigation bridge. Additional entries remain lighting-only.
  if (env.T3_BOARD_DBS)
    return env.T3_BOARD_DBS.split(delimiter)
      .filter(Boolean)
      .map((path, i) => ({
        path,
        label: i === 0 ? "T3 Code" : `T3 source ${i + 1}`,
        primary: i === 0,
      }));
  if (env.T3_BOARD_DB)
    return [{ path: env.T3_BOARD_DB, label: "T3 Code", primary: true }];
  return [
    {
      path: join(home, ".t3", "userdata", "statev2.sqlite"),
      label: "T3 Code",
      primary: true,
      optional: true,
    },
    {
      path:
        env.T3_BOARD_A3_DB ??
        join(home, ".t3-grokbot-dev", "userdata", "statev2.sqlite"),
      label: "A3 Code",
      optional: !env.T3_BOARD_A3_DB,
    },
  ];
}

interface SourceState {
  label: string;
  connected: boolean;
  error: string | null;
  stale: boolean;
  staleForMs: number;
}

interface SourceSnapshot {
  agents: Agent[];
  ignoredThreadIds: Set<string>;
  readAt: number;
}

/** Poll each installation independently, including ones created after startup. */
export class LocalSources {
  private sources = new Map<string, LocalT3Source>();
  private snapshots = new Map<string, SourceSnapshot>();
  private knownSources = new Set<string>();
  private locations: SourceLocation[];
  private includeSubagents: boolean;
  private now: () => number;
  ignoredThreadIds = new Set<string>();
  states: SourceState[] = [];
  constructor(
    locations = sourceLocations(),
    includeSubagents = process.env.T3_BOARD_INCLUDE_SUBAGENTS === "1",
    now = Date.now,
  ) {
    this.locations = locations;
    this.includeSubagents = includeSubagents;
    this.now = now;
  }

  read(): Agent[] {
    const agents: Agent[] = [];
    const seen = new Set<string>();
    this.ignoredThreadIds = new Set();
    this.states = [];
    for (const [index, location] of this.locations.entries()) {
      const snapshotKey = `${index}:${resolve(location.path)}`;
      if (location.optional && !existsSync(location.path)) {
        const snapshot = this.snapshots.get(snapshotKey);
        // An optional installation may disappear after it was discovered.
        // Treat that like any other outage, while leaving never-seen installs
        // quiet so first-run discovery does not produce a warning.
        if (this.knownSources.has(snapshotKey)) {
          const withinGrace =
            snapshot !== undefined &&
            this.now() - snapshot.readAt < SOURCE_STALE_GRACE_MS;
          if (withinGrace && snapshot) {
            agents.push(...snapshot.agents);
            for (const ignored of snapshot.ignoredThreadIds)
              this.ignoredThreadIds.add(ignored);
          } else {
            this.snapshots.delete(snapshotKey);
          }
          this.states.push({
            label: location.label,
            connected: false,
            error: "Local database is unavailable or unsupported.",
            stale: withinGrace && !!snapshot?.agents.length,
            staleForMs: SOURCE_STALE_GRACE_MS,
          });
        }
        continue;
      }
      let source: LocalT3Source | undefined;
      try {
        const path = realpathSync(resolve(location.path));
        if (seen.has(path)) {
          this.snapshots.delete(snapshotKey);
          continue;
        }
        seen.add(path);
        this.knownSources.add(snapshotKey);
        source = this.sources.get(path);
        if (!source) {
          source = new LocalT3Source(path, this.includeSubagents);
          this.sources.set(path, source);
        }
        const namespace = location.primary
          ? ""
          : `source:${createHash("sha256").update(path).digest("hex").slice(0, 16)}:`;
        const id = (value: string) => namespace + value;
        const scopedAgents = source.read().map((agent) => ({
          ...agent,
          id: id(agent.id),
          parentId: agent.parentId ? id(agent.parentId) : undefined,
          project: location.primary
            ? agent.project
            : `${location.label} · ${agent.project}`,
        }));
        const ignoredThreadIds = new Set(
          [...source.ignoredThreadIds].map(id),
        );
        this.snapshots.set(snapshotKey, {
          agents: scopedAgents,
          ignoredThreadIds,
          readAt: this.now(),
        });
        agents.push(...scopedAgents);
        for (const ignored of ignoredThreadIds)
          this.ignoredThreadIds.add(ignored);
        this.states.push({
          label: location.label,
          connected: true,
          error: null,
          stale: false,
          staleForMs: SOURCE_STALE_GRACE_MS,
        });
      } catch {
        source?.close();
        const snapshot = this.snapshots.get(snapshotKey);
        const withinGrace =
          snapshot !== undefined &&
          this.now() - snapshot.readAt < SOURCE_STALE_GRACE_MS;
        if (withinGrace && snapshot) {
          agents.push(...snapshot.agents);
          for (const ignored of snapshot.ignoredThreadIds)
            this.ignoredThreadIds.add(ignored);
        } else {
          this.snapshots.delete(snapshotKey);
        }
        this.states.push({
          label: location.label,
          connected: false,
          error: "Local database is unavailable or unsupported.",
          stale: !!withinGrace && !!snapshot?.agents.length,
          staleForMs: SOURCE_STALE_GRACE_MS,
        });
      }
    }
    // Release handles for removed installations or retargeted symlinks.
    for (const [path, source] of this.sources)
      if (!seen.has(path)) {
        source.close();
        this.sources.delete(path);
      }
    return agents.sort(
      (a, b) =>
        Number(!["working", "waiting"].includes(a.status)) -
        Number(!["working", "waiting"].includes(b.status)),
    );
  }

  close() {
    for (const source of this.sources.values()) source.close();
    this.sources.clear();
  }
}
