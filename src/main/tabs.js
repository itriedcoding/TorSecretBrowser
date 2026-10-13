'use strict';

/**
 * tabs.js
 * ---------------------------------------------------------------------------
 * Manages browser tabs. Each tab is an independent Electron WebContentsView
 * with:
 *   - its own in-memory session partition (no cookies/storage shared, no
 *     persistence to disk between runs),
 *   - its own SOCKS isolation credentials, so Tor gives it separate circuits,
 *   - the Tor proxy forced on, permissions denied, and WebRTC stripped.
 *
 * A tab's view is only attached to the window while it is active; background
 * tabs keep running (audio, long-poll) but are detached from layout.
 */

const path = require('path');
const crypto = require('crypto');
const { WebContentsView, session } = require('electron');
const { EventEmitter } = require('events');

const { hardenSession, newIsolationCredentials, buildHardeningScript } = require('./privacy');
const { SocksShim } = require('./socks-shim');

class TabManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('electron').BrowserWindow} opts.window
   * @param {string} opts.userAgent
   * @param {number} opts.torSocksPort   Tor's real SOCKS port.
   * @param {{x:number,y:number,width:number,height:number}} opts.bounds
   */
  constructor(opts) {
    super();
    this.window = opts.window;
    this.userAgent = opts.userAgent;
    this.torHost = opts.torHost || '127.0.0.1';
    this.torSocksPort = opts.torSocksPort;
    this.bounds = opts.bounds || { x: 0, y: 0, width: 0, height: 0 };
    // Navigation to the network is gated on Tor being fully bootstrapped, so a
    // page is never attempted against a not-yet-ready SOCKS port (which used to
    // surface as a silent blank page).
    this.isTorReady = typeof opts.isTorReady === 'function' ? opts.isTorReady : () => true;
    this.torReady = !!this.isTorReady();

    this.tabs = new Map(); // id -> tab
    this.activeId = null;
    this._counter = 0;
    this._hardeningScript = buildHardeningScript({ userAgent: this.userAgent });
  }

  /**
   * Update the Tor-ready gate. When Tor finishes bootstrapping, any tab that is
   * holding a pending navigation is loaded at that point.
   */
  setTorReady(ready) {
    this.torReady = !!ready;
    if (!this.torReady) return;
    for (const tab of this.tabs.values()) {
      if (tab.pendingUrl) {
        const url = tab.pendingUrl;
        tab.pendingUrl = null;
        this.navigate(tab.id, url);
      }
    }
  }

  /* ------------------------------- queries ------------------------------ */

  get activeTab() {
    return this.activeId ? this.tabs.get(this.activeId) : null;
  }

  list() {
    return [...this.tabs.values()].map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      error: t.error,
      pending: !!t.pendingUrl,
      certBlocked: t.certBlocked || null,
      canGoBack: t.canGoBack,
      canGoForward: t.canGoForward,
      active: t.id === this.activeId,
    }));
  }

  /* ------------------------------- create ------------------------------- */

  async createTab(url) {
    const id = `t${++this._counter}-${crypto.randomBytes(3).toString('hex')}`;
    const partition = `iso-${id}`; // note: no "persist:" -> in-memory only
    const isolation = newIsolationCredentials(id);

    // Start a per-tab SOCKS relay that speaks plain SOCKS5 to Chromium but
    // injects this tab's unique credentials toward Tor. That is what gives the
    // tab its own circuit pool (Tor's IsolateSOCKSAuth).
    const shim = new SocksShim({
      torHost: this.torHost,
      torPort: this.torSocksPort,
      username: isolation.username,
      password: isolation.password,
    });
    let proxyPort = this.torSocksPort;
    try {
      proxyPort = await shim.listen();
    } catch (err) {
      // Fall back to talking to Tor directly (still Tor-routed, just without
      // per-tab circuit isolation).
      this.emit('log', `SOCKS shim failed (${err.message}); using Tor directly`);
      shim.close();
    }

    // Configure the partition BEFORE the view starts loading anything.
    const sess = session.fromPartition(partition);
    hardenSession(sess, {
      socksHost: '127.0.0.1',
      socksPort: proxyPort,
      userAgent: this.userAgent,
    });

    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, '..', 'preload', 'tab-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        userAgent: this.userAgent,
        backgroundThrottling: false,
      },
    });
    try {
      view.setBackgroundColor('#1b1b1f');
    } catch (_) {}

    const tab = {
      id,
      partition,
      isolation,
      shim,
      proxyPort,
      view,
      session: sess,
      title: 'New Tab',
      url: url || '',
      loading: false,
      error: null,
      pendingUrl: null,
      pendingCert: null,
      certBlocked: null,
      canGoBack: false,
      canGoForward: false,
      _injected: false,
    };
    this.tabs.set(id, tab);

    this._wireTab(tab);

    // Only attach (show) once it is the active tab.
    this.selectTab(id);

    if (url) {
      this.navigate(id, url);
    } else {
      this._loadStartPage(tab);
    }

    this._emitUpdate();
    return id;
  }

  _loadStartPage(tab) {
    const startPage = path.join(__dirname, '..', 'renderer', 'pages', 'start.html');
    tab.view.webContents
      .loadFile(startPage)
      .catch((err) => this.emit('log', `start page load failed: ${err.message}`));
  }

  /* ------------------------------- wiring ------------------------------- */

  _wireTab(tab) {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      // Open target=_blank / window.open in a new isolated tab.
      if (/^https?:/.test(url)) this.createTab(url);
      return { action: 'deny' };
    });

    const refresh = () => this._refreshTabState(tab);

    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.error = null;
      refresh();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      refresh();
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || 'Untitled';
      refresh();
    });
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      this._injectHardening(tab);
      refresh();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url;
        refresh();
      }
    });
    wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // Ignore deliberate aborts (ERR_ABORTED = -3).
      if (code === -3) return;
      tab.loading = false;
      tab.error = `${desc} (${code})`;
      this.emit('log', `page failed to load: ${desc} (${code}) url=${validatedURL}`);
      refresh();
    });
    // TLS certificate errors (e.g. an .onion serving HTTPS with a self-signed
    // certificate: ERR_CERT_AUTHORITY_INVALID). Clearnet stays strict. For
    // .onion the trust decision is held for an explicit user interstitial —
    // without it, Retry just fails identically forever.
    wc.on('certificate-error', (event, url, error, certificate, callback) => {
      event.preventDefault();
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch (_) {}
      const fingerprint = (certificate && certificate.fingerprint) || '';
      const subject = (certificate && certificate.subjectName) || '';
      const issuer = (certificate && certificate.issuerName) || '';
      this.emit(
        'log',
        `TLS certificate error on ${url}: ${error} fingerprint=${fingerprint} subject=${subject} issuer=${issuer}`
      );
      if (!host.endsWith('.onion')) {
        try {
          callback(false);
        } catch (_) {}
        return;
      }
      if (tab.pendingCert) {
        try {
          tab.pendingCert.callback(false);
        } catch (_) {}
      }
      tab.pendingCert = { callback, url, error, host };
      tab.certBlocked = { url, error, host, fingerprint, subject, issuer };
      tab.loading = false;
      tab.error = null;
      this._emitUpdate();
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.error = `Renderer gone: ${details.reason}`;
      refresh();
    });
    wc.on('dom-ready', () => this._injectHardening(tab));

    // Keyboard shortcuts while a *page* (not the chrome UI) has focus.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = input.control || input.meta;
      const key = (input.key || '').toLowerCase();
      if (mod && key === 't') { event.preventDefault(); this.createTab(); }
      else if (mod && key === 'w') { event.preventDefault(); this.closeTab(tab.id); }
      else if (mod && key === 'l') { event.preventDefault(); this.emit('shortcut', 'focus-url'); }
      else if (mod && key === 'r') { event.preventDefault(); this.reload(tab.id); }
      else if (input.key === 'F5') { event.preventDefault(); this.reload(tab.id); }
      else if (input.alt && input.key === 'ArrowLeft') { event.preventDefault(); this.back(tab.id); }
      else if (input.alt && input.key === 'ArrowRight') { event.preventDefault(); this.forward(tab.id); }
    });

    // Inject the main-world hardening as early as possible.
    wc.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) this._injectHardening(tab);
    });
  }

  _injectHardening(tab) {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript(this._hardeningScript, false).catch(() => {
      /* page not ready yet; will retry on dom-ready */
    });
  }

  _refreshTabState(tab) {
    try {
      tab.canGoBack = tab.view.webContents.navigationHistory
        ? tab.view.webContents.navigationHistory.canGoBack()
        : tab.view.webContents.canGoBack();
      tab.canGoForward = tab.view.webContents.navigationHistory
        ? tab.view.webContents.navigationHistory.canGoForward()
        : tab.view.webContents.canGoForward();
    } catch (_) {}
    this._emitUpdate();
  }

  /* ------------------------------ selection ----------------------------- */

  selectTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.activeId === id) {
      this._applyBounds(tab);
      return;
    }

    const prev = this.activeTab;
    if (prev && prev.view) {
      try {
        this.window.contentView.removeChildView(prev.view);
      } catch (_) {}
    }

    this.activeId = id;
    this.window.contentView.addChildView(tab.view);
    this._applyBounds(tab);
    this._emitUpdate();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.pendingCert) {
      try {
        tab.pendingCert.callback(false);
      } catch (_) {}
      tab.pendingCert = null;
    }
    if (tab.id === this.activeId) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch (_) {}
    }
    try {
      tab.view.webContents.destroy();
    } catch (_) {}
    if (tab.shim) {
      try {
        tab.shim.close();
      } catch (_) {}
    }
    this.tabs.delete(id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = [...this.tabs.keys()].pop();
      if (next) this.selectTab(next);
    }
    this._emitUpdate();
  }

  closeAll() {
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
  }

  /* ------------------------------ navigation ---------------------------- */

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = normalizeUrl(input);
    if (!url) return;
    tab.error = null;
    if (!this.torReady) {
      // Tor has not finished bootstrapping. Hold the URL and load it the moment
      // we are ready, rather than loading against a dead SOCKS port and leaving
      // the user staring at a blank page.
      tab.pendingUrl = url;
      tab.url = url;
      this.emit('log', 'Tor is still connecting; holding navigation until ready');
      this._emitUpdate();
      return;
    }
    tab.pendingUrl = null;
    tab.view.webContents.loadURL(url).catch((err) => {
      tab.error = err.message;
      this._emitUpdate();
    });
  }

  back(id) {
    const tab = this.tabs.get(id);
    if (tab) tab.view.webContents.navigationHistory.back();
  }

  forward(id) {
    const tab = this.tabs.get(id);
    if (tab) tab.view.webContents.navigationHistory.forward();
  }

  reload(id) {
    const tab = this.tabs.get(id);
    if (tab) tab.view.webContents.reload();
  }

  stop(id) {
    const tab = this.tabs.get(id);
    if (tab) tab.view.webContents.stop();
  }

  /**
   * Resolve a held .onion certificate decision from the interstitial.
   * allow=true trusts the certificate for this session and reloads;
   * allow=false denies it and leaves the untrusted page (back or start page).
   */
  proceedCert(id, allow) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.pendingCert) return false;
    const pending = tab.pendingCert;
    tab.pendingCert = null;
    tab.certBlocked = null;
    try {
      pending.callback(!!allow);
    } catch (_) {}
    if (allow) {
      tab.error = null;
      tab.view.webContents.loadURL(pending.url).catch((err) => {
        tab.error = err.message;
        this._emitUpdate();
      });
    } else {
      let canBack = false;
      try {
        const wc = tab.view.webContents;
        canBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
      } catch (_) {}
      // did-start-loading on the new navigation clears any stale error.
      if (canBack) this.back(id);
      else this._loadStartPage(tab);
    }
    this._emitUpdate();
    return true;
  }

  /* -------------------------------- bounds ------------------------------ */

  setBounds(rect) {
    this.bounds = rect;
    const tab = this.activeTab;
    if (tab) this._applyBounds(tab);
  }

  _applyBounds(tab) {
    const b = this.bounds;
    if (!b || b.width <= 0 || b.height <= 0) return;
    try {
      tab.view.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
    } catch (_) {}
  }

  /* --------------------------- new identity ----------------------------- */

  /** Give every open tab fresh SOCKS credentials (=> fresh Tor circuits). */
  rotateIsolation() {
    for (const tab of this.tabs.values()) {
      tab.isolation = newIsolationCredentials(tab.id);
      // New connections through the shim will carry the new credentials, so
      // Tor assigns fresh circuits. (The shim's port/session stay the same.)
      if (tab.shim) {
        tab.shim.setCredentials({
          username: tab.isolation.username,
          password: tab.isolation.password,
        });
      }
      // Drop per-tab storage too, so a "new identity" really is new.
      tab.session.clearStorageData().catch(() => {});
      tab.session.clearCache().catch(() => {});
    }
  }

  _emitUpdate() {
    this.emit('updated', this.list());
  }
}

/**
 * Turn arbitrary user input into a URL.
 *   "example.onion"        -> "http://example.onion/"
 *   "duckduckgo.com"       -> "http://duckduckgo.com/"
 *   "http://x"             -> unchanged
 * Anything that looks like a search query is sent to a .onion search engine
 * (DuckDuckGo's onion) so the query never touches the clearnet.
 */
function normalizeUrl(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (!text) return null;

  // Already has a scheme we allow.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (/^https?:/i.test(text) || /^file:/i.test(text)) return text;
    // Disallow other explicit schemes in the address bar.
    return null;
  }

  // Looks like a hostname / onion address (no spaces).
  if (!/\s/.test(text) && /[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) {
    return 'http://' + text;
  }
  if (!/\s/.test(text) && /^[a-z2-7]{16,56}\.onion$/i.test(text)) {
    return 'http://' + text;
  }

  // Otherwise treat as a search query via a .onion search engine.
  return 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=' +
    encodeURIComponent(text);
}

module.exports = { TabManager, normalizeUrl };
