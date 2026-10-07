'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { SessionManager, createSessionExecutableAllowlist, createCageReadinessProbe } = require('./session/index.cjs');
const { WorkerChannel } = require('./desktop/worker-channel.cjs');

// Optional compositor resources are local configuration, never supplied by a tool request.
function createIsolationManager({ nativeDirectory, directory, clock, authorize, quiesce, onInvalidation }) {
  const bundled = path.join(nativeDirectory, 'isolation');
  const cage = fs.existsSync('/usr/bin/cage') ? '/usr/bin/cage' : path.join(bundled, 'bin/cage');
  const paths = { worker: path.join(nativeDirectory, 'muse-accessibility-worker'), pointer: path.join(nativeDirectory, 'muse-pointer'),
    keyboard: path.join(nativeDirectory, 'muse-keyboard'), foreignToplevel: path.join(nativeDirectory, 'muse-wayland-session'),
    fixture: path.join(nativeDirectory, 'muse-readiness-fixture'), capture: '/usr/bin/grim' };
  const dependencies = { bwrap: '/usr/bin/bwrap', cage, dbusDaemon: '/usr/bin/dbus-daemon', atspiLauncher: '/usr/lib/at-spi-bus-launcher',
    atspiRegistry: '/usr/lib/at-spi2-registryd', gdbus: '/usr/bin/gdbus', keepalive: '/usr/bin/sleep', protocolProbe: paths.foreignToplevel, capture: paths.capture };
  const missing = Object.entries(dependencies).filter(([, file]) => { try { fs.accessSync(file, fs.constants.X_OK); return false; } catch { return true; } }).map(([name]) => name);
  if (missing.length) return { manager: null, missing };
  const executables = createSessionExecutableAllowlist(paths);
  const apps = { 'muse-readiness-fixture': { executableId: 'readinessFixture', internalOnly: true,
    validateArgs: args => args.length === 1 && /^[a-f0-9-]{36}$/.test(args[0]), buildArgs: ({ args }) => args } };
  for (const [appId, executable] of [['files', '/usr/bin/nautilus'], ['terminal', '/usr/bin/foot']]) {
    if (!fs.existsSync(executable)) continue;
    executables[appId] = { path: executable, validateArgs: args => appId === 'files' ? args.length === 1 && args[0].startsWith('/') : args.length === 0 };
    apps[appId] = { executableId: appId, windowAppIds: appId === 'files' ? ['org.gnome.Nautilus'] : ['foot'], validateArgs: args => args.length === 0, buildArgs: ({ home }) => appId === 'files' ? [home] : [] };
  }
  const runtimeBase = path.join(tmpdir(), `muse-${process.getuid()}-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`);
  fs.mkdirSync(runtimeBase, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(runtimeBase);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('unsafe_isolation_runtime');
  const manager = new SessionManager({ runtimeBase, clock, dependencies, executables, apps,
    libraryDirectories: fs.existsSync(path.join(bundled, 'lib')) ? [path.join(bundled, 'lib')] : [], authorize, quiesce, onInvalidation,
    readyProbe: createCageReadinessProbe({ createWorkerChannel: options => new WorkerChannel(options), clock }) });
  return { manager, missing: [] };
}
module.exports = { createIsolationManager };
