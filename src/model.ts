import {
  BODY_KEYS,
  DEFAULT_BODY_EFFECT,
  effectColor,
  type BodyEffect,
} from "./effects.ts";

export type Status =
  "drafting" | "working" | "done" | "error" | "merged" | "waiting" | "idle";
export type RGB = readonly [number, number, number];
export interface Agent {
  id: string;
  title: string;
  project: string;
  status: Status;
  runId?: string;
  updatedAt: string;
  sentAt?: string;
  parentId?: string;
}
export interface Slot {
  key: string;
  led: number;
  agent: Agent | null;
  color: RGB;
  status: Status | "unassigned";
}
export interface PhysicalKey {
  label: string;
  led: number;
  width?: number;
}
const row = (labels: string[], leds: number[]): PhysicalKey[] =>
  labels.map((label, i) => ({ label, led: leds[i]! }));
const range = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => start + i);

// Physical LED addresses for SONiX AK820, FF13 interface. These differ from keymap slots.
export const LAYOUT: PhysicalKey[][] = [
  row(
    ["Esc", ...range(1, 12).map((i) => `F${i}`), "Del"],
    [...range(1, 13), 119],
  ),
  row(
    [
      "`",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
      "−",
      "=",
      "Back",
      "Home",
    ],
    [...range(19, 13), 103, 117],
  ),
  row(
    [
      "Tab",
      "Q",
      "W",
      "E",
      "R",
      "T",
      "Y",
      "U",
      "I",
      "O",
      "P",
      "[",
      "]",
      "\\",
      "PgUp",
    ],
    [...range(37, 13), 67, 118],
  ),
  row(
    [
      "Caps",
      "A",
      "S",
      "D",
      "F",
      "G",
      "H",
      "J",
      "K",
      "L",
      ";",
      "'",
      "Enter",
      "PgDn",
    ],
    [...range(55, 12), 85, 121],
  ),
  row(
    [
      "Shift",
      "Z",
      "X",
      "C",
      "V",
      "B",
      "N",
      "M",
      ",",
      ".",
      "/",
      "Shift",
      "↑",
      "End",
    ],
    [...range(73, 12), 101, 122],
  ),
  row(
    ["Ctrl", "Win", "Alt", "Space", "Alt", "Fn", "Ctrl", "←", "↓", "→"],
    [91, 92, 93, 94, 95, 96, 98, 99, 100, 102],
  ),
];
export const TOP_ROW = LAYOUT[0]!;
export const STATUS_LABELS: Record<Status | "unassigned", string> = {
  drafting: "Drafting",
  working: "Working",
  done: "Finished",
  error: "Error",
  merged: "PR merged",
  waiting: "Needs input",
  idle: "Idle",
  unassigned: "Unassigned",
};
export function colorFor(
  status: Status | "unassigned",
  elapsedMs: number,
  brightness = 0.55,
): RGB {
  let base: RGB = [0, 0, 0];
  let intensity = 1;
  switch (status) {
    case "working":
      base = [255, 190, 0];
      intensity =
        0.12 + (0.88 * (1 - Math.cos((elapsedMs * Math.PI * 2) / 3200))) / 2;
      break;
    case "drafting":
      base = [255, 190, 0];
      intensity = elapsedMs % 320 < 160 ? 1 : 0;
      break;
    case "done":
      base = [0, 255, 0];
      intensity = elapsedMs % 1100 < 550 ? 1 : 0;
      break;
    case "error":
      base = [255, 35, 35];
      break;
    case "merged":
      base = [175, 70, 255];
      break;
    case "waiting":
      base = [25, 65, 255];
      break;
    case "idle":
      base = [255, 255, 255];
      intensity = 0.18;
      break;
  }
  return base.map((v) =>
    Math.round(v * intensity * Math.max(0, Math.min(1, brightness))),
  ) as unknown as RGB;
}

export class Board {
  assignments: (Agent | null)[] = Array.from({ length: 14 }, () => null);
  excluded = new Map<string, string>();
  draft: { id: string; title: string; expires: number } | null = null;
  pulses = new Map<string, number>();
  overflow = 0;
  private previousRuns = new Map<string, string>();
  private startedAt = Date.now();

  reconcile(agents: Agent[], now = Date.now(), ignored = new Set<string>()) {
    if (this.draft && ignored.has(this.draft.id)) this.draft = null;
    const byId = new Map(agents.map((a) => [a.id, a]));
    this.assignments = this.assignments.map((agent) => {
      if (!agent) return null;
      if (ignored.has(agent.id)) return null;
      const current = byId.get(agent.id);
      if (!current && this.draft?.id === agent.id && this.draft.expires > now)
        return agent;
      return current ?? null;
    });
    for (const a of agents) {
      if (ignored.has(a.id)) continue;
      const fingerprint = a.runId ?? a.updatedAt;
      const previous = this.previousRuns.get(a.id);
      if (previous !== undefined && a.runId && previous !== a.runId)
        this.pulses.set(a.id, now + 1500);
      this.previousRuns.set(a.id, fingerprint);
      if (
        this.excluded.get(a.id) === fingerprint ||
        this.assignments.some((s) => s?.id === a.id)
      )
        continue;
      this.excluded.delete(a.id);
      const index = this.assignments.findIndex((s) => s === null);
      if (index >= 0) this.assignments[index] = a;
    }
    this.overflow = agents.filter(
      (a) =>
        !this.assignments.some((s) => s?.id === a.id) &&
        this.excluded.get(a.id) !== (a.runId ?? a.updatedAt),
    ).length;
    for (const [id, until] of this.pulses)
      if (until <= now) this.pulses.delete(id);
    if (this.draft && this.draft.expires <= now) {
      if (this.draft.id.startsWith("draft:"))
        this.assignments = this.assignments.map((a) =>
          a?.id === this.draft?.id ? null : a,
        );
      this.draft = null;
    }
    // Bound history when sessions are archived or deleted.
    for (const id of this.previousRuns.keys())
      if (!byId.has(id)) this.previousRuns.delete(id);
    for (const id of this.excluded.keys())
      if (!byId.has(id)) this.excluded.delete(id);
  }
  reserve(id: string, title = "New agent", now = Date.now()) {
    if (this.draft?.id !== id && this.draft?.id.startsWith("draft:")) {
      this.assignments = this.assignments.map((a) =>
        a?.id === this.draft?.id ? null : a,
      );
    }
    this.draft = { id, title, expires: now + 4000 };
    if (!this.assignments.some((s) => s?.id === id)) {
      const index = this.assignments.findIndex((s) => s === null);
      if (index >= 0)
        this.assignments[index] = {
          id,
          title,
          project: "Draft",
          status: "drafting",
          updatedAt: new Date(now).toISOString(),
        };
    }
  }
  submitted(id: string, promotedId?: string, now = Date.now()) {
    if (promotedId)
      this.assignments = this.assignments.map((a) =>
        a?.id === id ? { ...a, id: promotedId, status: "working" } : a,
      );
    this.pulses.set(promotedId ?? id, now + 1500);
    if (this.draft?.id === id) this.draft = null;
  }
  release(index: number) {
    const agent = this.assignments[index];
    if (agent) this.excluded.set(agent.id, agent.runId ?? agent.updatedAt);
    if (this.draft?.id === agent?.id) this.draft = null;
    this.assignments[index] = null;
  }
  slots(now = Date.now(), brightness = 0.55): Slot[] {
    return TOP_ROW.map((key, i) => {
      const agent = this.assignments[i] ?? null;
      const status = agent
        ? (this.draft?.id === agent.id && this.draft.expires > now) ||
          (this.pulses.get(agent.id) ?? 0) > now
          ? "drafting"
          : agent.status
        : "unassigned";
      return {
        key: key.label,
        led: key.led,
        agent,
        status,
        color: colorFor(status, now - this.startedAt, brightness),
      };
    });
  }
  frame(
    now = Date.now(),
    brightness = 0.55,
    bodyEffect: BodyEffect = DEFAULT_BODY_EFFECT,
  ): Buffer {
    const result = Buffer.alloc(512);
    for (let id = 0; id < 128; id++) result[id * 4] = id;
    for (const key of LAYOUT.flat()) {
      const value = Math.round(255 * brightness);
      result.set([value, value, value], key.led * 4 + 1);
    }
    for (const key of BODY_KEYS)
      result.set(
        effectColor(bodyEffect, key, now, brightness),
        key.led * 4 + 1,
      );
    for (const slot of this.slots(now, brightness))
      result.set(slot.color, slot.led * 4 + 1);
    return result;
  }
}
