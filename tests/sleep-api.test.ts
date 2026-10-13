import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
test("CLI sleep/status/wake, API auth, input wake and abrupt server exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-board-sleep-api-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const display = join(dir, "display");
  writeFileSync(display, "on");
  const pidFile = join(dir, "inhibitor-pid");
  writeFileSync(
    join(bin, "hyprctl"),
    `#!/bin/sh
if [ "$1" = "-j" ]; then
  if [ "$(cat "$DISPLAY_STATE")" = on ]; then echo '[{"dpmsStatus":true}]'; else echo '[{"dpmsStatus":false}]'; fi
elif [ "$1" = dispatch ]; then
  case "$2" in *'"off"'*) echo off > "$DISPLAY_STATE" ;; *) echo on > "$DISPLAY_STATE" ;; esac
  echo ok
else echo ok; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "systemd-inhibit"),
    `#!/bin/sh
echo $$ > "$INHIBITOR_PID"
shift 4
exec "$@"
`,
    { mode: 0o755 },
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    T3_BOARD_PORT: String(port),
    T3_BOARD_STATE: dir,
    T3_BOARD_DEMO: "1",
    T3_BOARD_AUTOSTART: "0",
    HYPRLAND_INSTANCE_SIGNATURE: "test",
    DISPLAY_STATE: display,
    INHIBITOR_PID: pidFile,
  };
  const child = spawn(process.execPath, ["src/server.ts"], {
    env,
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  const cli = async (action: string) =>
    JSON.parse(
      (
        await exec(process.execPath, ["src/control.ts", action], {
          env,
          timeout: 6000,
        })
      ).stdout,
    );
  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error("Sleep API condition timed out");
  }
  try {
    await waitFor(async () => {
      try {
        return (await fetch(origin + "/api/state")).ok;
      } catch {
        return false;
      }
    });
    assert.equal(
      (await fetch(origin + "/api/sleep", { method: "POST", body: "{}" }))
        .status,
      401,
    );
    assert.equal((await cli("status")).agentSleep, false);
    assert.equal((await cli("sleep")).agentSleep, true);
    assert.equal(readFileSync(display, "utf8").trim(), "off");
    assert.equal((await cli("sleep")).agentSleep, true);
    writeFileSync(display, "on"); // Compositor wakes from keyboard/mouse input.
    await waitFor(async () => !(await cli("status")).agentSleep);
    assert.equal((await cli("sleep")).agentSleep, true);
    assert.equal((await cli("wake")).agentSleep, false);
    assert.equal(readFileSync(display, "utf8").trim(), "on");
    assert.equal((await cli("sleep")).agentSleep, true);
    const helper = Number(readFileSync(pidFile, "utf8"));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await waitFor(
      async () =>
        !existsSync(`/proc/${helper}/stat`) ||
        readFileSync(`/proc/${helper}/stat`, "utf8")
          .split(") ")[1]
          .startsWith("Z"),
    );
    // Native input wake stays configured in Hyprland; no server is needed.
    writeFileSync(display, "on");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
