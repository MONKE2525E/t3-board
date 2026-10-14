import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const input = join(config, "hypr/input.lua");
const previous = readFileSync(input, "utf8");
// Override older installations that restricted waking to physical keyboard readers.
const marker =
  "-- T3 Board: compositor input wakes displays even if the service exits.";
if (!previous.includes(marker)) {
  cpSync(input, input + ".bak.t3-board-sleep." + Date.now());
  writeFileSync(
    input,
    previous +
      `\n${marker}\nhl.config({ misc = { mouse_move_enables_dpms = true, key_press_enables_dpms = true } })\n`,
  );
}
execFileSync("hyprctl", ["reload"], { stdio: "inherit" });
const errors = execFileSync("hyprctl", ["configerrors"], {
  encoding: "utf8",
}).trim();
if (errors) throw new Error(errors);
