import type { Slot } from "./model.ts";

export function assignedThread(slots: Slot[], key: string): string | null {
  const normalized = key === "Escape" ? "Esc" : key === "Delete" ? "Del" : key;
  if (!/^(Esc|F(?:[1-9]|1[0-2])|Del)$/.test(normalized))
    throw new Error("Invalid assigned key");
  const agent = slots.find((slot) => slot.key === normalized)?.agent;
  if (!agent || !/^[a-zA-Z0-9_-]{1,160}$/.test(agent.id)) return null;
  return agent.id;
}
