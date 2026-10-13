'use strict';

/**
 * renderer.js - browser chrome logic (tab strip, toolbar, overlay).
 *
 * This runs in the isolated, CSP-locked chrome renderer. It talks to the main
 * process only through the `window.tsb` bridge exposed by chrome-preload.js.
 * It performs no network I/O of its own.
 */

const api = window.tsb;

const els = {
  tabs: document.getElementById('tabs'),
  newTab: document.getElementById('new-tab'),
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  omnibox: document.getElementById('omnibox'),
  url: document.getElementById('url'),
  scheme: document.getElementById('scheme-badge'),
  newIdentity: document.getElementById('new-identity'),
  torChip: document.getElementById('tor-chip'),
  viewport: document.getElementById('viewport'),
  overlay: document.getElementById('overlay'),
  overlaySpinner: document.getElementById('overlay-spinner'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayMessage: document.getElementById('overlay-message'),
  overlayProgress: document.getElementById('overlay-progress'),
  overlayAction: document.getElementById('overlay-action'),
  overlayLog: document.getElementById('overlay-log'),
  updateBtn: document.getElementById('update-btn'),
  updatePanel: document.getElementById('update-panel'),
  updateClose: document.getElementById('update-close'),
  updateStatus: document.getElementById('update-status'),
  updateBar: document.getElementById('update-bar'),
  updateNotes: document.getElementById('update-notes'),
  updateActions: document.getElementById('update-actions'),
  pageNotice: document.getElementById('page-notice'),
  pageNoticeText: document.getElementById('page-notice-text'),
  pageNoticeRetry: document.getElementById('page-notice-retry'),
  pageNoticeClose: document.getElementById('page-notice-close'),
  vpnBtn: document.getElementById('vpn-btn'),
  vpnPanel: document.getElementById('vpn-panel'),
  vpnClose: document.getElementById('vpn-close'),
  vpnStatus: document.getElementById('vpn-status'),
  vpnToggle: document.getElementById('vpn-toggle'),
  vpnTest: document.getElementById('vpn-test'),
  vpnEndpoints: document.getElementById('vpn-endpoints'),
  vpnSocks: document.getElementById('vpn-socks'),
  vpnHttp: document.getElementById('vpn-http'),
  vpnCopySocks: document.getElementById('vpn-copy-socks'),
  vpnCopyHttp: document.getElementById('vpn-copy-http'),
  vpnSystem: document.getElementById('vpn-system'),
  vpnTestResult: document.getElementById('vpn-test-result'),
};

const state = {
  tabs: [],
  activeId: null,
  tor: { state: 'idle', progress: 0 },
  overlayVisible: false,
  update: { state: 'idle' },
  vpn: { gateway: { running: false }, systemProxy: false },
  dismissed: { id: null, text: null },
  loadStart: {},
};

/* A page (especially a .onion) can legitimately take a long time before the
 * first byte arrives. Past this point we say so explicitly. */
const SLOW_AFTER_MS = 20000;

/* ----------------------------------------------------------------------- */
/* Layout: report the content rectangle to the main process so the native   */
/* WebContentsView can be positioned exactly over #viewport.                */
/* ----------------------------------------------------------------------- */
function syncBounds() {
  if (state.overlayVisible) {
    // Hide the native view while the overlay is up (native views always draw
    // on top of HTML, so we collapse it to zero size).
    api.setContentBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  const r = els.viewport.getBoundingClientRect();
  api.setContentBounds({
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
}

new ResizeObserver(syncBounds).observe(els.viewport);
window.addEventListener('resize', syncBounds);

/* ----------------------------------------------------------------------- */
/* Overlay                                                                  */
/* ----------------------------------------------------------------------- */
function showOverlay({ title, message, progress, spin, action }) {
  state.overlayVisible = true;
  els.overlay.classList.remove('hidden');
  els.overlayTitle.textContent = title;
  els.overlayMessage.textContent = message || '';
  els.overlayProgress.style.width = (progress != null ? progress : 0) + '%';
  els.overlaySpinner.classList.toggle('hidden', !spin);
  if (action) {
    els.overlayAction.textContent = action.label;
    els.overlayAction.onclick = action.onClick;
    els.overlayAction.classList.remove('hidden');
  } else {
    els.overlayAction.classList.add('hidden');
  }
  syncBounds();
}

function hideOverlay() {
  state.overlayVisible = false;
  els.overlay.classList.add('hidden');
  syncBounds();
}

/* ----------------------------------------------------------------------- */
/* Tabs                                                                     */
/* ----------------------------------------------------------------------- */
function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function renderTabs() {
  els.tabs.textContent = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeId ? ' active' : '') + (tab.loading ? ' loading' : '');
    el.title = tab.url || 'New Tab';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => api.activateTab(tab.id));
    els.tabs.appendChild(el);
  }
  els.newTab.disabled = false;
}

function updateToolbar() {
  const tab = activeTab();
  const has = !!tab;
  els.back.disabled = !has || !tab.canGoBack;
  els.forward.disabled = !has || !tab.canGoForward;

  if (document.activeElement !== els.url) {
    els.url.value = has ? tab.url : '';
  }
  const url = has ? tab.url || '' : '';
  let scheme = '';
  try {
    scheme = new URL(url).protocol.replace(':', '');
  } catch (_) {}
  const isOnion = /\.onion(:\d+)?(\/|$)/i.test(url);
  els.scheme.textContent = isOnion ? 'onion' : scheme || 'http';
  els.scheme.classList.toggle('onion', isOnion);

  renderPageNotice();
}

/* Show why a page is blank: a load error, a navigation still waiting for Tor to
 * finish bootstrapping, or a legitimately slow first contact (common for
 * .onion). Without this a failed or slow onion/clearnet load is silent. */
function renderPageNotice() {
  const tab = activeTab();
  let text = '';
  let isError = false;
  let showRetry = false;

  if (tab && tab.error) {
    text = `Couldn't load this page — ${tab.error}`;
    isError = true;
    showRetry = true;
  } else if (tab && tab.pending) {
    text = 'Connecting to the Tor network — this page will open automatically once Tor is ready.';
  } else if (
    tab &&
    tab.loading &&
    state.loadStart[tab.id] &&
    Date.now() - state.loadStart[tab.id] > SLOW_AFTER_MS
  ) {
    const onion = /\.onion(:\d+)?(\/|$)/i.test(tab.url || '');
    text = onion
      ? 'Still loading — first contact to a .onion routinely takes 30–60 seconds on Tor. The page stays blank until the onion answers; this is normal, not a stuck page.'
      : 'Still loading — Tor is slower than the clearnet. Give it a little longer before retrying.';
  }

  if (!text || (tab && state.dismissed.id === tab.id && state.dismissed.text === text)) {
    els.pageNotice.classList.add('hidden');
    els.viewport.style.top = '';
    syncBounds();
    return;
  }
  els.pageNoticeText.textContent = text;
  els.pageNotice.classList.toggle('error', isError);
  els.pageNotice.classList.toggle('pending', !isError);
  els.pageNoticeRetry.classList.toggle('hidden', !showRetry);
  els.pageNotice.classList.remove('hidden');
  els.viewport.style.top = 84 + els.pageNotice.offsetHeight + 'px';
  syncBounds();
}

function applyTabs(list) {
  state.tabs = Array.isArray(list) ? list : [];
  const active = state.tabs.find((t) => t.active);
  state.activeId = active ? active.id : (state.tabs[0] ? state.tabs[0].id : null);

  // Track how long each tab has been loading so slow .onion first-contacts can
  // be labelled instead of looking like a dead blank page.
  const now = Date.now();
  const seen = new Set();
  for (const t of state.tabs) {
    seen.add(t.id);
    if (t.loading) {
      if (!state.loadStart[t.id]) state.loadStart[t.id] = now;
    } else {
      delete state.loadStart[t.id];
    }
  }
  for (const id of Object.keys(state.loadStart)) {
    if (!seen.has(id)) delete state.loadStart[id];
  }

  renderTabs();
  updateToolbar();
  syncBounds();
}

/* ----------------------------------------------------------------------- */
/* Tor status                                                               */
/* ----------------------------------------------------------------------- */
function renderTorStatus(status) {
  state.tor = status || { state: 'idle' };
  const s = state.tor;

  els.torChip.className = 'chip ' + (s.state || 'idle');
  if (s.state === 'ready') {
    els.torChip.textContent = 'Tor: connected';
  } else if (s.state === 'starting') {
    els.torChip.textContent = `Tor: ${s.progress || 0}%`;
  } else if (s.state === 'error') {
    els.torChip.textContent = 'Tor: error';
  } else if (s.state === 'stopped') {
    els.torChip.textContent = 'Tor: stopped';
  } else {
    els.torChip.textContent = 'Tor: idle';
  }

  // Decide whether the blocking overlay should be visible.
  const haveTabs = state.tabs.length > 0;
  if (s.state === 'ready') {
    hideOverlay();
  } else if (s.state === 'error') {
    if (!haveTabs) {
      showOverlay({
        title: 'Tor could not start',
        message: s.error || 'Unknown error.',
        progress: 0,
        spin: false,
        action: {
          label: 'Retry',
          onClick: () => {
            showOverlay({ title: 'Starting Tor…', message: 'Re-launching the Tor process.', progress: 0, spin: true });
            api.restartTor();
          },
        },
      });
    }
  } else if (s.state === 'starting' && !haveTabs) {
    showOverlay({
      title: 'Starting Tor…',
      message: s.summary || 'Establishing a circuit to the Tor network.',
      progress: s.progress || 0,
      spin: true,
    });
  }
}

/* ----------------------------------------------------------------------- */
/* Software updates                                                         */
/* ----------------------------------------------------------------------- */
function showUpdatePanel() {
  els.updatePanel.classList.remove('hidden');
  els.updateBtn.setAttribute('aria-expanded', 'true');
}
function hideUpdatePanel() {
  els.updatePanel.classList.add('hidden');
  els.updateBtn.setAttribute('aria-expanded', 'false');
}

function formatRate(bps) {
  if (!bps) return '';
  const kib = bps / 1024;
  return kib < 1024 ? `${kib.toFixed(0)} KiB/s` : `${(kib / 1024).toFixed(1)} MiB/s`;
}

function addUpdateAction(label, onClick, primary) {
  const b = document.createElement('button');
  b.className = 'update-action' + (primary ? ' primary' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  els.updateActions.appendChild(b);
  return b;
}

function renderUpdate(status) {
  state.update = status || { state: 'idle' };
  const s = state.update;
  const cur = s.currentVersion ? `v${s.currentVersion}` : 'this build';

  els.updateActions.textContent = '';
  els.updateNotes.classList.add('hidden');
  els.updateNotes.textContent = '';
  els.updateBar.style.width = '0%';
  els.updateBar.parentElement.classList.add('hidden');

  const flagged = s.state === 'available' || s.state === 'downloaded';
  els.updateBtn.classList.toggle('has-update', flagged);

  switch (s.state) {
    case 'unsupported':
      els.updateStatus.textContent = `You are running ${cur}. This is an unpackaged development build, so self-updating is disabled.`;
      addUpdateAction('Open release page', () => api.openUpdatePage());
      break;
    case 'checking':
      els.updateStatus.textContent = 'Checking for updates over Tor…';
      break;
    case 'available':
      els.updateStatus.textContent = `Version ${s.version} is available — you have ${cur}.`;
      if (s.manualOnly) {
        addUpdateAction('Open download page', () => api.openUpdatePage(), true);
      } else {
        addUpdateAction('Download update', () => api.downloadUpdate(), true);
      }
      break;
    case 'downloading':
      els.updateBar.parentElement.classList.remove('hidden');
      els.updateBar.style.width = (s.percent || 0) + '%';
      els.updateStatus.textContent =
        `Downloading update over Tor… ${s.percent || 0}%` +
        (s.bytesPerSecond ? ` (${formatRate(s.bytesPerSecond)})` : '');
      break;
    case 'downloaded':
      els.updateStatus.textContent = `Version ${s.version} has been downloaded and is ready to install.`;
      addUpdateAction('Restart & install', () => api.installUpdate(), true);
      addUpdateAction('Later', () => hideUpdatePanel());
      break;
    case 'not-available':
      els.updateStatus.textContent = `You are up to date (${cur}).`;
      addUpdateAction('Check again', () => api.checkForUpdates());
      break;
    case 'error':
      els.updateStatus.textContent = s.error ? `Update error: ${s.error}` : 'Update failed.';
      addUpdateAction('Retry', () => api.checkForUpdates(), true);
      addUpdateAction('Open release page', () => api.openUpdatePage());
      break;
    default:
      els.updateStatus.textContent = `You are running ${cur}.`;
      addUpdateAction('Check for updates', () => api.checkForUpdates(), true);
  }

  if (s.releaseNotes) {
    els.updateNotes.textContent = String(s.releaseNotes).slice(0, 4000);
    els.updateNotes.classList.remove('hidden');
  }

  // Surface an untouched "available" update by highlighting the toolbar button.
  if (flagged) els.updateBtn.title = `Update available (v${s.version})`;
  else els.updateBtn.title = 'Software updates';
}

/* ----------------------------------------------------------------------- */
/* VPN / Tor gateway                                                        */
/* ----------------------------------------------------------------------- */
function showVpnPanel() {
  els.vpnPanel.classList.remove('hidden');
  els.vpnBtn.setAttribute('aria-expanded', 'true');
}
function hideVpnPanel() {
  els.vpnPanel.classList.add('hidden');
  els.vpnBtn.setAttribute('aria-expanded', 'false');
}

function renderVpn(status) {
  state.vpn = status || { gateway: { running: false }, systemProxy: false, canSystemProxy: false };
  const g = state.vpn.gateway || {};
  const running = !!g.running;

  els.vpnBtn.classList.toggle('active', running);
  els.vpnToggle.textContent = running ? 'Stop gateway' : 'Start gateway';
  els.vpnToggle.classList.toggle('primary', !running);

  if (running && g.socksPort) {
    els.vpnStatus.textContent =
      'Gateway is running. Point any application at the endpoints below to route it through Tor.';
    els.vpnEndpoints.classList.remove('hidden');
    els.vpnSocks.textContent = `127.0.0.1:${g.socksPort}`;
    els.vpnHttp.textContent = `127.0.0.1:${g.httpPort}`;
    els.vpnSystem.checked = !!state.vpn.systemProxy;
    els.vpnSystem.disabled = !state.vpn.canSystemProxy;
  } else {
    els.vpnStatus.textContent =
      state.tor.state === 'ready'
        ? 'The gateway is stopped. Start it to expose a Tor-routed proxy.'
        : 'Waiting for Tor to finish connecting…';
    els.vpnEndpoints.classList.add('hidden');
  }
}

function formatTestResults(res) {
  if (!res || !Array.isArray(res.results)) return 'No result.';
  return res.results
    .map((r) => `${r.label}: ${r.ok ? `OK (${r.ms} ms)` : `FAILED — ${r.error}`}`)
    .join('\n');
}

function copyText(text, button) {
  const done = () => {
    const prev = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = prev), 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (_) {}
    document.body.removeChild(ta);
    done();
  }
}

/* ----------------------------------------------------------------------- */
/* Wiring                                                                   */
/* ----------------------------------------------------------------------- */
api.onTabsUpdated(applyTabs);
api.onTorStatus(renderTorStatus);
api.onUpdateStatus(renderUpdate);
api.onVpnStatus(renderVpn);
api.onShortcut((name) => {
  if (name === 'focus-url') els.url.focus();
});
api.onTorLog((line) => {
  const max = 400;
  const lines = (els.overlayLog.textContent + '\n' + line).split('\n');
  els.overlayLog.textContent = lines.slice(-max).join('\n');
  els.overlayLog.scrollTop = els.overlayLog.scrollHeight;
});

els.newTab.addEventListener('click', () => api.createTab());

els.back.addEventListener('click', () => state.activeId && api.back(state.activeId));
els.forward.addEventListener('click', () => state.activeId && api.forward(state.activeId));
els.reload.addEventListener('click', () => state.activeId && api.reload(state.activeId));

els.omnibox.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = els.url.value.trim();
  if (!value) return;
  if (!state.activeId) {
    api.createTab(value);
  } else {
    api.navigate(state.activeId, value);
  }
  els.url.blur();
});

els.url.addEventListener('focus', () => els.url.select());

els.newIdentity.addEventListener('click', async () => {
  els.newIdentity.disabled = true;
  try {
    await api.newIdentity();
  } catch (_) {}
  setTimeout(() => (els.newIdentity.disabled = false), 1500);
});

els.torChip.addEventListener('click', () => {
  // Toggle the diagnostic log while the overlay exists.
  if (!state.overlayVisible && state.tor.state === 'error') renderTorStatus(state.tor);
});

els.updateBtn.addEventListener('click', () => {
  if (els.updatePanel.classList.contains('hidden')) showUpdatePanel();
  else hideUpdatePanel();
});
els.updateClose.addEventListener('click', hideUpdatePanel);

/* --- page notice ------------------------------------------------------- */
els.pageNoticeClose.addEventListener('click', () => {
  const tab = activeTab();
  state.dismissed = { id: tab ? tab.id : null, text: els.pageNoticeText.textContent };
  renderPageNotice();
});
els.pageNoticeRetry.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  state.dismissed = { id: null, text: null };
  api.navigate(tab.id, tab.url || '');
  renderPageNotice();
});

/* --- VPN / gateway ----------------------------------------------------- */
els.vpnBtn.addEventListener('click', () => {
  if (els.vpnPanel.classList.contains('hidden')) showVpnPanel();
  else hideVpnPanel();
});
els.vpnClose.addEventListener('click', hideVpnPanel);

els.vpnToggle.addEventListener('click', async () => {
  const running = state.vpn.gateway && state.vpn.gateway.running;
  els.vpnToggle.disabled = true;
  try {
    const next = running ? await api.stopVpn() : await api.startVpn();
    renderVpn(next);
  } catch (err) {
    els.vpnTestResult.textContent = `Gateway error: ${err.message}`;
    els.vpnTestResult.classList.remove('hidden');
  }
  els.vpnToggle.disabled = false;
});

els.vpnSystem.addEventListener('change', async () => {
  const want = els.vpnSystem.checked;
  els.vpnSystem.disabled = true;
  try {
    const next = await api.setSystemProxy(want);
    renderVpn(next);
  } catch (err) {
    els.vpnTestResult.textContent = `System proxy error: ${err.message}`;
    els.vpnTestResult.classList.remove('hidden');
    els.vpnSystem.checked = !want;
  }
  els.vpnSystem.disabled = !state.vpn.canSystemProxy;
});

els.vpnTest.addEventListener('click', async () => {
  els.vpnTest.disabled = true;
  els.vpnTestResult.classList.remove('hidden');
  els.vpnTestResult.textContent = 'Testing clearnet and .onion reachability through Tor…';
  try {
    const result = await api.testVpn();
    els.vpnTestResult.textContent = formatTestResults(result);
  } catch (err) {
    els.vpnTestResult.textContent = `Test failed: ${err.message}`;
  }
  els.vpnTest.disabled = false;
});

els.vpnCopySocks.addEventListener('click', () =>
  copyText(els.vpnSocks.textContent, els.vpnCopySocks)
);
els.vpnCopyHttp.addEventListener('click', () =>
  copyText(els.vpnHttp.textContent, els.vpnCopyHttp)
);

// Keyboard shortcuts that work while the chrome UI itself has focus. Shortcuts
// while a web page is focused are handled in the main process (tabs.js).
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); api.createTab(); }
  else if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); if (state.activeId) api.closeTab(state.activeId); }
  else if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); els.url.focus(); }
  else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); if (state.activeId) api.reload(state.activeId); }
});

/* ----------------------------------------------------------------------- */
/* Bootstrap                                                                */
/* ----------------------------------------------------------------------- */
(async function init() {
  try {
    const status = await api.getTorStatus();
    renderTorStatus(status);
  } catch (_) {}
  try {
    const update = await api.getUpdateStatus();
    renderUpdate(update);
  } catch (_) {}
  try {
    const vpnStatus = await api.getVpnStatus();
    renderVpn(vpnStatus);
  } catch (_) {}
  syncBounds();
})();
