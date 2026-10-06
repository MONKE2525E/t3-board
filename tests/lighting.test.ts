import { test } from "node:test";
import assert from "node:assert/strict";
import { Lighting } from "../src/lighting.ts";
import type { KeyboardState } from "../src/keyboard.ts";

test("autostart retries an absent keyboard, pauses for unavailable status, and honors Stop", async () => {
  const state = {
    streaming: false,
    connected: false,
    error: null,
  } as KeyboardState;
  let present = false,
    available = true,
    opens = 0;
  const device = {
    state,
    async connect(brightness: number) {
      opens++;
      assert.equal(brightness, 0.55);
      if (!present) throw new Error("Keyboard missing");
      state.connected = true;
      state.error = null;
    },
    async disconnect() {
      state.connected = false;
      state.streaming = false;
    },
  };
  const lighting = new Lighting(
    device,
    () => available,
    () => 0.55,
    true,
  );
  await assert.rejects(lighting.ensure(), /missing/);
  assert.equal(state.error, "Keyboard missing");
  present = true;
  await lighting.ensure();
  assert.equal(state.streaming, true);
  await lighting.ensure();
  assert.equal(opens, 2);
  available = false;
  await lighting.pause();
  await lighting.ensure();
  assert.equal(opens, 2);
  available = true;
  await lighting.ensure();
  assert.equal(state.streaming, true);
  await lighting.stop();
  await lighting.ensure();
  assert.equal(opens, 3);
  assert.equal(state.streaming, false);
  await lighting.start();
  assert.equal(state.streaming, true);
});

test("Stop during connection never resumes lighting or opens the device twice", async () => {
  const state = {
    streaming: false,
    connected: false,
    error: null,
  } as KeyboardState;
  let finish!: () => void,
    opens = 0;
  const device = {
    state,
    async connect() {
      opens++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      state.connected = true;
    },
    async disconnect() {
      state.connected = false;
      state.streaming = false;
    },
  };
  const lighting = new Lighting(
    device,
    () => true,
    () => 0.55,
    true,
  );
  const first = lighting.ensure();
  const duplicate = lighting.ensure();
  const stopped = lighting.stop();
  finish();
  await Promise.all([first, duplicate, stopped]);
  assert.equal(opens, 1);
  assert.equal(state.streaming, false);
  assert.equal(state.connected, false);
});
