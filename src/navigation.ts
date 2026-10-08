import type { Slot } from "./model.ts";

export function assignedThread(slots: Slot[], key: string): string | null {
  const normalized = key === "Escape" ? "Esc" : key === "Delete" ? "Del" : key;
  if (!/^(Esc|F(?:[1-9]|1[0-2])|Del)$/.test(normalized))
    throw new Error("Invalid assigned key");
  const agent = slots.find((slot) => slot.key === normalized)?.agent;
  // T3-created and MCP-created threads have namespaced IDs. Synthetic board
  // agents (draft:, demo:, native:) still have no navigable thread.
  if (
    !agent ||
    !/^(?=.{1,160}$)(?:(?:thread|mcp):)?[a-zA-Z0-9_-]+$/.test(agent.id)
  )
    return null;
  return agent.id;
}
