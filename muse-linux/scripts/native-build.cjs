const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'native/bin');
if (process.platform !== 'linux') throw new Error('Native helpers build on Linux.');
fs.mkdirSync(outDir, { recursive: true });

function compile(source, output, extra = []) {
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output, ...extra], { stdio: 'inherit' });
  fs.chmodSync(output, 0o755);
}

let flags;
try {
  flags = execFileSync('pkg-config', ['--cflags', '--libs', 'atspi-2', 'gobject-2.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
} catch {
  throw new Error('pkg-config must find atspi-2 and gobject-2.0 (install at-spi2-core and glib development packages).');
}
compile(path.join(root, 'native/accessibility.c'), path.join(outDir, 'muse-accessibility'), flags);
console.log('Built Linux accessibility helper.');
const workerFlags = execFileSync('pkg-config', ['--cflags', '--libs', 'atspi-2', 'gobject-2.0', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
compile(path.join(root, 'native/accessibility-worker.c'), path.join(outDir, 'muse-accessibility-worker'), workerFlags);
console.log('Built persistent Linux accessibility worker.');

const terminalSource = path.join(root, 'native/terminal.c');
if (fs.existsSync(terminalSource)) {
  const extra = [];
  const text = fs.readFileSync(terminalSource, 'utf8');
  if (/\b(pty\.h|openpty|forkpty|login_tty)\b/.test(text)) extra.push('-lutil');
  compile(terminalSource, path.join(outDir, 'muse-terminal'), extra);
  console.log('Built Linux terminal helper.');
} else {
  console.log('native/terminal.c is not present, skipped muse-terminal.');
}

function protocolSources(folder) {
  const directory = path.join(root, 'native/protocols', folder);
  const generated = path.join(root, 'native/generated', folder);
  fs.mkdirSync(generated, { recursive: true });
  fs.copyFileSync(path.join(directory, 'LICENSE'), path.join(outDir, folder + '-protocol-LICENSE'));
  const sources = [];
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.xml'))) {
    const name = path.basename(file, '.xml');
    const xml = path.join(directory, file);
    const header = path.join(generated, name + '-client-protocol.h');
    const source = path.join(generated, name + '-protocol.c');
    execFileSync('wayland-scanner', ['client-header', xml, header], { stdio: 'inherit' });
    execFileSync('wayland-scanner', ['private-code', xml, source], { stdio: 'inherit' });
    sources.push(source);
  }
  return ['-I' + generated, ...sources];
}

const pointerFlags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
compile(path.join(root, 'native/pointer.c'), path.join(outDir, 'muse-pointer'), [...protocolSources('pointer'), ...pointerFlags, '-lm']);
const overlayFlags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'cairo', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
compile(path.join(root, 'native/control-overlay.c'), path.join(outDir, 'muse-control-overlay'), [...protocolSources('overlay'), ...overlayFlags, '-lm']);
console.log('Built Wayland pointer and desktop indicator helpers.');

const keyboardFlags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'xkbcommon', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
compile(path.join(root, 'native/keyboard.c'), path.join(outDir, 'muse-keyboard'), [...protocolSources('keyboard'), ...keyboardFlags]);
console.log('Built Wayland bulk keyboard helper.');
compile(path.join(root, 'src/computer/session/native/wayland-session.c'), path.join(outDir, 'muse-wayland-session'), [...protocolSources('session'), ...pointerFlags]);
const readinessFlags = execFileSync('pkg-config', ['--cflags', '--libs', 'gtk+-3.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
compile(path.join(root, 'src/computer/session/native/readiness-fixture.c'), path.join(outDir, 'muse-readiness-fixture'), readinessFlags);
console.log('Built isolated session and readiness helpers.');
compile(path.join(root, 'native/activity.c'), path.join(outDir, 'muse-activity'));
console.log('Built physical input takeover monitor.');
