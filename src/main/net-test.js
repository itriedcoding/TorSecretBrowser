'use strict';

/**
 * net-test.js
 * ---------------------------------------------------------------------------
 * A real, end-to-end reachability test. It performs an actual SOCKS5 CONNECT
 * (with the same username/password handshake Tor's IsolateSOCKSAuth expects)
 * through the running Tor daemon to both a clearnet host and a .onion service,
 * and reports the true result — success, the error, and how long it took.
 *
 * There are NO mocks here: if Tor is not up or the network is blocking it, the
 * test fails with the real reason. This is what the UI shows the user, so a
 * failure is diagnosable instead of an unexplained blank page.
 */

const { openTunnel } = require('./socks-client');

/** Targets we consider a fair test of the tunnel. */
const DEFAULT_TARGETS = [
  {
    id: 'clearnet',
    label: 'Clearnet (torproject.org:443)',
    host: 'torproject.org',
    port: 443,
    timeoutMs: 30000,
  },
  {
    id: 'onion',
    label: '.onion (DuckDuckGo)',
    host: 'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion',
    port: 80,
    // First contact to an onion routinely takes 30-60s (descriptor fetch +
    // rendezvous). Do NOT shorten this: a short timeout turns a slow-but-live
    // onion into a false "doesn't work".
    timeoutMs: 120000,
  },
];

/**
 * Run the reachability test through Tor.
 * @param {object} opts
 * @param {number} opts.socksPort
 * @param {string} [opts.socksHost]
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {Array} [opts.targets]
 * @returns {Promise<{ok:boolean, results:Array}>}
 */
async function testConnection(opts) {
  if (!opts || !opts.socksPort) {
    throw new Error('Tor is not running');
  }
  const targets = opts.targets || DEFAULT_TARGETS;
  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        const { socket, ms } = await openTunnel({
          socksHost: opts.socksHost,
          socksPort: opts.socksPort,
          username: opts.username,
          password: opts.password,
          targetHost: t.host,
          targetPort: t.port,
          timeoutMs: t.timeoutMs,
        });
        try {
          socket.destroy();
        } catch (_) {}
        return { id: t.id, label: t.label, ok: true, ms };
      } catch (err) {
        return { id: t.id, label: t.label, ok: false, ms: err.ms || null, error: err.message };
      }
    })
  );
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { testConnection, DEFAULT_TARGETS };
