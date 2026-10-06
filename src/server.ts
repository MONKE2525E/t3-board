import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Board, LAYOUT } from "./model.ts";
import { Keyboard } from "./keyboard.ts";
import { Lighting } from "./lighting.ts";
import { LocalT3Source, demoAgents } from "./source.ts";
import {
  DEFAULT_BODY_EFFECT,
  validateBodyEffect,
  type BodyEffect,
} from "./effects.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.T3_BOARD_PORT ?? 47831);
const origin = `http://127.0.0.1:${port}`;
const runtime =
  process.env.T3_BOARD_STATE ?? join(homedir(), ".local", "state", "t3-board");
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const settingsPath = join(runtime, "settings.json");
let brightness = 0.55;
let bodyEffect: BodyEffect = { ...DEFAULT_BODY_EFFECT };
let lightingEnabled = process.env.T3_BOARD_AUTOSTART === "1";
try {
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof s.brightness === "number")
    brightness = Math.max(0, Math.min(1, s.brightness));
  if (typeof s.lightingEnabled === "boolean")
    lightingEnabled = s.lightingEnabled;
  if (s.bodyEffect) {
    try {
      bodyEffect = validateBodyEffect(s.bodyEffect);
    } catch {
      /* Keep white when saved effects are invalid. */
    }
  }
} catch {
  /* First launch. */
}
const token = randomBytes(32).toString("hex");
const board = new Board();
const keyboard = new Keyboard();
const source = new LocalT3Source();
let demo = process.env.T3_BOARD_DEMO === "1";
let sourceError: string | null = null;
let lastReadAt: number | null = null;
let bridgeSeenAt: number | null = null;
let closing = false;
const lighting = new Lighting(
  keyboard,
  () => !closing && !demo && !sourceError,
  () => brightness,
  lightingEnabled,
);
function saveSettings() {
  writeFileSync(
    settingsPath + ".tmp",
    JSON.stringify({
      brightness,
      lightingEnabled: lighting.enabled,
      bodyEffect,
    }),
    { mode: 0o600 },
  );
  renameSync(settingsPath + ".tmp", settingsPath);
}
const examples = demoAgents();
function refresh() {
  try {
    if (demo) board.reconcile(examples);
    else board.reconcile(source.read(), Date.now(), source.ignoredThreadIds);
    sourceError = null;
    lastReadAt = Date.now();
  } catch {
    sourceError =
      "T3 status is unavailable. Lighting paused. Check that T3 Code uses the supported local database.";
    keyboard.state.streaming = false;
  }
}
refresh();
const poll = setInterval(refresh, 750);
const reconnect = setInterval(
  () => void lighting.ensure().catch(() => {}),
  5000,
);
void lighting.ensure().catch(() => {});
const render = setInterval(() => {
  if (!demo && !sourceError)
    keyboard.queue(board.frame(Date.now(), brightness, bodyEffect));
}, 100);
const state = () => ({
  demo,
  brightness,
  bodyEffect,
  lightingEnabled: lighting.enabled,
  slots: board.slots(Date.now(), brightness),
  layout: LAYOUT,
  overflow: board.overflow,
  keyboard: keyboard.state,
  source: { connected: !sourceError, lastReadAt, error: sourceError },
  bridge: {
    connected: !!bridgeSeenAt && Date.now() - bridgeSeenAt < 5000,
    lastSeenAt: bridgeSeenAt,
  },
});
function authorized(value: string | undefined) {
  if (!value) return false;
  const candidate = Buffer.from(value.replace(/^Bearer /, ""));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? "/", origin);
  const bridge = url.pathname === "/api/bridge";
  const remoteOrigin = req.headers.origin;
  const ownOrigin =
    !remoteOrigin ||
    remoteOrigin === origin ||
    remoteOrigin === `http://localhost:${port}`;
  const composerOrigin =
    remoteOrigin === "t3code://app" ||
    remoteOrigin === "t3code-dev://app" ||
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(remoteOrigin ?? "");
  // Cross-origin composer events need the session token. Status and device controls are same-origin only.
  if (!ownOrigin && (!bridge || !composerOrigin)) {
    res.writeHead(403).end();
    return;
  }
  if (bridge && remoteOrigin) {
    res.setHeader("Access-Control-Allow-Origin", remoteOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const json = (value: unknown, status = 200) => {
    res
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(value));
  };
  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      json(state());
      return;
    }
    if (url.pathname === "/api/summary" && req.method === "GET") {
      const agents = board.assignments.filter((a) => a !== null);
      json({
        working: agents.filter((a) =>
          ["working", "waiting", "drafting"].includes(a.status),
        ).length,
        finished: agents.filter((a) => a.status === "done").length,
        errors: agents.filter((a) => a.status === "error").length,
        merged: agents.filter((a) => a.status === "merged").length,
        assigned: agents.length,
        overflow: board.overflow,
        lightingEnabled: lighting.enabled,
        streaming: keyboard.state.streaming,
        connected: keyboard.state.connected,
        sourceConnected: !sourceError,
        error: sourceError ?? keyboard.state.error,
      });
      return;
    }
    if (url.pathname === "/api/session" && req.method === "GET") {
      json({ token });
      return;
    }
    if (url.pathname === "/api/bridge-script" && req.method === "GET") {
      const script = readFileSync(
        join(root, "web", "composer-bridge.js"),
        "utf8",
      )
        .replace("__BOARD_ORIGIN__", origin)
        .replace("__BOARD_TOKEN__", token);
      res.writeHead(200, { "Content-Type": "text/plain" }).end(script);
      return;
    }
    if (req.method === "POST") {
      if (!authorized(req.headers.authorization)) {
        json({ error: "Unauthorized" }, 401);
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) {
          json({ error: "Request too large" }, 413);
          return;
        }
      }
      const data = JSON.parse(body || "{}") as Record<string, unknown>;
      if (bridge) {
        bridgeSeenAt = Date.now();
        if (
          typeof data.id === "string" &&
          /^[a-zA-Z0-9:_-]{1,160}$/.test(data.id)
        ) {
          if (!source.ignoredThreadIds.has(data.id)) {
            if (data.type === "draft") board.reserve(data.id);
            if (data.type === "submitted") board.submitted(data.id);
          }
          if (data.type === "clear" && board.draft?.id === data.id) {
            if (data.id.startsWith("draft:"))
              board.assignments = board.assignments.map((a) =>
                a?.id === data.id ? null : a,
              );
            board.draft = null;
          }
        }
      } else if (url.pathname === "/api/connect") {
        await keyboard.connect(brightness);
      } else if (url.pathname === "/api/start") {
        if (!keyboard.state.perKeyVerified)
          throw new Error(
            "Per-key lighting is not verified on this AK820 Pro firmware. Live status monitoring remains available.",
          );
        if (demo || sourceError)
          throw new Error("Switch to live T3 status before starting lighting.");
        const started = lighting.start();
        saveSettings();
        await started;
      } else if (url.pathname === "/api/stop") {
        await lighting.stop();
        saveSettings();
      } else if (url.pathname === "/api/demo") {
        demo = data.enabled === true;
        await lighting.pause();
        board.assignments.fill(null);
        board.excluded.clear();
        board.draft = null;
        refresh();
      } else if (url.pathname === "/api/brightness") {
        if (typeof data.value !== "number" || !Number.isFinite(data.value))
          throw new Error("Invalid brightness");
        brightness = Math.max(0, Math.min(1, data.value));
        saveSettings();
      } else if (url.pathname === "/api/body-effect") {
        const next = validateBodyEffect(data);
        const previous = bodyEffect;
        bodyEffect = next;
        try {
          saveSettings();
        } catch (error) {
          bodyEffect = previous;
          throw error;
        }
      } else if (url.pathname === "/api/release") {
        if (
          !Number.isInteger(data.index) ||
          Number(data.index) < 0 ||
          Number(data.index) > 13
        )
          throw new Error("Invalid key");
        board.release(Number(data.index));
      } else if (url.pathname === "/api/draft-demo") {
        if (!demo) throw new Error("Available in simulation only");
        board.reserve("draft:demo");
      } else if (url.pathname === "/api/submit-demo") {
        if (!demo) throw new Error("Available in simulation only");
        board.submitted("demo:0");
      } else {
        json({ error: "Not found" }, 404);
        return;
      }
      json(state());
      return;
    }
    if (req.method !== "GET") {
      json({ error: "Not found" }, 404);
      return;
    }
    const base = join(
      root,
      existsSync(join(root, "dist", "index.html")) ? "dist" : "web",
    );
    const filename = resolve(
      base,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!filename.startsWith(base + "/") || !existsSync(filename)) {
      res.writeHead(404).end();
      return;
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    res
      .writeHead(200, {
        "Content-Type": types[extname(filename)] ?? "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      })
      .end(readFileSync(filename));
  } catch (error) {
    json(
      { error: error instanceof Error ? error.message : "Action failed" },
      400,
    );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`T3 Board listening at ${origin}`),
);
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(poll);
  clearInterval(reconnect);
  clearInterval(render);
  await lighting.stop();
  source.close();
  server.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
