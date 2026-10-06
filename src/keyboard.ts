import HID from "node-hid";
import { setTimeout as delay } from "node:timers/promises";
import { Board } from "./model.ts";

export interface LightingHandle {
  sendFeatureReport(data: Buffer): Promise<number>;
  getFeatureReport(id: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}
export interface KeyboardBackend {
  find(): Promise<string | undefined>;
  open(path: string): Promise<LightingHandle>;
}
const hardware: KeyboardBackend = {
  async find() {
    return (await HID.devicesAsync(0x0c45, 0x8009)).find(
      (d) =>
        d.product === "AK820" &&
        d.interface === 3 &&
        d.usagePage === 0xff13 &&
        d.usage === 1,
    )?.path;
  },
  open: (path) => HID.HIDAsync.open(path),
};

export interface KeyboardState {
  perKeyVerified: boolean;
  connected: boolean;
  streaming: boolean;
  model: string;
  protocol: string;
  error: string | null;
  frames: number;
  lastFrameAt: number | null;
  frameMs: number | null;
}

// Independently implemented SONiX realtime frame transport. Protocol references in THIRD_PARTY.md.
export function frameReports(frame: Buffer): Buffer[] {
  if (frame.length !== 512)
    throw new Error("An AK820 frame must contain exactly 128 LED records.");
  const command = Buffer.alloc(65);
  command[1] = 4;
  command[2] = 0x20;
  command[9] = 8;
  const packets = [command];
  for (let start = 0; start < 512; start += 64) {
    const packet = Buffer.alloc(65);
    frame.copy(packet, 1, start, start + 64);
    packets.push(packet);
  }
  const apply = Buffer.alloc(65);
  apply[1] = 4;
  apply[2] = 2;
  packets.push(apply);
  return packets;
}
export class Keyboard {
  state: KeyboardState = {
    perKeyVerified: true,
    connected: false,
    streaming: false,
    model: "AJAZZ AK820 Pro",
    protocol: "SONiX FF13",
    error: null,
    frames: 0,
    lastFrameAt: null,
    frameMs: null,
  };
  private backend: KeyboardBackend;
  private handle: LightingHandle | null = null;
  private pending: Buffer | null = null;
  private pumping: Promise<void> | null = null;

  constructor(backend: KeyboardBackend = hardware) {
    this.backend = backend;
  }

  private async send(payload: Buffer, waitMs = 35) {
    if (!this.handle) throw new Error("Keyboard disconnected.");
    const packet = Buffer.alloc(65);
    payload.copy(packet, 1, 0, 64);
    await this.handle.sendFeatureReport(packet);
    await delay(waitMs);
  }
  private async command(code: number, flag = 0, read = true) {
    const payload = Buffer.alloc(64);
    payload[0] = 4;
    payload[1] = code;
    payload[8] = flag;
    await this.send(payload);
    if (read) {
      const reply = await this.handle!.getFeatureReport(0, 65);
      if (reply[1] !== 4 || reply[2] !== code || reply[4] !== 1)
        throw new Error(
          `Keyboard rejected lighting command ${code.toString(16)}.`,
        );
    }
  }
  async connect(brightness = 0.55) {
    if (this.handle) return;
    const path = await this.backend.find();
    if (!path)
      throw new Error(
        "AK820 Pro not found. Connect it with a data cable in wired mode.",
      );
    try {
      this.handle = await this.backend.open(path);
      // Select the vendor's custom mode once. Its saved palette is the fallback
      // after realtime updates stop, so it contains no agent status colors.
      await this.command(0x18);
      await this.command(0x13, 1);
      const mode = Buffer.alloc(64);
      mode[0] = 0x80;
      mode[9] = 5;
      mode[14] = 0xaa;
      mode[15] = 0x55;
      await this.send(mode);
      await this.command(2);
      await this.command(0xf0, 0, false);
      await this.command(0x18);
      await this.command(0x23, 9);
      const palette = Buffer.alloc(576);
      new Board().frame(Date.now(), brightness).copy(palette);
      palette[574] = 0xaa;
      palette[575] = 0x55;
      for (let start = 0; start < 576; start += 64)
        await this.send(palette.subarray(start, start + 64));
      await this.command(2);
      await this.command(0xf0, 0, false);
      this.state.connected = true;
      this.state.error = null;
    } catch {
      await this.disconnect();
      this.state.error =
        "Could not open or verify the lighting interface. Check wired mode and the keyboard access rule.";
      throw new Error(this.state.error);
    }
  }
  queue(frame: Buffer) {
    if (!this.handle || !this.state.streaming) return;
    this.pending = Buffer.from(frame);
    if (!this.pumping)
      this.pumping = this.pump().finally(() => {
        this.pumping = null;
      });
  }
  private async pump() {
    try {
      while (this.pending && this.handle && this.state.streaming) {
        const frame = this.pending;
        this.pending = null;
        // Even unchanged frames are keepalives. Otherwise the saved palette returns.
        const start = performance.now();
        const packets = frameReports(frame);
        await this.handle.sendFeatureReport(packets[0]!);
        await delay(5);
        const ready = await this.handle.getFeatureReport(0, 65);
        if (ready[1] !== 4 || ready[2] !== 0x20 || ready[4] !== 1)
          throw new Error("Keyboard rejected the LED frame preamble.");
        for (const packet of packets.slice(1, 9)) {
          await this.handle.sendFeatureReport(packet);
          await delay(2);
        }
        await delay(5);
        await this.handle.sendFeatureReport(packets[9]!);
        await delay(5);
        const applied = await this.handle.getFeatureReport(0, 65);
        if (applied[1] !== 4 || applied[2] !== 2 || applied[4] !== 1)
          throw new Error("Keyboard did not acknowledge the LED frame.");
        this.state.frames++;
        this.state.lastFrameAt = Date.now();
        this.state.frameMs = Math.round(performance.now() - start);
      }
    } catch (error) {
      this.state.error =
        error instanceof Error ? error.message : "Keyboard disconnected.";
      this.state.streaming = false;
      this.state.connected = false;
      this.pending = null;
      if (this.handle) {
        await this.handle.close().catch(() => {});
        this.handle = null;
      }
    }
  }
  async disconnect() {
    this.state.streaming = false;
    this.pending = null;
    await this.pumping;
    if (this.handle) await this.handle.close().catch(() => {});
    this.handle = null;
    this.state.connected = false;
  }
}
