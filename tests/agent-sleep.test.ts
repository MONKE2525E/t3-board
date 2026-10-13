import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSleep, type SleepBackend } from "../src/agent-sleep.ts";

function fixture() {
  const calls: string[] = [];
  let awake = false,
    alive = true,
    failOff = false,
    failOn = false,
    failInhibit = false;
  const backend: SleepBackend = {
    async inhibit() {
      calls.push("inhibit");
      if (failInhibit) throw new Error("denied");
      return {
        alive: () => alive,
        async release() {
          calls.push("release");
        },
      };
    },
    async displays(on) {
      calls.push(on ? "on" : "off");
      if (on ? failOn : failOff) throw new Error("DPMS failed");
    },
    async displaysAwake() {
      return awake;
    },
  };
  const sleep = new AgentSleep(backend, async () => {
    calls.push("restore");
  });
  return {
    sleep,
    calls,
    wakeInput: () => {
      awake = true;
    },
    loseInhibitor: () => {
      alive = false;
    },
    failOff: () => {
      failOff = true;
    },
    failOn: (value: boolean) => {
      failOn = value;
    },
    failInhibit: () => {
      failInhibit = true;
    },
  };
}

test("sleep holds the inhibitor until input wake; repeated commands are idempotent", async () => {
  const f = fixture();
  await Promise.all([f.sleep.sleep(), f.sleep.sleep()]);
  assert.equal(f.sleep.active, true);
  assert.deepEqual(f.calls, ["inhibit", "off"]);
  await f.sleep.check();
  assert.deepEqual(f.calls, ["inhibit", "off"]);
  f.wakeInput();
  await f.sleep.check();
  assert.equal(f.sleep.active, false);
  assert.deepEqual(f.calls, ["inhibit", "off", "on", "release", "restore"]);
  await f.sleep.wake();
  assert.equal(f.calls.filter((call) => call === "release").length, 1);
});
test("failed inhibition leaves displays alone; failed DPMS rolls back", async () => {
  const denied = fixture();
  denied.failInhibit();
  await assert.rejects(denied.sleep.sleep(), /denied/);
  assert.equal(denied.sleep.active, false);
  assert.deepEqual(denied.calls, ["inhibit"]);
  const f = fixture();
  f.failOff();
  await assert.rejects(f.sleep.sleep(), /DPMS failed/);
  assert.equal(f.sleep.active, false);
  assert.deepEqual(f.calls, ["inhibit", "off", "on", "release", "restore"]);
});
test("wake failure retains the lock and can be retried; inhibitor loss wakes displays", async () => {
  const f = fixture();
  await f.sleep.sleep();
  f.failOn(true);
  await assert.rejects(f.sleep.wake(), /DPMS failed/);
  assert.equal(f.sleep.active, true);
  assert.equal(f.calls.includes("release"), false);
  f.failOn(false);
  await f.sleep.wake();
  assert.equal(f.sleep.active, false);
  const lost = fixture();
  await lost.sleep.sleep();
  lost.loseInhibitor();
  await lost.sleep.check();
  assert.equal(lost.sleep.active, false);
  assert.deepEqual(lost.calls, ["inhibit", "off", "on", "release", "restore"]);
});
test("wake queued while sleep is starting restores displays and releases once", async () => {
  const f = fixture();
  await Promise.all([f.sleep.sleep(), f.sleep.wake(), f.sleep.check()]);
  assert.equal(f.sleep.active, false);
  assert.deepEqual(f.calls, ["inhibit", "off", "on", "release", "restore"]);
});

test("failed sleep releases the lock even if rollback DPMS also fails", async () => {
  const f = fixture();
  f.failOff();
  f.failOn(true);
  await assert.rejects(f.sleep.sleep(), /DPMS failed/);
  assert.equal(f.sleep.active, false);
  assert.deepEqual(f.calls, ["inhibit", "off", "on", "release", "restore"]);
});
