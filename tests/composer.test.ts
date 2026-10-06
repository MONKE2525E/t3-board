import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
const { composerSnapshot, trackComposer } = createRequire(import.meta.url)(
  "../desktop/composer.cjs",
);

test("the manual bridge reports hash-route drafts without requiring focus", () => {
  const events: { type: string; id: string }[] = [];
  let poll = () => {};
  const location = { hash: "#/draft/unsent-a", pathname: "/" };
  const field = { textContent: "Unsent fixture text" };
  runInNewContext(
    readFileSync(new URL("../web/composer-bridge.js", import.meta.url), "utf8"),
    {
      window: {},
      location,
      document: {
        querySelector: () => field,
        activeElement: null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      fetch: (_url: string, options: { body: string }) => {
        events.push(JSON.parse(options.body));
        return Promise.resolve({ ok: true });
      },
      setInterval: (callback: () => void) => {
        poll = callback;
        return 1;
      },
      clearInterval: () => {},
      console: { info: () => {} },
    },
  );
  poll();
  assert.deepEqual(events.at(-1), { type: "draft", id: "draft:unsent-a" });
  location.hash = "#/environment/thread-b";
  poll();
  assert.deepEqual(events.slice(-2), [
    { type: "clear", id: "draft:unsent-a" },
    { type: "draft", id: "thread-b" },
  ]);
  field.textContent = "";
  poll();
  assert.deepEqual(events.slice(-2), [
    { type: "clear", id: "thread-b" },
    { type: "heartbeat", id: "thread-b" },
  ]);
  assert.ok(events.every((e) => Object.keys(e).sort().join() === "id,type"));
});

test("draft presence follows T3 hash routes and survives composer blur without exposing text", () => {
  const snapshot = (hash: string, text: string) =>
    JSON.parse(
      JSON.stringify(
        runInNewContext(`(${composerSnapshot.toString()})()`, {
          window: {},
          location: { hash, pathname: "/" },
          document: {
            querySelector: () => ({ textContent: text }),
            activeElement: null,
          },
        }),
      ),
    );
  assert.deepEqual(snapshot("#/env/thread-a", "private draft text"), {
    id: "thread-a",
    hasDraft: true,
  });
  assert.deepEqual(snapshot("#/draft/new-a", "unsent text"), {
    id: "draft:new-a",
    hasDraft: true,
  });
  assert.deepEqual(snapshot("#/env/thread-a", " \n"), {
    id: "thread-a",
    hasDraft: false,
  });
  assert.equal(snapshot("#/settings", "anything"), null);
});

test("automatic composer tracking clears reservations and reconnects after token rotation", async () => {
  const events: { type: string; id: string }[] = [];
  let token = "first";
  let sessions = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/session") {
      sessions++;
      res.end(JSON.stringify({ token }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    events.push(JSON.parse(body));
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let current = { id: "thread-a", hasDraft: true };
  const stop = trackComposer(
    {
      isDestroyed: () => false,
      webContents: {
        getURL: () => "t3code://app/#/env/thread-a",
        executeJavaScript: async () => current,
      },
    },
    `http://127.0.0.1:${port}`,
  );
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3500;
    while (!predicate() && Date.now() < deadline) await delay(25);
    assert.ok(predicate(), "composer event did not arrive");
  }
  try {
    await until(() =>
      events.some((e) => e.type === "draft" && e.id === "thread-a"),
    );
    current = { id: "draft:new-b", hasDraft: true };
    await until(
      () =>
        events.some((e) => e.type === "clear" && e.id === "thread-a") &&
        events.some((e) => e.type === "draft" && e.id === "draft:new-b"),
    );
    token = "second";
    await until(() => sessions === 2);
    current = { id: "draft:new-b", hasDraft: false };
    await until(() =>
      events.some((e) => e.type === "clear" && e.id === "draft:new-b"),
    );
    assert.ok(events.every((e) => Object.keys(e).sort().join() === "id,type"));
  } finally {
    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
