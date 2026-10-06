import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
const target = join(data, "t3-board");
const plugin = join(config, "omarchy/plugins/monke.t3-board");
const unit = join(config, "systemd/user/t3-board.service");
const marker = join(target, ".t3-board-install.json");
const bin = join(home, ".local/bin");
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const unitQuote = (s) => JSON.stringify(s.replaceAll("%", "%%"));
function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}
if (!existsSync(join(source, "dist/index.html")))
  throw new Error("Run npm run build before installing.");
if (existsSync(target) && readdirSync(target).length && !existsSync(marker))
  throw new Error(
    "The installation directory contains files not owned by T3 Board.",
  );
if (
  existsSync(unit) &&
  !readFileSync(unit, "utf8").includes("# Managed by T3 Board")
)
  throw new Error(
    "The existing t3-board.service is not owned by this installer.",
  );
if (existsSync(plugin) && !existsSync(marker))
  throw new Error(
    "The existing Omarchy plugin is not owned by this installer.",
  );
for (const path of [
  target,
  plugin,
  bin,
  dirname(unit),
  join(data, "applications"),
  join(data, "icons/hicolor/scalable/apps"),
])
  mkdirSync(path, { recursive: true });
for (const name of [
  "src",
  "web",
  "desktop",
  "scripts",
  "omarchy",
  "dist",
  "package.json",
  "package-lock.json",
  "README.md",
  "THIRD_PARTY.md",
])
  cpSync(join(source, name), join(target, name), { recursive: true });
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: target });
cpSync(join(source, "omarchy/monke.t3-board"), plugin, { recursive: true });
writeFileSync(
  join(bin, "t3-board"),
  `#!/bin/sh
systemctl --user start t3-board.service || exit $?
exec omarchy launch webapp http://127.0.0.1:47831/ "$@"
`,
  { mode: 0o755 },
);
writeFileSync(
  join(bin, "t3-boardctl"),
  `#!/bin/sh
exec ${quote(process.execPath)} --experimental-strip-types ${quote(join(target, "src/control.ts"))} "$@"
`,
  { mode: 0o755 },
);
writeFileSync(
  unit,
  `# Managed by T3 Board
[Unit]
Description=T3 Board AK820 Pro agent lighting
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${target.replaceAll("%", "%%")}
ExecStart=${unitQuote(process.execPath)} --experimental-strip-types src/server.ts
Environment=T3_BOARD_AUTOSTART=1
Environment=T3_BOARD_PORT=47831
Restart=always
RestartSec=3
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=default.target
`,
);
writeFileSync(
  join(data, "applications/t3-board.desktop"),
  `[Desktop Entry]
Version=1.0
Type=Application
Name=T3 Board
Comment=Control AK820 Pro lights from T3 agents
Exec=${JSON.stringify(join(bin, "t3-board"))}
Icon=t3-board
Terminal=false
Categories=Utility;
StartupWMClass=t3-board
`,
);
cpSync(
  join(source, "omarchy/t3-board.svg"),
  join(data, "icons/hicolor/scalable/apps/t3-board.svg"),
);
writeFileSync(
  marker,
  JSON.stringify({ source, installedAt: new Date().toISOString() }, null, 2),
);
run("omarchy", ["plugin", "validate", plugin]);
run("systemd-analyze", ["--user", "verify", unit]);
run("systemctl", ["--user", "daemon-reload"]);
run("systemctl", ["--user", "enable", "t3-board.service"]);
run("systemctl", ["--user", "restart", "t3-board.service"]);
const shell = join(config, "omarchy/shell.json");
if (existsSync(shell)) cpSync(shell, shell + ".bak.t3-board." + Date.now());
run("omarchy-shell", ["shell", "rescanPlugins"]);
run("omarchy", ["bar", "put", "monke.t3-board", "--after", "monke.agents"]);
run(process.execPath, [join(source, "scripts/install-navigation.mjs")]);
console.log(
  "T3 Board installed, enabled at login, and added to the Omarchy bar.",
);
