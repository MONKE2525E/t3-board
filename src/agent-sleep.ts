import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export interface Inhibitor {
  release(): Promise<void>;
  alive(): boolean;
}
export interface SleepBackend {
  inhibit(): Promise<Inhibitor>;
  displays(on: boolean): Promise<void>;
  displaysAwake(): Promise<boolean>;
}

// User services may start before the compositor imports its environment.
function hyprlandEnv(): NodeJS.ProcessEnv {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`;
  const root = join(runtime, "hypr");
  const instances = readdirSync(root)
    .filter((name) => existsSync(join(root, name, ".socket.sock")))
    .sort(
      (a, b) =>
        statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs,
    );
  if (!instances[0]) throw new Error("No running Hyprland session.");
  return { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: instances[0] };
}
async function hyprctl(args: string[]) {
  const { stdout } = await exec("hyprctl", args, {
    env: hyprlandEnv(),
    timeout: 2000,
  });
  return stdout;
}
export const desktopSleep: SleepBackend = {
  async inhibit() {
    // EOF releases the lock even if the server is killed with SIGKILL.
    const child = spawn(
      "systemd-inhibit",
      [
        "--what=sleep:idle",
        "--mode=block",
        "--who=T3 Board",
        "--why=Displays off while agents keep running",
        process.execPath,
        "-e",
        "process.stdin.resume(); process.stdin.on('end',()=>process.exit()); console.log('ready');",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.on("error", () => {});
    let error = "";
    let alive = true;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        alive = false;
        resolve();
      });
      child.once("error", () => {
        alive = false;
        resolve();
      });
    });
    const release = async () => {
      child.stdin.end();
      await exited;
    };
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-4096);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Sleep inhibitor timed out.")),
          3000,
        );
        const finish = (failure?: Error) => {
          clearTimeout(timer);
          if (failure) reject(failure);
          else resolve();
        };
        child.once("error", finish);
        child.once("exit", () =>
          finish(new Error(error || "Sleep inhibitor exited.")),
        );
        child.stdout.once("data", () => finish());
      });
    } catch (error) {
      child.kill();
      await release();
      throw error;
    }
    return { release, alive: () => alive };
  },
  async displays(on) {
    if (!on) {
      // Keep compositor-owned wake enabled after a server crash as well.
      const configured = await hyprctl([
        "eval",
        "hl.config({ misc = { mouse_move_enables_dpms = true, key_press_enables_dpms = true } })",
      ]);
      if (configured.trim() !== "ok")
        throw new Error(
          configured.trim() || "Input wake configuration failed.",
        );
    }
    const output = await hyprctl([
      "dispatch",
      `hl.dsp.dpms({action="${on ? "on" : "off"}"})`,
    ]);
    if (output.trim() !== "ok")
      throw new Error(output.trim() || "DPMS dispatch failed.");
  },
  async displaysAwake() {
    const monitors = JSON.parse(await hyprctl(["-j", "monitors"])) as {
      dpmsStatus: boolean;
    }[];
    return (
      monitors.length === 0 || monitors.some((monitor) => monitor.dpmsStatus)
    );
  },
};

export class AgentSleep {
  active = false;
  private inhibitor: Inhibitor | null = null;
  private pending: Promise<void> = Promise.resolve();
  private backend: SleepBackend;
  private restore: () => Promise<void>;
  constructor(backend: SleepBackend, restore: () => Promise<void>) {
    this.backend = backend;
    this.restore = restore;
  }
  private serial(action: () => Promise<void>) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  sleep() {
    return this.serial(async () => {
      if (this.active) return;
      this.inhibitor = await this.backend.inhibit();
      this.active = true;
      try {
        // Let the menu close before DPMS; key releases do not wake it.
        await delay(250);
        if (!this.inhibitor.alive()) throw new Error("Sleep inhibitor exited.");
        await this.backend.displays(false);
      } catch (error) {
        try {
          await this.resume();
        } catch {
          // A rejected sleep must not leave a system-wide lock behind.
          await this.inhibitor?.release();
          this.inhibitor = null;
          this.active = false;
          await this.restore();
        }
        throw error;
      }
    });
  }
  private async resume() {
    // Keep the inhibitor if DPMS fails, so a failed wake cannot suspend agents.
    await this.backend.displays(true);
    await this.inhibitor?.release();
    this.inhibitor = null;
    this.active = false;
    await this.restore();
  }
  wake() {
    return this.serial(() => this.resume());
  }
  check() {
    return this.serial(async () => {
      if (
        this.active &&
        (!this.inhibitor?.alive() || (await this.backend.displaysAwake()))
      )
        await this.resume();
    });
  }
}
