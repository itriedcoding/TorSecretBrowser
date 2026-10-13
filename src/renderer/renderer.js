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
};

const state = {
  tabs: [],
  activeId: null,
  tor: { state: 'idle', progress: 0 },
  overlayVisible: false,
};

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
}

function applyTabs(list) {
  state.tabs = Array.isArray(list) ? list : [];
  const active = state.tabs.find((t) => t.active);
  state.activeId = active ? active.id : (state.tabs[0] ? state.tabs[0].id : null);
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
/* Wiring                                                                   */
/* ----------------------------------------------------------------------- */
api.onTabsUpdated(applyTabs);
api.onTorStatus(renderTorStatus);
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
  syncBounds();
})();
