import { createConnection } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { assignedThread } from "./navigation.ts";
import type { Slot } from "./model.ts";

const origin = "http://127.0.0.1:47831";
const action = process.argv[2] ?? "status";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(origin + path, {
    ...init,
    signal: AbortSignal.timeout(6000),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(String(data.error ?? "T3 Board is unavailable."));
  return data;
}

try {
  if (action === "jump") {
    const state = await request("/api/state");
    if (state.demo || !(state.source as { connected: boolean }).connected)
      throw new Error("Live T3 assignments are unavailable.");
    const threadId = assignedThread(
      state.slots as Slot[],
      process.argv[3] ?? "",
    );
    if (!threadId) process.exit(0);
    const response = await new Promise<{
      ok: boolean;
      error?: string;
      pid: number;
    }>((resolve, reject) => {
      const socket = createConnection(
        join(
          process.env.T3_BOARD_STATE ??
            join(homedir(), ".local/state/t3-board"),
          "desktop.sock",
        ),
      );
      socket.setTimeout(4500, () =>
        socket.destroy(new Error("T3 navigation timed out.")),
      );
      let body = "";
      socket.on("connect", () =>
        socket.write(JSON.stringify({ type: "jump", threadId }) + "\n"),
      );
      socket.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096)
          socket.destroy(new Error("Invalid navigation response."));
        else if (body.includes("\n")) {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
          socket.end();
        }
      });
      socket.on("error", reject);
      socket.on("end", () => {
        if (!body.includes("\n"))
          reject(new Error("T3 navigation disconnected."));
      });
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED")
        throw error;
      throw new Error(
        "Quit T3 Code and reopen it from its launcher to enable keyboard navigation.",
      );
    });
    if (!response.ok)
      throw new Error(response.error ?? "Thread navigation failed.");
    if (
      process.env.HYPRLAND_INSTANCE_SIGNATURE &&
      Number.isSafeInteger(response.pid) &&
      response.pid > 0
    )
      execFileSync(
        "hyprctl",
        ["dispatch", `hl.dsp.focus({window="pid:${response.pid}"})`],
        { stdio: "ignore", timeout: 2000 },
      );
    console.log("Opened assigned thread.");
    process.exit(0);
  }
  if (action !== "status") {
    if (!["toggle", "start", "stop"].includes(action))
      throw new Error(
        "Usage: t3-boardctl [status|toggle|start|stop|jump Esc|F1..F12|Del]",
      );
    const state = await request("/api/summary");
    const next =
      action === "toggle" ? (state.lightingEnabled ? "stop" : "start") : action;
    const session = await request("/api/session");
    await request("/api/" + next, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  }
  console.log(JSON.stringify(await request("/api/summary")));
} catch (error) {
  if (action === "jump") {
    try {
      execFileSync(
        "notify-send",
        [
          "T3 Board",
          error instanceof Error ? error.message : "Thread navigation failed.",
        ],
        { stdio: "ignore", timeout: 1000 },
      );
    } catch {
      /* A terminal still receives the error below. */
    }
  }
  console.error(
    error instanceof Error ? error.message : "T3 Board is unavailable.",
  );
  process.exitCode = 1;
}
