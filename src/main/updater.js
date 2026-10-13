'use strict';

/**
 * updater.js
 * ---------------------------------------------------------------------------
 * Owns the in-app auto-update system.
 *
 * Privacy: every update request is routed through the app's own Tor SOCKS
 * proxy (autoUpdater.netSession.setProxy), so version checks and downloads
 * are anonymous and indistinguishable from normal browsing. Nothing is sent
 * until either the user asks to check, or the first background check runs
 * after Tor is ready.
 *
 * It is honest about platform limits:
 *   - macOS auto-install requires a code-signed build. These builds are
 *     unsigned, so on macOS we only DETECT a new version and offer the
 *     download page; we never pretend to install.
 *   - Development (unpackaged) builds cannot update themselves.
 *
 * States reported to the renderer:
 *   unsupported | idle | checking | available | downloading | downloaded
 *   | not-available | error
 */

const { app } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

const RELEASES_URL = 'https://github.com/itriedcoding/TorSecretBrowser/releases/latest';

// macOS: an unsigned app cannot apply a Squirrel.Mac update.
const MANUAL_ONLY = process.platform === 'darwin';

let getWindow = () => null;
let openUrl = () => {};
let log = () => {};

let wired = false;
let socksPort = null;

let status = {
  state: 'idle',
  currentVersion: app.getVersion(),
  version: null,
  releaseDate: null,
  releaseNotes: null,
  percent: 0,
  bytesPerSecond: 0,
  error: null,
  manualOnly: MANUAL_ONLY,
  supported: false,
};

function snapshot() {
  return { ...status };
}

function setStatus(patch) {
  status = { ...status, ...patch };
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', snapshot());
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */
function normalizeNotes(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    const parts = notes.map((n) => (n && n.note ? String(n.note) : '')).filter(Boolean);
    return parts.length ? parts.join('\n\n') : null;
  }
  if (notes && typeof notes.note === 'string') return notes.note;
  return null;
}

/**
 * Point the updater's dedicated network session at the local Tor SOCKS proxy.
 * electron-updater does NOT use session.defaultSession, so it must be told
 * explicitly; otherwise update traffic would bypass Tor.
 */
function applyProxy() {
  if (!autoUpdater || !socksPort) return;
  try {
    const ses = autoUpdater.netSession;
    if (ses && typeof ses.setProxy === 'function') {
      const proxyRules = `socks5://127.0.0.1:${socksPort}`;
      Promise.resolve(ses.setProxy({ proxyRules })).catch((err) => {
        log(`update: failed to set Tor proxy: ${err && err.message}`);
      });
    } else {
      log('update: netSession unavailable; refusing to check over clearnet');
    }
  } catch (err) {
    log(`update: proxy setup error: ${err && err.message}`);
  }
}

function wire() {
  if (wired || !autoUpdater) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep the log quiet in the console unless explicitly debugging.
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    setStatus({
      state: 'available',
      version: info && info.version ? String(info.version) : null,
      releaseDate: info && info.releaseDate ? String(info.releaseDate) : null,
      releaseNotes: normalizeNotes(info && info.releaseNotes),
      percent: 0,
      bytesPerSecond: 0,
      error: null,
    })
  );
  autoUpdater.on('update-not-available', (info) =>
    setStatus({
      state: 'not-available',
      version: info && info.version ? String(info.version) : null,
      error: null,
    })
  );
  autoUpdater.on('download-progress', (p) =>
    setStatus({
      state: 'downloading',
      percent: Math.round((p && p.percent) || 0),
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
    })
  );
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({
      state: 'downloaded',
      version: info && info.version ? String(info.version) : status.version,
      percent: 100,
      error: null,
    })
  );
  autoUpdater.on('error', (err) =>
    setStatus({
      state: 'error',
      error: err ? String(err.message || err) : 'Unknown update error',
    })
  );
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */
function init(opts) {
  opts = opts || {};
  if (opts.getWindow) getWindow = opts.getWindow;
  if (opts.openUrl) openUrl = opts.openUrl;
  if (opts.log) log = opts.log;

  const supported = !!autoUpdater && app.isPackaged;
  status.currentVersion = app.getVersion();
  status.supported = supported;
  status.manualOnly = MANUAL_ONLY;

  if (!supported) {
    setStatus({ state: 'unsupported' });
    return snapshot();
  }
  wire();
  if (opts.socksPort) setSocksPort(opts.socksPort);
  return snapshot();
}

/** Update the SOCKS port used for update traffic (Tor may restart). */
function setSocksPort(port) {
  socksPort = port || null;
  applyProxy();
}

async function check() {
  if (!status.supported) {
    if (status.state !== 'unsupported') setStatus({ state: 'unsupported' });
    return snapshot();
  }
  if (!socksPort) {
    setStatus({
      state: 'error',
      error: 'Tor is not ready yet, so updates cannot be checked anonymously. Try again in a moment.',
    });
    return snapshot();
  }
  applyProxy();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', error: String((err && err.message) || err) });
  }
  return snapshot();
}

async function download() {
  if (!status.supported) return snapshot();
  // On unsigned macOS builds we cannot install; hand off to the download page.
  if (MANUAL_ONLY) {
    openReleasePage();
    return snapshot();
  }
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setStatus({ state: 'error', error: String((err && err.message) || err) });
  }
  return snapshot();
}

/**
 * Quit and apply a downloaded update. `onBeforeQuit` runs first (used to stop
 * Tor cleanly); the app then exits and the platform installer takes over.
 */
function install(opts) {
  opts = opts || {};
  if (!status.supported || MANUAL_ONLY) {
    openReleasePage();
    return false;
  }
  if (status.state !== 'downloaded') return false;
  if (typeof opts.onBeforeQuit === 'function') {
    try {
      opts.onBeforeQuit();
    } catch (_) {
      /* ignore */
    }
  }
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      setStatus({ state: 'error', error: String((err && err.message) || err) });
    }
  });
  return true;
}

/** Open the GitHub "latest release" page in a new Tor tab. */
function openReleasePage() {
  try {
    openUrl(RELEASES_URL);
  } catch (err) {
    log(`update: failed to open release page: ${err && err.message}`);
  }
}

module.exports = {
  init,
  snapshot,
  setSocksPort,
  check,
  download,
  install,
  openReleasePage,
  isManualOnly: () => MANUAL_ONLY,
  RELEASES_URL,
};
