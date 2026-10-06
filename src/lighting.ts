import type { Keyboard } from "./keyboard.ts";

type Device = Pick<Keyboard, "state" | "connect" | "disconnect">;

export class Lighting {
  enabled: boolean;
  private device: Device;
  private available: () => boolean;
  private brightness: () => number;
  private connecting: Promise<void> | null = null;

  constructor(
    device: Device,
    available: () => boolean,
    brightness: () => number,
    enabled = false,
  ) {
    this.device = device;
    this.available = available;
    this.brightness = brightness;
    this.enabled = enabled;
  }

  ensure(): Promise<void> {
    if (!this.enabled || !this.available() || this.device.state.streaming)
      return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.device.connect(this.brightness());
      if (this.enabled && this.available()) this.device.state.streaming = true;
      else await this.device.disconnect();
    })()
      .catch((error: unknown) => {
        this.device.state.error =
          error instanceof Error ? error.message : "Keyboard unavailable.";
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async start() {
    this.enabled = true;
    await this.ensure();
  }

  async pause() {
    await this.connecting?.catch(() => {});
    await this.device.disconnect();
  }

  async stop() {
    this.enabled = false;
    await this.pause();
  }
}
