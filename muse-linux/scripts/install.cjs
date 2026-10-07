const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const pkg = require('../package.json');

async function install() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This build targets Linux x86_64.');
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'dist', `Muse-for-Linux-${pkg.version}-x86_64.AppImage`);
  await fs.access(source);
  const directory = path.join(os.homedir(), '.local/opt/muse-linux');
  const applications = path.join(os.homedir(), '.local/share/applications');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(applications, { recursive: true });
  const staged = path.join(directory, `Muse.AppImage.${process.pid}.new`);
  try {
    await fs.copyFile(source, staged);
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, path.join(directory, 'Muse.AppImage'));
  } finally { await fs.unlink(staged).catch(() => {}); }
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(directory, 'icon.png'));
  await fs.writeFile(path.join(directory, 'launch'), '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec "$(dirname "$0")/Muse.AppImage" "$@"\n', { mode: 0o755 });
  const quote = value => `"${value.replace(/[\\"`$]/g, '\\$&')}"`;
  const desktopName = (pkg.desktopName || 'io.muse.linux.desktop').endsWith('.desktop') ? pkg.desktopName : `${pkg.desktopName}.desktop`;
  const desktopPath = path.join(applications, path.basename(desktopName));
  await fs.writeFile(desktopPath, [
    '[Desktop Entry]', 'Type=Application', 'Name=Muse for Linux', 'Comment=Chat with Muse',
    `Exec=${quote(path.join(directory, 'launch'))}`, `Icon=${path.join(directory, 'icon.png')}`,
    'Terminal=false', 'Categories=Network;', 'StartupWMClass=io.muse.linux', '',
  ].join('\n'));
  if (path.basename(desktopPath) !== 'muse-linux.desktop') await fs.unlink(path.join(applications, 'muse-linux.desktop')).catch(() => {});
  console.log('Installed Muse for Linux in the application launcher.');
}
install().catch(error => { console.error(error.message); process.exitCode = 1; });
