'use strict';

/**
 * paths.js
 * ---------------------------------------------------------------------------
 * Locates the Tor binary and computes app data directories.
 *
 * Binary lookup order:
 *   1. TOR_BINARY environment variable (explicit override)
 *   2. Bundled binary under resources/tor/<platform-arch>/  (packaged or dev)
 *   3. A `tor` / `tor.exe` found on the system PATH
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** e.g. "windows-x86_64", "macos-aarch64", "linux-x86_64" */
function platformKey(platform = process.platform, arch = process.arch) {
  const os =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const cpu =
    arch === 'x64'
      ? 'x86_64'
      : arch === 'arm64'
        ? 'aarch64'
        : arch === 'ia32'
          ? 'i686'
          : arch;
  return `${os}-${cpu}`;
}

function torBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'tor.exe' : 'tor';
}

/** POSIX `which` / Windows `where`. Returns the first match or null. */
function whichSync(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [command], { encoding: 'utf8' });
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  }
  return null;
}

/**
 * @param {import('electron').App} app
 * @returns {{path: string, source: string}|null}
 */
function findTorBinary(app) {
  const plat = platformKey();
  const name = torBinaryName();

  // 1. Explicit override.
  if (process.env.TOR_BINARY && fs.existsSync(process.env.TOR_BINARY)) {
    return { path: process.env.TOR_BINARY, source: 'env:TOR_BINARY' };
  }

  // 2. Bundled locations.
  const roots = [];
  if (app && app.isPackaged) {
    roots.push(path.join(process.resourcesPath, 'tor'));
  }
  if (app) {
    roots.push(path.join(app.getAppPath(), 'resources', 'tor'));
  } else {
    roots.push(path.join(__dirname, '..', '..', 'resources', 'tor'));
  }

  for (const root of roots) {
    const candidates = [
      path.join(root, plat, name),
      path.join(root, plat, 'tor', name),
      path.join(root, name),
      path.join(root, 'tor', name),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return { path: c, source: `bundled:${path.relative(root, c)}` };
    }
  }

  // 3. System PATH.
  const onPath = whichSync(process.platform === 'win32' ? 'tor.exe' : 'tor');
  if (onPath) return { path: onPath, source: 'PATH' };

  return null;
}

/**
 * Directory where Tor keeps its state (guards, cached descriptors, control
 * cookie). Lives under Electron's per-user data dir.
 */
function torDataDir(app) {
  return path.join(app.getPath('userData'), 'tor-data');
}

module.exports = {
  platformKey,
  torBinaryName,
  whichSync,
  findTorBinary,
  torDataDir,
};
