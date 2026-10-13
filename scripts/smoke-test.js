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

  await waitFor(() => tabA.url && tabA.url.startsWith('file:'), 8000, 'start page load').catch(() => {});
  await delay(300);
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
