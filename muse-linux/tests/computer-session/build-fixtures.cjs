'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// Builds only disposable artifacts. The production build remains lead-owned.
const root = path.resolve(__dirname, '../..');
const base = '/tmp/muse-port-d6c9/rewrite/impl-session';
const bins = path.join(base, 'live-bin');
fs.mkdirSync(bins, { recursive: true, mode: 0o700 });
const inputs = new Set(), commands = [];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(file, args) {
  commands.push({ file, args });
  return execFileSync(file, args, { encoding: 'utf8', timeout: 30000 });
}
const flags = (...packages) => run('/usr/bin/pkg-config', ['--cflags', '--libs', ...packages]).trim().split(/\s+/).filter(Boolean);
function protocol(folder) {
  const dir = path.join(base, 'generated', folder); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sourceDir = path.join(root, 'native/protocols', folder), sources = [];
  for (const file of fs.readdirSync(sourceDir).filter(name => name.endsWith('.xml')).sort()) {
    const xml = path.join(sourceDir, file), name = path.basename(file, '.xml'), source = path.join(dir, name + '-protocol.c'); inputs.add(xml);
    run('/usr/bin/wayland-scanner', ['client-header', xml, path.join(dir, name + '-client-protocol.h')]);
    run('/usr/bin/wayland-scanner', ['private-code', xml, source]); sources.push(source);
  }
  return ['-I' + dir, ...sources];
}
function compile(source, output, extra) {
  inputs.add(source);
  run('/usr/bin/cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output, ...extra]);
  fs.chmodSync(output, 0o755);
}
compile(path.join(root, 'src/computer/session/native/wayland-session.c'), path.join(base, 'wayland-session'), [...protocol('session'), ...flags('wayland-client', 'json-glib-1.0')]);
compile(path.join(root, 'src/computer/session/native/readiness-fixture.c'), path.join(base, 'readiness-fixture'), flags('gtk+-3.0'));
compile(path.join(__dirname, 'fixture.c'), path.join(base, 'fixture'), flags('gtk+-3.0'));
compile(path.join(root, 'native/accessibility.c'), path.join(bins, 'muse-accessibility'), flags('atspi-2', 'gobject-2.0'));
compile(path.join(root, 'native/accessibility-worker.c'), path.join(bins, 'muse-accessibility-worker'), flags('atspi-2', 'gobject-2.0', 'json-glib-1.0'));
compile(path.join(root, 'native/pointer.c'), path.join(bins, 'muse-pointer'), [...protocol('pointer'), ...flags('wayland-client', 'json-glib-1.0'), '-lm']);
compile(path.join(root, 'native/keyboard.c'), path.join(bins, 'muse-keyboard'), [...protocol('keyboard'), ...flags('wayland-client', 'xkbcommon', 'json-glib-1.0')]);
const outputs = ['wayland-session', 'readiness-fixture', 'fixture', 'live-bin/muse-accessibility', 'live-bin/muse-accessibility-worker', 'live-bin/muse-pointer', 'live-bin/muse-keyboard'].map(file => path.join(base, file));
fs.writeFileSync(path.join(base, 'build-manifest.json'), JSON.stringify({ builtAt: new Date().toISOString(), commands,
  inputs: Object.fromEntries([...inputs].sort().map(file => [file, digest(file)])),
  outputs: Object.fromEntries(outputs.map(file => [file, digest(file)])) }, null, 2), { mode: 0o600 });
console.log('Built seven private helpers with strict warnings; build-manifest.json records inputs and commands.');
