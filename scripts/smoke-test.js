'use strict';

/**
 * smoke-test.js
 * ---------------------------------------------------------------------------
 * Electron-hosted integration test. No real Tor needed: it stands up a tiny
 * fake Tor SOCKS5 endpoint that REQUIRES username/password auth, then checks
 * that the browser reaches it through the per-tab SocksShim with the expected
 * isolation credentials.
 *
 * Verifies:
 *   - address-bar normalisation (host, .onion, search)
 *   - a WebContentsView tab can be created and loads the local start page
 *   - the tab's session resolves to a SOCKS5 proxy on loopback (the shim)
 *   - the full SOCKS5 chain works and per-tab usernames are distinct
 *   - the injected hardening removed WebRTC in the page's main world
 *
 * Run with:  npm run smoke
 */

const net = require('net');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow, session } = require('electron');

const { TabManager, normalizeUrl } = require(path.join(__dirname, '..', 'src', 'main', 'tabs'));
const { VpnGateway } = require(path.join(__dirname, '..', 'src', 'main', 'vpn-gateway'));
const { openTunnel } = require(path.join(__dirname, '..', 'src', 'main', 'socks-client'));
const { testConnection } = require(path.join(__dirname, '..', 'src', 'main', 'net-test'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake Tor: a SOCKS5 server that requires user/pass and records them. */
function startFakeTor() {
  return new Promise((resolve) => {
    const seen = { users: [], targets: [] };
    const server = net.createServer((sock) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (stage === 0) {
            if (buf.length < 2) return;
            const n = buf[1];
            if (buf.length < 2 + n) return;
            const methods = buf.subarray(2, 2 + n);
            buf = buf.subarray(2 + n);
            if (!methods.includes(0x02)) {
              sock.write(Buffer.from([0x05, 0xff]));
              sock.destroy();
              return;
            }
            sock.write(Buffer.from([0x05, 0x02]));
            stage = 1;
          } else if (stage === 1) {
            if (buf.length < 2) return;
            const ulen = buf[1];
            if (buf.length < 2 + ulen + 1) return;
            const plen = buf[2 + ulen];
            if (buf.length < 2 + ulen + 1 + plen) return;
            seen.users.push(buf.subarray(2, 2 + ulen).toString('utf8'));
            buf = buf.subarray(2 + ulen + 1 + plen);
            sock.write(Buffer.from([0x01, 0x00]));
            stage = 2;
          } else if (stage === 2) {
            if (buf.length < 4) return;
            const atyp = buf[3];
            let reqLen = 4 + 2;
            if (atyp === 0x01) reqLen += 4;
            else if (atyp === 0x03) {
              if (buf.length < 5) return;
              reqLen += 1 + buf[4];
            } else if (atyp === 0x04) reqLen += 16;
            if (buf.length < reqLen) return;
            const host = atyp === 0x03 ? buf.subarray(5, 5 + buf[4]).toString('utf8') : 'ip';
            seen.targets.push(host);
            buf = buf.subarray(reqLen);
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            sock.write(
              'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello'
            );
            stage = 3;
            setTimeout(() => {
              try {
                sock.end();
              } catch (_) {}
            }, 150);
            return;
          } else {
            return; // done
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---- pure-function checks --------------------------------------------------
console.log('normalizeUrl:');
check('bare host gets http://', () => assert.strictEqual(normalizeUrl('example.com'), 'http://example.com'));
check('.onion gets http://', () =>
  assert.strictEqual(
    normalizeUrl('duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion'),
    'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion'
  ));
check('https preserved', () => assert.strictEqual(normalizeUrl('https://x.onion/y'), 'https://x.onion/y'));
check('query -> onion search', () => assert.ok(/\.onion\/\?q=hello%20world/.test(normalizeUrl('hello world'))));

app.whenReady().then(async () => {
  console.log('\nintegration:');
  const fake = await startFakeTor();

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  const tabs = new TabManager({
    window: win,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
    torHost: '127.0.0.1',
    torSocksPort: fake.port,
    bounds: { x: 0, y: 84, width: 800, height: 516 },
  });

  // --- tab A: local start page + proxy + hardening ------------------------
  const idA = await tabs.createTab();
  const tabA = tabs.tabs.get(idA);
  check('tab created', () => assert.ok(tabA));

  await waitFor(
    () => tabA.url && tabA.url.startsWith('file:') && tabA.title && tabA.title.length > 0,
    15000,
    'start page url + title'
  ).catch(() => {});
  check('start page has a url', () => assert.ok(tabA.url && tabA.url.startsWith('file:')));
  check('start page loaded a title', () => assert.ok(tabA.title && tabA.title.length > 0));

  const sesA = session.fromPartition(tabA.partition);
  let proxy = '';
  try {
    proxy = await sesA.resolveProxy('http://example.com/');
  } catch (err) {
    proxy = 'error:' + err.message;
  }
  check('session routes through a loopback SOCKS5 proxy', () =>
    assert.ok(/^SOCKS5 127\.0\.0\.1:\d+/.test(proxy), `resolveProxy returned: "${proxy}"`));

  let rtcType = 'unknown';
  try {
    rtcType = await tabA.view.webContents.executeJavaScript('typeof window.RTCPeerConnection', true);
  } catch (_) {}
  check('WebRTC removed in page main world', () => assert.strictEqual(rtcType, 'undefined'));

  // --- tabs B & C: real SOCKS relay to fake Tor, distinct usernames -------
  const idB = await tabs.createTab('http://alpha.onion/');
  await waitFor(() => fake.seen.targets.includes('alpha.onion'), 8000, 'alpha.onion CONNECT').catch(() => {});
  check('shim relayed CONNECT for the .onion host', () =>
    assert.ok(fake.seen.targets.includes('alpha.onion'), `targets: ${JSON.stringify(fake.seen.targets)}`));

  const idC = await tabs.createTab('http://beta.onion/');
  await waitFor(() => fake.seen.targets.includes('beta.onion'), 8000, 'beta.onion CONNECT').catch(() => {});

  const distinctUsers = [...new Set(fake.seen.users)];
  check('every stream carried an isolation username', () =>
    assert.ok(fake.seen.users.length > 0 && fake.seen.users.every((u) => u.startsWith('iso-'))));
  check('different tabs used different isolation usernames', () =>
    assert.ok(distinctUsers.length >= 2, `distinct usernames: ${JSON.stringify(distinctUsers)}`));

  // --- VPN gateway: SOCKS5 + HTTP CONNECT, both forwarded to "Tor" --------
  const vpn = new VpnGateway({ torHost: '127.0.0.1', torPort: fake.port });
  await vpn.start();
  check('gateway exposes a SOCKS5 and an HTTP CONNECT port', () =>
    assert.ok(vpn.socksPort > 0 && vpn.httpPort > 0, `socks=${vpn.socksPort} http=${vpn.httpPort}`));

  // SOCKS5 path through the gateway.
  let tunnel = null;
  try {
    tunnel = await openTunnel({
      socksHost: '127.0.0.1',
      socksPort: vpn.socksPort,
      targetHost: 'gamma.onion',
      targetPort: 80,
      timeoutMs: 6000,
    });
  } catch (_) {}
  check('gateway SOCKS5 tunnel established', () => assert.ok(tunnel && tunnel.socket));
  if (tunnel) {
    try {
      tunnel.socket.destroy();
    } catch (_) {}
  }
  await waitFor(() => fake.seen.targets.includes('gamma.onion'), 5000, 'gamma.onion via gateway').catch(() => {});
  check('gateway reached Tor with its own identity', () =>
    assert.ok(
      fake.seen.targets.includes('gamma.onion') && fake.seen.users.includes('tsb-vpn-gateway'),
      `targets: ${JSON.stringify(fake.seen.targets)} users: ${JSON.stringify(fake.seen.users)}`
    ));

  // HTTP CONNECT path through the gateway.
  const httpRes = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: vpn.httpPort }, () => {
      s.write('CONNECT delta.onion:80 HTTP/1.1\r\nHost: delta.onion:80\r\n\r\n');
    });
    let b = '';
    s.on('data', (d) => {
      b += d.toString('latin1');
      if (b.includes('hello') || b.length > 400) {
        try {
          s.destroy();
        } catch (_) {}
        resolve(b);
      }
    });
    s.on('error', () => resolve(b));
    setTimeout(() => {
      try {
        s.destroy();
      } catch (_) {}
      resolve(b);
    }, 6000);
  });
  check('gateway HTTP CONNECT returned 200 Established', () =>
    assert.ok(/HTTP\/1\.1 200/.test(httpRes), `got: ${httpRes.slice(0, 80)}`));

  // net-test reports a real, structured success.
  let testRes = null;
  try {
    testRes = await testConnection({
      socksHost: '127.0.0.1',
      socksPort: fake.port,
      username: 'probe',
      password: 'probe',
      targets: [{ id: 't', label: 'fake', host: 'epsilon.onion', port: 80, timeoutMs: 5000 }],
    });
  } catch (_) {}
  check('net-test reports a real success', () =>
    assert.ok(testRes && testRes.ok === true, JSON.stringify(testRes)));

  await vpn.stop();
  check('gateway stops cleanly', () => assert.strictEqual(vpn.running, false));

  // --- certificate interstitial: real handler, simulated TLS failure ------
  const tabCert = tabs.tabs.get(idA);
  const fakeEvent = { preventDefault() {} };
  let onionDecision = 'undecided';
  tabCert.view.webContents.emit(
    'certificate-error',
    fakeEvent,
    'https://someservice.onion/',
    'net::ERR_CERT_AUTHORITY_INVALID',
    { fingerprint: 'AA:BB', subjectName: 's', issuerName: 's' },
    (allow) => {
      onionDecision = allow;
    }
  );
  await delay(200);
  const listedCert = tabs.list().find((t) => t.id === idA);
  check('onion cert error surfaces as certBlocked (not a dead banner)', () =>
    assert.ok(
      listedCert && listedCert.certBlocked && listedCert.certBlocked.host === 'someservice.onion',
      JSON.stringify(listedCert && listedCert.certBlocked)
    ));
  check('denying an onion cert invokes the trust callback with false', () => {
    assert.strictEqual(tabs.proceedCert(idA, false), true);
    assert.strictEqual(onionDecision, false);
  });

  let clearDecision = 'undecided';
  tabCert.view.webContents.emit(
    'certificate-error',
    fakeEvent,
    'https://example.com/',
    'net::ERR_CERT_AUTHORITY_INVALID',
    { fingerprint: 'CC' },
    (allow) => {
      clearDecision = allow;
    }
  );
  check('clearnet cert error is denied strictly', () =>
    assert.strictEqual(clearDecision, false));

  console.log(`\n${failures === 0 ? 'ALL SMOKE TESTS PASSED' : failures + ' SMOKE TEST(S) FAILED'}`);

  try {
    tabs.closeAll();
  } catch (_) {}
  try {
    fake.server.close();
  } catch (_) {}
  win.destroy();
  app.exit(failures === 0 ? 0 : 1);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  app.exit(2);
});
