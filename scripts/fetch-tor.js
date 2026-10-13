'use strict';

/**
 * fetch-tor.js
 * ---------------------------------------------------------------------------
 * Downloads the official "Tor Expert Bundle" (just the tor daemon, no
 * browser) for the current platform and unpacks it into:
 *
 *     resources/tor/<platform>-<arch>/
 *
 * so that the app can find the binary offline (see src/main/paths.js).
 *
 * The bundle is fetched from https://dist.torproject.org, which is the official
 * Tor Project distribution host. The exact filename/version changes over time,
 * so this script *discovers* the newest available bundle by reading the
 * directory index rather than hard-coding a URL.
 *
 * Usage:
 *   node scripts/fetch-tor.js                 # auto-discover latest
 *   node scripts/fetch-tor.js --version 13.5.4
 *   node scripts/fetch-tor.js --url https://dist.torproject.org/.../x.tar.gz
 *   node scripts/fetch-tor.js --print-url
 *
 * Requires an extracted system `tar` (present on Windows 10+, macOS, Linux).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = 'https://dist.torproject.org/torbrowser';

/* ----------------------------- platform ---------------------------------- */
function platformTokens() {
  const osTok =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const archTok =
    process.arch === 'x64'
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'aarch64'
        : process.arch === 'ia32'
          ? 'i686'
          : process.arch;
  const dirName = `${osTok}-${archTok}`;
  return { osTok, archTok, dirName };
}

/* ------------------------------- http ------------------------------------ */
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'tor-secret-browser-fetch' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          res.resume();
          if (!loc) return reject(new Error('Redirect without Location'));
          return resolve(httpGet(new URL(loc, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function parseHrefs(html) {
  const out = [];
  const re = /href="([^"?]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function cmpVersions(a, b) {
  const pa = a.replace(/\/$/, '').split('.').map(Number);
  const pb = b.replace(/\/$/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* --------------------------- discovery ----------------------------------- */
async function discoverBundleUrl() {
  const { osTok, archTok } = platformTokens();

  const rootHtml = (await httpGet(`${DIST}/`)).toString('utf8');
  const versions = parseHrefs(rootHtml)
    .filter((h) => /^\d+\.\d+(\.\d+)?\/$/.test(h))
    .map((h) => h.replace(/\/$/, ''));
  if (versions.length === 0) throw new Error('No browser versions found in dist index.');
  versions.sort(cmpVersions);
  const latest = versions[versions.length - 1];

  const listHtml = (await httpGet(`${DIST}/${latest}/`)).toString('utf8');
  const candidates = parseHrefs(listHtml).filter(
    (h) =>
      /tor-expert-bundle/i.test(h) &&
      h.toLowerCase().includes(osTok) &&
      h.toLowerCase().includes(archTok) &&
      /\.tar\.gz$/i.test(h)
  );
  if (candidates.length === 0) {
    throw new Error(`No expert bundle found for ${osTok}/${archTok} in version ${latest}.`);
  }
  // Prefer the shortest name (usually the canonical one).
  candidates.sort((a, b) => a.length - b.length);
  return `${DIST}/${latest}/${candidates[0]}`;
}

/* ------------------------------ extract ---------------------------------- */
function extractTarGz(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (Windows/macOS) and GNU tar both accept -xzf ... -C ...
  const res = spawnSync('tar', ['-xzf', archive, '-C', destDir], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`tar extraction failed: ${res.stderr || res.error || 'unknown error'}`);
  }
}

function findBinary(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function chmodExecRecursive(dir) {
  if (process.platform === 'win32') return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) chmodExecRecursive(full);
    else if (/^(tor|tor-gencert|obfs4proxy|snowflake|meek|lyrebird)/.test(entry.name)) {
      try {
        fs.chmodSync(full, 0o755);
      } catch (_) {}
    }
  }
}

/* ------------------------------- main ------------------------------------ */
async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  const { osTok, archTok, dirName } = platformTokens();
  const destDir = path.join(ROOT, 'resources', 'tor', dirName);
  const binaryName = osTok === 'windows' ? 'tor.exe' : 'tor';

  let url = getFlag('--url');
  if (!url) {
    const version = getFlag('--version');
    if (version) {
      const listHtml = (await httpGet(`${DIST}/${version}/`)).toString('utf8');
      const candidates = parseHrefs(listHtml).filter(
        (h) =>
          /tor-expert-bundle/i.test(h) &&
          h.toLowerCase().includes(osTok) &&
          h.toLowerCase().includes(archTok) &&
          /\.tar\.gz$/i.test(h)
      );
      if (!candidates.length) throw new Error(`No bundle for ${osTok}/${archTok} in ${version}.`);
      candidates.sort((a, b) => a.length - b.length);
      url = `${DIST}/${version}/${candidates[0]}`;
    } else {
      console.log('Discovering latest Tor Expert Bundle…');
      url = await discoverBundleUrl();
    }
  }

  if (args.includes('--print-url')) {
    console.log(url);
    return;
  }

  console.log(`Platform: ${dirName}`);
  console.log(`Download: ${url}`);
  const buf = await httpGet(url);
  const tmpArchive = path.join(os.tmpdir(), `tor-expert-${Date.now()}.tar.gz`);
  fs.writeFileSync(tmpArchive, buf);
  console.log(`Downloaded ${(buf.length / 1048576).toFixed(1)} MiB.`);

  console.log(`Extracting to ${destDir}`);
  extractTarGz(tmpArchive, destDir);
  try {
    fs.unlinkSync(tmpArchive);
  } catch (_) {}

  chmodExecRecursive(destDir);

  const bin = findBinary(destDir, binaryName);
  if (!bin) {
    throw new Error(
      `Extraction finished but ${binaryName} was not found under ${destDir}. ` +
        'Check the bundle layout and copy the binary manually.'
    );
  }
  console.log(`\nTor binary ready: ${bin}`);
  console.log('You can now run: npm start');
}

main().catch((err) => {
  console.error('\nfetch-tor failed:', err.message);
  console.error(
    '\nAlternative: install Tor for your OS, or drop a tor binary into\n' +
      '  resources/tor/<platform>-<arch>/tor[.exe]\n' +
      'or set the TOR_BINARY environment variable.'
  );
  process.exit(1);
});
