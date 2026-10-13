# Tor Secret Browser

A small, hardened desktop browser built with **Electron** that routes *all* of
its traffic — including DNS — through the **Tor** network, with native support
for `.onion` services.

It is **not** a reskinned Tor Browser. It is a from-scratch Chromium shell whose
only way out to the network is the local Tor SOCKS5 proxy that the app launches
and manages for you.

> **Intended use:** lawful privacy and access to Tor onion services. You are
> responsible for complying with the laws that apply to you. Do not use this to
> attack, defraud, or access illegal material.

---

## What it actually does

| Concern | Implementation |
| --- | --- |
| **Tor process** | `src/main/tor-manager.js` spawns the real `tor` daemon with a generated `torrc`, waits for the control port, authenticates (cookie auth), and reports live bootstrap progress. |
| **All traffic through Tor** | Every tab session is forced to `socks5://127.0.0.1:<port>` with `proxyBypassRules: '<-loopback>'`. Chromium's SOCKS5 uses **remote DNS**, so hostnames are resolved *by Tor*. |
| **.onion resolution** | Works for free, because `.onion` names are resolved by Tor over the same SOCKS5 channel. No extra configuration. |
| **No DNS leak** | Chromium never resolves names itself (SOCKS5 remote DNS) **and** the generated `torrc` sets `SafeSocks 1`, which makes Tor refuse any locally-resolved request. |
| **No WebRTC leak** | The process runs with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, and the page's main-world `RTCPeerConnection` / `mediaDevices` are removed. Tor carries no UDP, so WebRTC cannot escape. |
| **No WebSocket/protocol escape** | `ws:`/`wss:` go through the proxy; every other scheme (`ftp:`, custom app URIs, …) is cancelled by a `webRequest` filter. |
| **Circuit isolation** | Each tab gets its own in-memory session partition **and** its own local SOCKS5 relay (`socks-shim.js`) that injects unique credentials toward Tor. With Tor's `IsolateSOCKSAuth`, distinct credentials ⇒ distinct circuits. |
| **Privacy by default** | No telemetry switches, no persistent profile: partitions are created without the `persist:` prefix, so cookies/cache/storage live only in memory for the tab's lifetime. "New Identity" calls `SIGNAL NEWNYM` and drops all per-tab storage. |
| **Clearnet + onion directory** | The new-tab page ships a verified directory of Tor Project and popular clearnet/`.onion` addresses, an "Open a link" box that accepts a clearnet URL, a `.onion` address or a search query, and a copy button on every onion address. The same directory is published on the website's Links page. |
| **Automatic updates** | `src/main/updater.js` keeps installed builds current. Version checks and downloads are routed through the app's own Tor SOCKS proxy (`autoUpdater.netSession.setProxy`), so update traffic never touches the clearnet. Windows/Linux download and install in place; unsigned macOS builds detect the new version and link to the download page instead of faking an install. |
| **Built-in Tor gateway ("VPN")** | `src/main/vpn-gateway.js` exposes a Tor-routed **SOCKS5** endpoint and an **HTTP CONNECT** endpoint on loopback, so other applications can be pointed at Tor without configuring Tor themselves. It is honestly a *gateway*, not a commercial VPN: there are no third-party servers and it is TCP-only. An opt-in toggle (`system-proxy.js`) can additionally point the OS proxy at it, and it is reverted automatically on quit. |
| **No silent blank pages** | Navigation to the network is held until Tor has fully bootstrapped, and any load failure (or the pending state) is shown in a banner with the real error and a Retry button — instead of an unexplained blank page. |
| **Real connection self-test** | The gateway panel can run an actual SOCKS5 CONNECT through Tor to both a clearnet host and a `.onion` service and reports the true result and latency (`socks-client.js` + `net-test.js`). Nothing is mocked. |
| **Fingerprint resistance** | One common user agent for everyone, navigator smoothing, WebRTC removed. (See limitations — this is *partial*.) |

---

## Architecture

```
+---------------------------------------------------------------+
|  Electron main process (Node.js)                              |
|                                                               |
|   index.js  ─────────────┐                                    |
|      │  applies privacy switches, owns windows & IPC          |
|      ├── tor-manager.js  │  spawns + supervises the tor daemon|
|      │      └── tor-control.js  (Tor control protocol client)  |
|      ├── privacy.js      │  proxy rules, leak guards, injected |
|      │                   │  hardening script                   |
|      ├── socks-shim.js   │  per-tab SOCKS5 relay -> Tor creds  |
|      ├── vpn-gateway.js  │  Tor-routed SOCKS5 + HTTP CONNECT   |
|      │      ├── socks-client.js  SOCKS5 client (test + gateway)|
|      │      ├── net-test.js      real clearnet/onion self-test  |
|      │      └── system-proxy.js  opt-in, auto-reverted OS proxy |
|      ├── paths.js        │  finds the tor binary               |
|      └── tabs.js         │  one WebContentsView + isolated      |
|                          │  session per tab                    |
|                                                               |
|   IPC (contextBridge)                                          |
|      ↓ chrome-preload.js        ↓ tab-preload.js              |
|   renderer/ (tab strip,        web pages (isolated, sandboxed, |
|   toolbar, status overlay)      proxied, WebRTC stripped)      |
+---------------------------------------------------------------+
        │ (loopback only)         │ (loopback only)
        ▼                         ▼
  [ SocksShim per tab ] ──► [ tor daemon ] ──► Tor network (3 hops)
```

The Tor process and the browser UI are cleanly separated: the renderer only
speaks to the main process over a narrow, explicitly-listed IPC bridge and can
never touch the Tor control port or the filesystem.

**Why the per-tab relay?** Chromium rejects credentials embedded in a proxy rule
string (`socks5://user:pass@host:port`) and silently installs *no proxy at all*.
A tab therefore points at its own loopback relay, which accepts plain SOCKS5
from Chromium and re-issues the request to Tor with that tab's unique username
and password. This is what makes per-tab circuit isolation reliable.

---

## Prerequisites

- **Node.js 18+** and npm.
- A **Tor binary**. The app looks for one in this order:
  1. the `TOR_BINARY` environment variable,
  2. a bundled binary at `resources/tor/<platform>-<arch>/tor[.exe]`,
  3. `tor` / `tor.exe` on your `PATH`.
- **`tar`** in your `PATH` only if you use the download script (bundled with
  Windows 10+, macOS and Linux).

Supported targets: **Windows x64, macOS (x64/arm64), Linux (x64/arm64)**.
The download script and packaging are wired for these; other architectures work
if you supply the binary yourself.

---

## Quick start

```bash
# 1. Install Electron + build tooling
npm install

# 2a. Download the official Tor Expert Bundle for your platform
npm run fetch-tor

#    ...or use a Tor you already have:
#    set TOR_BINARY=C:\path\to\tor.exe        (Windows PowerShell: $env:TOR_BINARY="...")
#    export TOR_BINARY=/usr/bin/tor           (Linux/macOS)

# 3. Launch
npm start
```

On first run the app prints Tor's log to the overlay, shows bootstrap progress,
and once it reaches 100% the new-tab page appears with an **Open a link** box and a
built-in clearnet/`.onion` directory. Paste any URL, `.onion` address or search
query there — or into the toolbar address bar — and it opens through Tor. Nothing
else is required.

### Where Tor keeps its state

`<Electron userData>/tor-data/` (per-OS: `%APPDATA%` on Windows,
`~/Library/Application Support` on macOS, `~/.config` on Linux). It contains the
generated `torrc`, the control auth cookie, and Tor's guard state. Delete it at
any time to reset guards.

---

## Building distributables

```bash
npm run dist      # installer for the current OS (NSIS / DMG / AppImage)
npm run dist:dir  # unpacked build for quick testing
```

The packaged app carries `resources/tor/<platform>-<arch>/` with it
(`extraResources` in `package.json`), so end users need **no separate Tor
install**. Run `npm run fetch-tor` before `npm run dist` on each target OS you
build for.

### Releases & the update feed

Pushing a tag matching `v*` runs `.github/workflows/release.yml`. It builds the
NSIS installer (Windows), DMGs **and** zips (macOS x64/arm64) and the AppImage
(Linux), computes `SHA256SUMS.txt`, and attaches everything to the GitHub
Release — including the electron-builder update metadata (`latest.yml`,
`latest-mac.yml`, `latest-linux.yml`) that installed apps read to update
themselves. Bump `version` in `package.json` before tagging so the app knows it
is older than the release.

---

## Operating notes & troubleshooting

**"Tor binary not found"**
Install Tor, set `TOR_BINARY`, or run `npm run fetch-tor`. On Debian/Ubuntu:
`sudo apt install tor`; on macOS: `brew install tor`.

**Stuck at "Starting Tor…" / never reaches 100%**
Your network is likely blocking Tor. Tor uses OR ports (443/9001/…). Options:
- Allow Tor through your firewall/proxy.
- Use **bridges**: put bridge lines in a `torrc` fragment at
  `<userData>/tor-data/torrc` *after* first run, or set `useBridges` in
  `tor-manager.js`. `obfs4` bridges ship inside the Expert Bundle under
  `pluggable_transports/`.

**A specific site doesn't load**
Many sites block Tor exits or don't have an onion version. A failed load now
shows a red banner with the exact error (e.g. `ERR_SOCKS_CONNECTION_FAILED`,
`ERR_TIMED_OUT`) and a Retry button, and the diagnostic log is under the Tor
chip. If Tor is still bootstrapping, the page is held and labelled rather than
left blank.

**Does the built-in gateway route other apps?**
Open the shield button in the toolbar. Once Tor is up, a loopback **SOCKS5** and
**HTTP CONNECT** endpoint are shown (they start automatically). Point any app at
them — for example `socks5://127.0.0.1:<port>`. The **Test connection** button
runs a real CONNECT to a clearnet host and a `.onion` and reports the result.
The optional "set as the operating system proxy" checkbox points the OS proxy at
it and is reverted automatically when you quit (and on the next launch if the
app crashed). It sets a *proxy*: apps that ignore the system proxy are
unaffected — this is not a TUN/TAP tunnel.

**"New Identity" seems slow**
It is: it tears down every circuit, rotates each tab's SOCKS credentials, and
wipes per-tab storage. Expect a few seconds of re-bootstrapping.

**Performance**
Traffic takes three relays around the world and is encrypted at each hop. Expect
noticeably higher latency than a normal browser; this is inherent to Tor, not to
this app. Upload-heavy pages are the slowest.

**Multiple instances**
Only one instance is allowed (single-instance lock) so we never race two Tor
daemons or two control connections.

---

## Explicit limitations

These are real and worth stating up front:

1. **Fingerprint resistance is partial.** This build reuses Chromium via
   Electron. Chromium's own fingerprinting surface (fonts, canvas, WebGL,
   audio, screen metrics, TLS/HTTP stack) differs from Firefox/Gecko, and Tor
   Browser's per-site "letterboxing" and first-party isolation are not
   reproduced. For the *strongest* anonymity guarantees, use the official Tor
   Browser. This project is a compact, transparent, self-hosted alternative for
   onion access and privacy-first browsing, not a drop-in anonymity upgrade.
2. **Circuit isolation is per tab, not per site.** Tabs are isolated from each
   other (distinct credentials + `IsolateSOCKSAuth`, plus `IsolateDestAddr` /
   `IsolateDestPort`). There is no Firefox-style *first-party* isolation inside a
   single tab. If the shim cannot reach Tor it transparently falls back to
   talking to Tor's SOCKS port directly, which keeps browsing working but
   reduces isolation to destination-based only.
3. **WebRTC is disabled, not proxied.** Sites that require WebRTC media will not
   work. This is deliberate.
4. **No extension support, no password manager, no sync.** Anything that could
   punch a hole through the proxy is intentionally absent.
5. **The "no history" model is in-memory per session.** It does not defend
   against an attacker with access to your machine or swap; use full-disk
   encryption.
6. **OS-level leaks are out of scope.** If your OS or another app leaks traffic,
   this browser cannot stop that. Consider a VM or Tails for high-risk use.
7. **The built-in gateway is a proxy, not a tunnel.** It exposes Tor-routed
   SOCKS5/HTTP endpoints and can set the OS proxy, but it does not install a
   TUN/TAP driver, so applications that bypass the system proxy will not be
   captured. It is TCP-only because Tor carries no UDP.

---

## Source layout

```
src/
  main/
    index.js         App lifecycle, window, IPC handlers
    tor-manager.js   Spawns/supervises tor, torrc generation, bootstrap
    tor-control.js   Tor control-protocol client (auth, GETINFO, NEWNYM)
    socks-shim.js    Per-tab SOCKS5 relay that adds isolation credentials
    privacy.js       Privacy switches, proxy + leak guards, hardening script
    paths.js         Locates the tor binary, computes data dirs
    updater.js       Tor-routed auto-update (electron-updater) lifecycle
    vpn-gateway.js   Tor-routed SOCKS5 + HTTP CONNECT gateway ("VPN")
    socks-client.js  Minimal SOCKS5 client (gateway + self-test)
    net-test.js      Real clearnet/.onion reachability self-test
    system-proxy.js  Opt-in, auto-reverted OS proxy configuration
    tabs.js          WebContentsView tabs, isolated sessions, shortcuts
  preload/
    chrome-preload.js  Minimal contextBridge API for the UI
    tab-preload.js     Empty anchor for page-side behaviour
  renderer/
    index.html / styles.css / renderer.js   Browser chrome UI
    pages/start.html                        New-tab start page
scripts/
  fetch-tor.js       Discovers + downloads the Tor Expert Bundle
  smoke-test.js      Electron integration test (fake Tor, real SOCKS chain)
  tor-live-test.js   Live Tor bootstrap / NEWNYM / shutdown test
  syntax-check.js    node --check every source file
resources/
  torrc.template     Documented torrc reference (app generates its own)
```

## Verifying the build

```bash
npm run syntax-check   # static parse of every source file
npm run smoke          # Electron integration test; no network needed
npm run test:tor       # launches real Tor, waits for bootstrap, NEWNYM
```

`npm run smoke` stands up a fake Tor SOCKS5 endpoint and asserts the browser
reaches it through the per-tab shim, that different tabs use different isolation
usernames, that `.onion` CONNECT requests are relayed, that WebRTC is removed
from the page, and that the built-in gateway relays both SOCKS5 and HTTP CONNECT
to Tor. `npm run test:tor` proves the real daemon is launched, authenticated over
the control port, and able to build circuits.

## License

MIT. Tor is distributed under its own (BSD 3-clause) license; the Expert Bundle
you download with `npm run fetch-tor` remains under the Tor Project's terms.
