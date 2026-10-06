import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  constants,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const board = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const original = "/opt/t3code-nightly-bin";
const target =
  process.env.T3_BOARD_DESKTOP_RUNTIME ||
  join(homedir(), ".local/share/t3-board/desktop-runtime");
const asar = join(original, "resources/app.asar");
if (!existsSync(asar))
  throw new Error("The supported T3 Code Nightly installation is missing.");
mkdirSync(join(target, "resources/app"), { recursive: true });
// Refresh the executable when the installed app updates. Large copies use a
// filesystem clone where supported; resources stay in the package-owned tree.
const stamp = JSON.stringify([
  statSync(join(original, "t3code")).mtimeMs,
  statSync(asar).mtimeMs,
]);
if (
  !existsSync(join(target, ".version")) ||
  readFileSync(join(target, ".version"), "utf8") !== stamp
) {
  copyFileSync(
    join(original, "t3code"),
    join(target, "t3code.next"),
    constants.COPYFILE_FICLONE,
  );
  renameSync(join(target, "t3code.next"), join(target, "t3code"));
  for (const name of readdirSync(original)) {
    if (["t3code", "resources"].includes(name)) continue;
    if (!existsSync(join(target, name)))
      symlinkSync(join(original, name), join(target, name));
  }
  for (const name of readdirSync(join(original, "resources"))) {
    if (["app.asar", "app"].includes(name)) continue;
    if (!existsSync(join(target, "resources", name)))
      symlinkSync(
        join(original, "resources", name),
        join(target, "resources", name),
      );
  }
  writeFileSync(join(target, ".version"), stamp);
}
for (const name of ["integration.cjs", "composer.cjs"])
  cpSync(join(board, "desktop", name), join(target, "resources/app", name));
// Read metadata with Electron's asar support, using the installed executable in
// Node mode. The launcher calls this before launching the overlay.
import { execFileSync } from "node:child_process";
const metadata = JSON.parse(
  execFileSync(
    join(original, "t3code"),
    [
      "-e",
      `console.log(JSON.stringify(require(${JSON.stringify(asar + "/package.json")})))`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
  ),
);
writeFileSync(
  join(target, "resources/app/package.json"),
  JSON.stringify({ ...metadata, main: "boot.cjs" }),
);
writeFileSync(
  join(target, "resources/app/boot.cjs"),
  `require("./integration.cjs");\nconst {app}=require("electron");\napp.setAppPath(${JSON.stringify(asar)});\nrequire(${JSON.stringify(join(asar, metadata.main))});\n`,
);
console.log(target);
