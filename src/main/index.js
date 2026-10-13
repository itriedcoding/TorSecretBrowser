'use strict';

/**
 * index.js  (Electron main process)
 * ---------------------------------------------------------------------------
 * Application entry point. It:
 *   1. applies privacy command-line switches before the app is ready,
 *   2. starts the TorManager (spawns Tor, waits for bootstrap),
 *   3. creates the browser window (the "chrome": tabs + toolbar),
 *   4. wires IPC between the chrome UI and the tab contents,
 *   5. shuts Tor down cleanly on exit.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const { applyCommandLineSwitches } = require('./privacy');
const { findTorBinary, torDataDir } = require('./paths');
const { TorManager } = require('./tor-manager');
const { TabManager } = require('./tabs');
const { VpnGateway } = require('./vpn-gateway');
const { SystemProxy } = require('./system-proxy');
const { testConnection } = require('./net-test');
const updater = require('./updater');

// ---------------------------------------------------------------------------
// Privacy switches MUST be set before the app becomes ready.
// ---------------------------------------------------------------------------
applyCommandLineSwitches(app);

// A single, common user agent (Tor Browser's standard value). Using one UA
// for everyone is itself an anti-fingerprinting measure.
const USER_AGENT =
  process.env.TSB_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';

let mainWindow = null;
let tor = null;
let tabs = null;
let torError = null;
let updateCheckScheduled = false;
let vpn = null;
const systemProxy = new SystemProxy();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#1b1b1f',
    title: 'Tor Secret Browser',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'chrome-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      additionalArguments: [`--tsb-platform=${process.platform}`],
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Tor lifecycle
// ---------------------------------------------------------------------------
function pushTorStatus() {
  const payload = tor ? tor.snapshot() : {
    state: torError ? 'error' : 'idle',
    progress: 0,
    summary: '',
    socksPort: null,
    controlPort: null,
    binary: null,
    error: torError,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tor:status', payload);
  }
}

async function startTor() {
  torError = null;
  pushTorStatus();

  const found = findTorBinary(app);
  if (!found) {
    torError =
      'Tor binary not found. Install Tor, set the TOR_BINARY environment variable, ' +
      'or run "npm run fetch-tor" to download a bundled copy.';
    pushTorStatus();
    return false;
  }

  tor = new TorManager({
    binary: found.path,
    dataDir: torDataDir(app),
    torrcTemplate: path.join(app.getAppPath(), 'resources', 'torrc.template'),
    logLevel: 'notice',
  });

  tor.on('status', () => pushTorStatus());
  tor.on('log', (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tor:log', line);
    }
  });

  try {
    await tor.start();
    pushTorStatus();
    // Build the tab manager now that we know the SOCKS port. We deliberately do
    // NOT create a tab yet: navigation is held until Tor has fully bootstrapped
    // so users never hit a not-yet-ready proxy (which showed as a blank page).
    ensureTabs();
    // Wait for full bootstrap in the background; UI reflects progress.
    tor
      .waitForReady()
      .then(async () => {
        pushTorStatus();
        if (tabs) tabs.setTorReady(true);
        if (tabs && tabs.tabs.size === 0) createInitialTab();
        // Bring up the built-in Tor gateway now that Tor is actually reachable.
        await startGateway();
        // Route update traffic through this Tor instance, then check once.
        updater.setSocksPort(tor.socksPort);
        scheduleUpdateCheck();
      })
      .catch((err) => {
        torError = err.message;
        pushTorStatus();
      });
    return true;
  } catch (err) {
    torError = err.message;
    pushTorStatus();
    return false;
  }
}

function ensureTabs() {
  if (tabs) return tabs;
  tabs = new TabManager({
    window: mainWindow,
    userAgent: USER_AGENT,
    torHost: '127.0.0.1',
    torSocksPort: tor.socksPort,
    isTorReady: () => !!(tor && tor.status.progress >= 100),
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  });
  tabs.on('updated', (list) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tabs:updated', list);
    }
  });
  tabs.on('log', (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tor:log', line);
    }
  });
  tabs.on('shortcut', (name) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ui:shortcut', name);
    }
  });
  return tabs;
}

function createInitialTab() {
  if (!tabs) return;
  if (tabs.tabs.size === 0) tabs.createTab();
}

/** Open a URL in a new (Tor-proxied) tab. Used by the updater. */
function openUrlInTab(url) {
  if (!tor) {
    sendToChromeLog(`update: cannot open ${url} (Tor is not running)`);
    return;
  }
  ensureTabs();
  if (tabs) tabs.createTab(url);
}

function sendToChromeLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tor:log', line);
  }
}

/**
 * Run a single background update check once Tor is up. It is deliberately
 * delayed so it never competes with bootstrap, and it is a no-op in unpackaged
 * development builds.
 */
function scheduleUpdateCheck() {
  if (updateCheckScheduled) return;
  updateCheckScheduled = true;
  if (!app.isPackaged) return;
  const timer = setTimeout(() => updater.check(), 8000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// ---------------------------------------------------------------------------
// VPN gateway (Tor-routed SOCKS5 + HTTP CONNECT)
// ---------------------------------------------------------------------------
function pushVpnStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn:status', vpnSnapshot());
  }
}

function vpnSnapshot() {
  return {
    gateway: vpn ? vpn.snapshot() : { running: false, socksPort: null, httpPort: null },
    systemProxy: systemProxy.enabled,
    canSystemProxy: ['win32', 'darwin', 'linux'].includes(process.platform),
  };
}

async function startGateway() {
  if (!tor || !tor.socksPort) return;
  if (!vpn) {
    vpn = new VpnGateway({ torHost: '127.0.0.1', torPort: tor.socksPort });
    vpn.on('status', () => pushVpnStatus());
    vpn.on('log', (line) => sendToChromeLog(`vpn: ${line}`));
  }
  try {
    await vpn.start();
  } catch (err) {
    sendToChromeLog(`vpn: gateway failed to start: ${err.message}`);
  }
  pushVpnStatus();
}

async function stopGateway() {
  if (vpn) {
    try {
      await vpn.stop();
    } catch (_) {}
  }
  pushVpnStatus();
}

// ---------------------------------------------------------------------------
// IPC surface exposed to the chrome UI
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('tor:get-status', () => (tor ? tor.snapshot() : {
    state: torError ? 'error' : 'idle',
    progress: 0,
    summary: '',
    socksPort: null,
    controlPort: null,
    binary: null,
    error: torError,
  }));

  ipcMain.handle('tor:new-identity', async () => {
    if (!tor) throw new Error('Tor is not running');
    await tor.newIdentity();
    if (tabs) tabs.rotateIsolation();
    return true;
  });

  ipcMain.handle('tor:restart', async () => {
    if (systemProxy.enabled) {
      try {
        await systemProxy.disable();
      } catch (_) {}
    }
    await stopGateway();
    if (vpn) {
      vpn = null;
    }
    if (tabs) tabs.closeAll();
    if (tor) {
      try {
        await tor.stop();
      } catch (_) {}
      tor = null;
    }
    tabs = null;
    return startTor();
  });

  ipcMain.handle('tabs:create', (_e, url) => {
    if (!tabs) return null;
    return tabs.createTab(url);
  });

  ipcMain.handle('tabs:close', (_e, id) => {
    if (tabs) tabs.closeTab(id);
    return true;
  });

  ipcMain.handle('tabs:activate', (_e, id) => {
    if (tabs) tabs.selectTab(id);
    return true;
  });

  ipcMain.handle('tabs:navigate', (_e, { id, url }) => {
    if (tabs) tabs.navigate(id, url);
    return true;
  });

  ipcMain.handle('tabs:back', (_e, id) => {
    if (tabs) tabs.back(id);
    return true;
  });

  ipcMain.handle('tabs:forward', (_e, id) => {
    if (tabs) tabs.forward(id);
    return true;
  });

  ipcMain.handle('tabs:reload', (_e, id) => {
    if (tabs) tabs.reload(id);
    return true;
  });

  ipcMain.handle('tabs:stop', (_e, id) => {
    if (tabs) tabs.stop(id);
    return true;
  });

  ipcMain.handle('ui:content-bounds', (_e, rect) => {
    if (tabs) tabs.setBounds(rect);
    return true;
  });

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    userAgent: USER_AGENT,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }));

  // --- auto-update ---------------------------------------------------------
  ipcMain.handle('update:get-status', () => updater.snapshot());

  ipcMain.handle('update:check', () => updater.check());

  ipcMain.handle('update:download', () => updater.download());

  ipcMain.handle('update:install', () => updater.install());

  ipcMain.handle('update:open-release', () => {
    updater.openReleasePage();
    return true;
  });

  // --- Tor reachability self-test ------------------------------------------
  ipcMain.handle('tor:test-connection', async () => {
    if (!tor || !tor.socksPort) throw new Error('Tor is not running');
    return testConnection({ socksHost: '127.0.0.1', socksPort: tor.socksPort });
  });

  // --- VPN gateway ----------------------------------------------------------
  ipcMain.handle('vpn:get-status', () => vpnSnapshot());

  ipcMain.handle('vpn:start', async () => {
    await startGateway();
    return vpnSnapshot();
  });

  ipcMain.handle('vpn:stop', async () => {
    if (systemProxy.enabled) {
      try {
        await systemProxy.disable();
      } catch (_) {}
    }
    await stopGateway();
    return vpnSnapshot();
  });

  ipcMain.handle('vpn:set-system-proxy', async (_e, enabled) => {
    if (enabled) {
      if (!vpn || !vpn.running || !vpn.socksPort) {
        await startGateway();
      }
      if (!vpn || !vpn.socksPort) throw new Error('The Tor gateway is not running yet');
      await systemProxy.enable('127.0.0.1', vpn.socksPort);
    } else {
      await systemProxy.disable();
    }
    pushVpnStatus();
    return vpnSnapshot();
  });

  ipcMain.handle('vpn:test', async () => {
    const port = vpn && vpn.running ? vpn.socksPort : tor && tor.socksPort;
    if (!port) throw new Error('Tor is not running');
    return testConnection({ socksHost: '127.0.0.1', socksPort: port, username: 'tsb-vpn-gateway', password: 'gateway' });
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // The default session only hosts the local chrome UI; make sure it does not
  // accidentally proxy (it loads file:// only).
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  } catch (_) {}

  // If a previous run left the system proxy pointed at us (e.g. a crash), undo
  // that before doing anything else so we never strand the user's networking.
  SystemProxy.recoverStale().catch(() => {});

  registerIpc();
  createWindow();

  updater.init({
    getWindow: () => mainWindow,
    openUrl: openUrlInTab,
    log: sendToChromeLog,
  });

  // Give the renderer a moment to mount before we start streaming status.
  mainWindow.webContents.once('did-finish-load', async () => {
    const ok = await startTor();
    if (ok) ensureTabs();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (tor || vpn || systemProxy.enabled) {
    event.preventDefault();
    try {
      if (systemProxy.enabled) await systemProxy.disable();
    } catch (_) {}
    try {
      if (tabs) tabs.closeAll();
      await stopGateway();
      if (tor) await tor.stop();
    } catch (_) {}
    tor = null;
    vpn = null;
    app.exit(0);
  }
});
