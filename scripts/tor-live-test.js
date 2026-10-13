'use strict';

/**
 * tor-live-test.js
 * ---------------------------------------------------------------------------
 * A real, end-to-end Tor test (no Electron, no GUI). It:
 *   1. locates the tor binary (TOR_BINARY, bundled resources, or PATH),
 *   2. launches Tor with the same generated torrc the app uses,
 *   3. waits for 100% bootstrap while printing progress,
 *   4. requests a new identity (SIGNAL NEWNYM),
 *   5. shuts Tor down cleanly.
 *
 * Run with:  npm run test:tor
 * Requires network access to the Tor network.
 */

const os = require('os');
const path = require('path');

const { TorManager } = require('../src/main/tor-manager');
const { findTorBinary } = require('../src/main/paths');

const found = findTorBinary(); // dev-mode lookup without an Electron `app`
if (!found) {
  console.error('No Tor binary found. Run `npm run fetch-tor`, set TOR_BINARY, or install Tor.');
  process.exit(1);
}
console.log(`Using Tor: ${found.path} (source: ${found.source})`);

const tor = new TorManager({
  binary: found.path,
  dataDir: path.join(os.tmpdir(), 'tsb-live-tor-cache'),
  torrcTemplate: path.join(__dirname, '..', 'resources', 'torrc.template'),
  logLevel: 'notice',
});

let last = -1;
tor.on('status', (s) => {
  if (s.progress !== last) {
    last = s.progress;
    console.log(`  ${s.state.padEnd(8)} ${String(s.progress).padStart(3)}%  ${s.summary || ''}`);
  }
});

(async () => {
  try {
    await tor.start();
    console.log('Control port up. Waiting for bootstrap (up to 5 min)...');
    await tor.waitForReady(300000);
    console.log(`Bootstrap complete. SOCKS port: ${tor.socksPort}`);
    await tor.newIdentity();
    console.log('New identity (NEWNYM) OK.');
    await tor.stop();
    console.log('\nLIVE TOR TEST PASSED');
    process.exit(0);
  } catch (err) {
    console.error('\nLIVE TOR TEST FAILED:', err.message);
    try {
      await tor.stop();
    } catch (_) {}
    process.exit(1);
  }
})();
