import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BODY_EFFECT } from "../src/effects.ts";
import { fileURLToPath } from "node:url";

test("body-effect API authenticates, validates, saves, and survives a service restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-effects-api-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = "";
  async function start() {
    output = "";
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../src/server.ts", import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          T3_BOARD_PORT: String(port),
          T3_BOARD_STATE: dir,
          T3_BOARD_DEMO: "1",
          T3_BOARD_AUTOSTART: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.on("data", (data) => {
      output += data;
    });
    child.stderr!.on("data", (data) => {
      output += data;
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${origin}/api/state`)).ok) return;
      } catch {
        /* Server starting. */
      }
      await delay(25);
    }
    throw new Error(`Server never became ready: ${output}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  const read = async () => await (await fetch(`${origin}/api/state`)).json();
  const post = (body: unknown, token?: string) =>
    fetch(`${origin}/api/body-effect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    await start();
    assert.deepEqual((await read()).bodyEffect, DEFAULT_BODY_EFFECT);
    const { token } = await (await fetch(`${origin}/api/session`)).json();
    const effect = {
      ...DEFAULT_BODY_EFFECT,
      mode: "rainbow",
      colorA: "#FF3300",
      colorB: "#0088ff",
      direction: "diagonal",
      speed: 2,
    };
    assert.equal((await post(effect)).status, 401);
    assert.deepEqual((await read()).bodyEffect, DEFAULT_BODY_EFFECT);
    assert.equal((await post(effect, token)).status, 200);
    const normalized = { ...effect, colorA: "#ff3300" };
    assert.deepEqual((await read()).bodyEffect, normalized);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).bodyEffect,
      normalized,
    );
    assert.equal((await post({ ...effect, colorB: "bad" }, token)).status, 400);
    assert.deepEqual((await read()).bodyEffect, normalized);
    const crossOrigin = await fetch(`${origin}/api/body-effect`, {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(effect),
    });
    assert.equal(crossOrigin.status, 403);
    await stop();
    await start();
    assert.deepEqual((await read()).bodyEffect, normalized);
    assert.equal((await read()).brightness, 0.55);
    assert.equal((await post(DEFAULT_BODY_EFFECT, token)).status, 401);
    const fresh = await (await fetch(`${origin}/api/session`)).json();
    for (const mode of ["spectrum", "chase"]) {
      assert.equal((await post({ ...effect, mode }, fresh.token)).status, 200);
      assert.equal((await read()).bodyEffect.mode, mode);
    }
    assert.equal((await post(DEFAULT_BODY_EFFECT, fresh.token)).status, 200);
    assert.deepEqual((await read()).bodyEffect, DEFAULT_BODY_EFFECT);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
