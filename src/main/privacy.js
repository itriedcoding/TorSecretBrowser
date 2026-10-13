'use strict';

/**
 * privacy.js
 * ---------------------------------------------------------------------------
 * All the "do not leak" configuration lives here.
 *
 *   applyCommandLineSwitches()  – process-wide Chromium switches (must run
 *                                 before the app becomes ready). Kills WebRTC
 *                                 UDP leaks, background networking, etc.
 *   buildHardeningScript()      – JS injected into the main world of every
 *                                 page to remove WebRTC objects and smooth a
 *                                 few high-entropy fingerprinting surfaces.
 *   hardenSession()             – forces a session through the Tor SOCKS5
 *                                 proxy, denies permissions, and blocks any
 *                                 request that is not an allowed scheme.
 */

const crypto = require('crypto');

/** Schemes the browser is willing to load. Everything else is cancelled. */
const ALLOWED_SCHEMES = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
  'file:',
  'data:',
  'blob:',
  'about:',
  'chrome:',
  'devtools:',
]);

/**
 * Chromium switches applied before `app.whenReady`. These are global and
 * also harden the privileged UI renderer.
 */
function applyCommandLineSwitches(app) {
  const switches = [
    // -------- WebRTC / UDP leak protection (the big one) -----------------
    // Never send non-proxied UDP. Tor carries no UDP, so any WebRTC media
    // that tries to escape the proxy is simply unable to reach the network.
    ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp'],
    ['webrtc-ip-handling-policy', 'disable_non_proxied_udp'],

    // -------- Background chatter / telemetry -----------------------------
    ['disable-background-networking', '1'],
    ['disable-component-update', '1'],
    ['disable-domain-reliability', '1'],
    ['disable-sync', '1'],
    ['disable-client-side-phishing-detection', '1'],
    ['metrics-recording-only', '1'],
    ['no-pings', '1'],
    ['no-first-run', '1'],
    ['no-default-browser-check', '1'],
    ['disable-breakpad', '1'],
    ['disable-crash-reporter', '1'],
    ['dns-prefetch-disable', '1'],
    ['disable-features', 'Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CalculateNativeWinOcclusion,InterestFeedContentSuggestions'],
  ];

  for (const [key, value] of switches) {
    app.commandLine.appendSwitch(key, value);
  }
  // Boolean-only switches.
  app.commandLine.appendSwitch('disable-logging');
}

/**
 * JS executed in the page's *main* world, as early as we can arrange it.
 * Removes WebRTC APIs (Tor Browser disables WebRTC outright) and pins a few
 * navigator properties to a common value so users look more alike.
 */
function buildHardeningScript({ userAgent }) {
  const ua = JSON.stringify(userAgent);
  return `(function () {
  'use strict';
  try {
    // --- Disable WebRTC entirely (prevents IP / local-address leaks) ---
    var rtcKeys = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceGatherer'];
    rtcKeys.forEach(function (k) {
      try {
        Object.defineProperty(window, k, { configurable: false, get: function () { return undefined; } });
      } catch (e) {
        try { window[k] = undefined; } catch (_) {}
      }
    });
    try {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: false, get: function () { return undefined; }
      });
    } catch (_) {}

    // --- Fingerprint smoothing ------------------------------------------
    var def = function (obj, prop, value) {
      try { Object.defineProperty(obj, prop, { configurable: true, get: function () { return value; } }); } catch (_) {}
    };
    def(Navigator.prototype, 'userAgent', ${ua});
    def(Navigator.prototype, 'appVersion', ${ua.replace(/^Mozilla\//, '')});
    def(Navigator.prototype, 'platform', 'Win32');
    def(Navigator.prototype, 'hardwareConcurrency', 4);
    def(Navigator.prototype, 'deviceMemory', 8);
    def(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));
    def(Navigator.prototype, 'webdriver', false);
    def(Navigator.prototype, 'maxTouchPoints', 0);
  } catch (e) { /* never throw into the page */ }
})();`;
}

/** Generate a unique, URL-safe SOCKS credential pair for isolation. */
function newIsolationCredentials(seed) {
  const base = (seed || '') + crypto.randomBytes(9).toString('hex');
  const username = 'iso-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 16);
  const password = crypto.randomBytes(12).toString('hex');
  return { username, password };
}

/**
 * Force a session through Tor and lock it down.
 *
 * NOTE: credentials MUST NOT be embedded in the proxy rule string. Chromium
 * rejects `socks5://user:pass@host:port` and silently ends up with no proxy.
 * Per-tab circuit isolation is therefore handled by a local SocksShim (see
 * socks-shim.js) which injects the credentials toward Tor; the session simply
 * points at that shim's loopback port.
 *
 * @param {import('electron').Session} session
 * @param {object} opts
 * @param {string} [opts.socksHost=127.0.0.1]
 * @param {number} opts.socksPort
 * @param {string} opts.userAgent
 */
function hardenSession(session, opts) {
  const { socksHost = '127.0.0.1', socksPort, userAgent } = opts;
  if (!socksPort) throw new Error('hardenSession requires socksPort');

  session.setProxy({
    // Plain SOCKS5: Chromium sends the hostname to the proxy (remote DNS, so
    // .onion resolves) and does not try to add credentials of its own.
    proxyRules: `socks5://${socksHost}:${socksPort}`,
    // "<-loopback>" removes loopback from the implicit bypass list, so even
    // loopback destinations go through the shim instead of escaping directly.
    proxyBypassRules: '<-loopback>',
  });

  if (userAgent) session.setUserAgent(userAgent);

  // Deny every capability request (camera, mic, geolocation, notifications,
  // clipboard read, MIDI, etc.). Onion sites rarely need these and each one
  // is a fingerprinting / deanonymisation vector.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  // Block anything that is not an allowed scheme (e.g. ftp://, external
  // protocol handlers, custom app URIs). This also prevents stray requests
  // to protocols Chromium might route outside the proxy.
  session.webRequest.onBeforeRequest((details, callback) => {
    try {
      const scheme = new URL(details.url).protocol;
      if (!ALLOWED_SCHEMES.has(scheme)) {
        callback({ cancel: true });
        return;
      }
    } catch (_) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  return session;
}

module.exports = {
  ALLOWED_SCHEMES,
  applyCommandLineSwitches,
  buildHardeningScript,
  newIsolationCredentials,
  hardenSession,
};
