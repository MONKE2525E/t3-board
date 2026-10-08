import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("desktop navigation opens encoded T3 thread IDs and rejects synthetic destinations", async () => {
  const destinations: string[] = [];
  let focused = 0;
  const router = {
    state: { location: { pathname: "/" } },
    navigate: async ({ to }: { to: string }) => {
      destinations.push(to);
      router.state.location.pathname = to;
    },
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => {},
    focus: () => focused++,
    webContents: {
      getURL: () => "t3code://app/",
      executeJavaScript: (script: string) =>
        runInNewContext(script, { window: { __TSR_ROUTER__: router } }),
    },
  };
  const jump = runInNewContext(
    readFileSync(
      new URL("../desktop/integration.cjs", import.meta.url),
      "utf8",
    ) + "\njump;",
    {
      require: (name: string) => {
        if (name === "electron")
          return {
            app: { on: () => {} },
            BrowserWindow: { getAllWindows: () => [window] },
          };
        if (name === "node:fs") return { readFileSync: () => "fixture-env" };
        if (name === "node:path")
          return { join: (...parts: string[]) => parts.join("/") };
        if (name === "node:os") return { homedir: () => "/fixture" };
        return {};
      },
      process: { env: {}, pid: 123 },
    },
  );
  for (const id of ["legacy", "thread:created-a", "mcp:created-b"]) {
    assert.equal((await jump(id)).ok, true);
    assert.equal(destinations.at(-1), `/fixture-env/${encodeURIComponent(id)}`);
  }
  for (const id of [
    "draft:a",
    "native:a",
    "demo:a",
    "mcp:",
    "thread:a/b",
    "thread:a:b",
    "mcp:" + "a".repeat(157),
  ]) {
    await assert.rejects(jump(id), /Invalid thread destination/);
  }
  assert.equal(destinations.length, 3);
  assert.equal(focused, 3);
});
