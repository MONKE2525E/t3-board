import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const installed = join(home, ".local/share/t3-board");
const bin = join(home, ".local/bin");
const config = join(home, ".config/hypr");
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const backup = (path) => {
  if (existsSync(path)) cpSync(path, path + ".bak.t3-board." + Date.now());
};
const wrapper = join(bin, "t3code");
const existing = readFileSync(wrapper, "utf8");
const oldExec =
  'exec /usr/bin/t3code-nightly "${platform_flags[@]}" "${user_flags[@]}" "$@"';
const newExec =
  'exec "$HOME/.local/bin/t3-board-desktop" "${platform_flags[@]}" "${user_flags[@]}" "$@"';
if (!existing.includes(oldExec) && !existing.includes(newExec))
  throw new Error(
    "The T3 launcher has changed. Inspect it before enabling the integration.",
  );
mkdirSync(config, { recursive: true });
execFileSync(
  process.execPath,
  [join(installed, "scripts/prepare-desktop.mjs")],
  { stdio: "inherit" },
);
writeFileSync(
  join(bin, "t3-board-desktop"),
  `#!/bin/sh
unset ELECTRON_RUN_AS_NODE
${quote(process.execPath)} ${quote(join(installed, "scripts/prepare-desktop.mjs"))} >/dev/null || exit $?
exec ${quote(join(installed, "desktop-runtime/t3code"))} "$@"
`,
  { mode: 0o755 },
);
if (existing.includes(oldExec)) {
  backup(wrapper);
  writeFileSync(wrapper, existing.replace(oldExec, newExec), { mode: 0o755 });
}
// The user desktop entry takes priority over the package's entry. Keep the
// normal launcher, including its existing Wayland and user flags.
const desktop = join(home, ".local/share/applications/t3code.desktop");
backup(desktop);
const originalDesktop = readFileSync(
  "/usr/share/applications/t3code.desktop",
  "utf8",
);
writeFileSync(
  desktop,
  originalDesktop.replace(/^Exec=.*$/m, `Exec=${JSON.stringify(wrapper)} %U`),
);
// T3 also registers a hidden URL handler. An older entry can bypass the
// integrated launcher even when the visible application entry is correct.
for (const name of ["com.t3tools.T3Code.desktop", "t3code-url-handler.desktop"]) {
  const handler = join(home, ".local/share/applications", name);
  if (!existsSync(handler)) continue;
  const previous = readFileSync(handler, "utf8");
  const updated = previous.replace(/^Exec=.*$/m, `Exec=${JSON.stringify(wrapper)} %U`);
  if (updated !== previous) {
    backup(handler);
    writeFileSync(handler, updated);
  }
}
execFileSync("update-desktop-database", [join(home, ".local/share/applications")]);
const modulePath = join(config, "t3-board-navigation.lua");
backup(modulePath);
cpSync(join(source, "omarchy/t3-board-navigation.lua"), modulePath);
const bindings = join(config, "bindings.lua");
const bindingsText = readFileSync(bindings, "utf8");
if (!bindingsText.includes('require("hypr.t3-board-navigation")')) {
  backup(bindings);
  writeFileSync(
    bindings,
    bindingsText +
      '\n-- T3 Board agent keyboard navigation\nrequire("hypr.t3-board-navigation")\n',
  );
}
execFileSync("hyprctl", ["reload"], { stdio: "inherit" });
const errors = execFileSync("hyprctl", ["configerrors"], {
  encoding: "utf8",
}).trim();
if (errors) throw new Error("Hyprland reports configuration errors: " + errors);
console.log(
  "Super+assigned key navigation installed. Quit and reopen T3 Code to activate its desktop integration.",
);
