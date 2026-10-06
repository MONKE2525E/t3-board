// This runs in T3's main process, before its original boot module.
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:net");
const { readFileSync, mkdirSync, chmodSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { trackComposer } = require("./composer.cjs");

const runtime =
  process.env.T3_BOARD_STATE || join(homedir(), ".local/state/t3-board");
const socketPath = join(runtime, "desktop.sock");
const environmentPath = join(
  process.env.T3CODE_HOME || join(homedir(), ".t3"),
  "userdata/environment-id",
);
let server;
let inFlight = false;

async function jump(threadId) {
  if (inFlight) throw new Error("A thread jump is already in progress.");
  const window = BrowserWindow.getAllWindows().find(
    (candidate) =>
      !candidate.isDestroyed() &&
      candidate.webContents.getURL().startsWith("t3code://app/"),
  );
  if (!window) throw new Error("Open the T3 Code main window first.");
  const environmentId = readFileSync(environmentPath, "utf8").trim();
  if (
    !/^[a-zA-Z0-9_-]{1,160}$/.test(environmentId) ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(threadId)
  )
    throw new Error("Invalid thread destination.");
  const path = `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  inFlight = true;
  try {
    // TanStack exposes the active router on the renderer. Use its normal
    // navigation so T3 resolves the project, checkout and selected thread.
    const opened = await window.webContents.executeJavaScript(`(async () => {
      const destination = ${JSON.stringify(path)};
      const router = window.__TSR_ROUTER__;
      if (!router || typeof router.navigate !== "function")
        throw new Error("This T3 version does not expose its navigation router.");
      await router.navigate({ to: destination });
      return router.state.location.pathname === destination;
    })()`);
    if (!opened) throw new Error("T3 could not open the assigned thread.");
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return { ok: true, pid: process.pid };
  } finally {
    inFlight = false;
  }
}

function start() {
  if (server || !app.hasSingleInstanceLock()) return;
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  // The primary T3 instance exclusively owns this socket. Its previous process
  // can leave a stale inode after a crash.
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  server = createServer((socket) => {
    socket.setTimeout(4000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        try {
          const request = JSON.parse(input);
          if (request.type !== "jump" || typeof request.threadId !== "string")
            throw new Error("Invalid navigation request.");
          socket.end(JSON.stringify(await jump(request.threadId)) + "\n");
        } catch (error) {
          socket.end(
            JSON.stringify({ ok: false, error: error.message }) + "\n",
          );
        }
      })();
    });
    socket.on("error", () => {});
  });
  server.on("error", (error) =>
    console.error("T3 Board navigation:", error.message),
  );
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
}

app.on("browser-window-created", (_event, window) => {
  let stopComposer;
  window.webContents.on("did-finish-load", () => {
    if (window.webContents.getURL().startsWith("t3code://app/")) {
      try {
        start();
        stopComposer?.();
        stopComposer = trackComposer(
          window,
          `http://127.0.0.1:${Number(process.env.T3_BOARD_PORT ?? 47831)}`,
        );
      } catch (error) {
        console.error("T3 Board navigation:", error.message);
      }
    }
  });
  window.on("closed", () => stopComposer?.());
});
app.on("will-quit", () => {
  if (!server) return;
  server.close();
  try {
    unlinkSync(socketPath);
  } catch {
    /* Already removed. */
  }
});
