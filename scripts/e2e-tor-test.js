'use strict';

/**
 * e2e-tor-test.js
 * ---------------------------------------------------------------------------
 * The definitive end-to-end test: real Tor daemon + real Chromium tab chain.
 *
 * It boots the bundled Tor (warm cache for speed), builds a real TabManager
 * wired exactly like the app (per-tab shim, hardened session, Tor-ready gate),
 * then loads a real clearnet page AND a real .onion through the whole stack and
 * reports precisely what happened — page title on success, or the exact
 * Chromium error (code + description) on failure.
 *
 * No mocks, no fakes. Requires network access to the Tor network and takes a
 * few minutes (onion first-contact is slow by nature).
 *
 * Run with:  npm run test:e2e
 */

const os = require('os');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const { TorManager } = require(path.join(__dirname, '..', 'src', 'main', 'tor-manager'));
const { findTorBinary } = require(path.join(__dirname, '..', 'src', 'main', 'paths'));
const { TabManager } = require(path.join(__dirname, '..', 'src', 'main', 'tabs'));

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

function waitForTab(tabs, id, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const t = tabs.list().find((x) => x.id === id);
      if (!t) return resolve({ done: false, reason: 'tab vanished' });
      if (t.error) return resolve({ done: false, reason: `error: ${t.error}`, tab: t });
      if (!t.loading && t.url && !t.url.startsWith('about:blank') && t.title && t.title !== 'New Tab') {
        return resolve({ done: true, tab: t });
      }
      if (Date.now() - started > timeoutMs) {
        return resolve({ done: false, reason: `still loading after ${timeoutMs}ms (url=${t.url})`, tab: t });
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

app.whenReady().then(async () => {
  console.log('e2e: booting real Tor...');
  let tor = null;
  let win = null;
  let tabs = null;
  try {
    const found = findTorBinary();
    if (!found) {
      console.log('  FAIL  no Tor binary found');
      app.exit(1);
      return;
    }
    tor = new TorManager({
      binary: found.path,
      dataDir: path.join(os.tmpdir(), 'tsb-live-tor-cache'),
      torrcTemplate: path.join(__dirname, '..', 'resources', 'torrc.template'),
      logLevel: 'notice',
    });
    await tor.start();
    await tor.waitForReady(300000);
    console.log(`e2e: Tor ready on SOCKS ${tor.socksPort}`);

    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });

    tabs = new TabManager({
      window: win,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
      torHost: '127.0.0.1',
      torSocksPort: tor.socksPort,
      isTorReady: () => true,
      bounds: { x: 0, y: 84, width: 800, height: 516 },
    });
    tabs.setTorReady(true);

    // --- clearnet through the full chain -----------------------------------
    console.log('e2e: loading clearnet https://www.torproject.org/ ...');
    const idClear = await tabs.createTab('https://www.torproject.org/');
    const clear = await waitForTab(tabs, idClear, 90000);
    check('clearnet page loads through Chromium + shim + Tor', () => {
      assert.ok(clear.done, clear.reason);
      assert.ok(/tor/i.test(clear.tab.title), `title was: "${clear.tab.title}"`);
    });
    if (clear.done) console.log(`       title: "${clear.tab.title}"`);

    // --- .onion through the full chain --------------------------------------
    // The Tor Forum onion answered in ~4s in a raw-socket probe; it is the
    // fastest reliable onion we have measured.
    console.log('e2e: loading .onion http://v236xhqtyullodhf26szyjepvkbv6iitrhjgrqj4avaoukebkk6n6syd.onion/ ...');
    const idOnion = await tabs.createTab(
      'http://v236xhqtyullodhf26szyjepvkbv6iitrhjgrqj4avaoukebkk6n6syd.onion/'
    );
    const onion = await waitForTab(tabs, idOnion, 150000);
    check('.onion page loads through Chromium + shim + Tor', () => {
      assert.ok(onion.done, onion.reason);
    });
    if (onion.done) console.log(`       title: "${onion.tab.title}" url: ${onion.tab.url}`);

    console.log(`\n${failures === 0 ? 'E2E TOR TEST PASSED' : failures + ' E2E TEST(S) FAILED'}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  unexpected: ${err.message}`);
  } finally {
    try {
      if (tabs) tabs.closeAll();
    } catch (_) {}
    try {
      if (win) win.destroy();
    } catch (_) {}
    try {
      if (tor) await tor.stop();
    } catch (_) {}
    await delay(500);
    app.exit(failures === 0 ? 0 : 1);
  }
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  app.exit(2);
});
