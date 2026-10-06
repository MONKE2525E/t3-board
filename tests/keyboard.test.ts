import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Keyboard, type KeyboardBackend } from "../src/keyboard.ts";
import { Board } from "../src/model.ts";

test("steady colors keep refreshing, and a rejected frame closes the device", async () => {
  const sent: Buffer[] = [];
  let command = 0;
  let reject = false;
  let closed = false;
  const backend: KeyboardBackend = {
    async find() {
      return "/fake/lighting";
    },
    async open() {
      return {
        async sendFeatureReport(packet) {
          sent.push(Buffer.from(packet));
          if (packet[1] === 4) command = packet[2]!;
          return packet.length;
        },
        async getFeatureReport() {
          const reply = Buffer.alloc(65);
          reply.set([0, 4, command, 0, reject ? 0xff : 1]);
          return reply;
        },
        async close() {
          closed = true;
        },
      };
    },
  };
  const keyboard = new Keyboard(backend);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition() && Date.now() < deadline) await delay(5);
    assert.ok(condition(), "lighting operation timed out");
  };
  try {
    await keyboard.connect(0.5);
    keyboard.state.streaming = true;
    const frame = new Board().frame(Date.now(), 0.5);
    keyboard.queue(frame);
    await until(() => keyboard.state.frames === 1);
    keyboard.queue(frame);
    await until(() => keyboard.state.frames === 2);
    assert.equal(sent.filter((p) => p[1] === 4 && p[2] === 0x20).length, 2);
    // The persistent fallback has no agent colors. Animation frames use the realtime header.
    assert.equal(sent.filter((p) => p[1] === 4 && p[2] === 0x23).length, 1);
    const mode = sent.find((p) => p[1] === 0x80)!;
    assert.deepEqual([mode[10], mode[15], mode[16]], [5, 0xaa, 0x55]);
    reject = true;
    keyboard.queue(frame);
    await until(() => closed);
    assert.equal(keyboard.state.streaming, false);
    assert.equal(keyboard.state.connected, false);
    assert.match(keyboard.state.error!, /rejected/);
    const count = sent.length;
    keyboard.queue(frame);
    await delay(10);
    assert.equal(sent.length, count);
  } finally {
    await keyboard.disconnect();
  }
});
