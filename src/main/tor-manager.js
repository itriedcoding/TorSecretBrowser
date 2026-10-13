'use strict';

/**
 * tor-manager.js
 * ---------------------------------------------------------------------------
 * Owns the lifecycle of the Tor process.
 *
 * Responsibilities:
 *   - pick free loopback ports for the SOCKS and control listeners
 *   - write a locked-down torrc (client-only, SafeSocks, isolation flags)
 *   - spawn Tor, capture its logs, and detect bootstrap completion
 *   - expose NEWNYM ("new identity") and a clean shutdown
 *
 * It emits:
 *   'status'    -> { state, progress, summary, ... }   (UI-friendly snapshot)
 *   'bootstrap' -> { progress, summary, tag }
 *   'log'       -> raw log line
 *   'exit'      -> { code, signal } if Tor dies unexpectedly
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { TorControl } = require('./tor-control');

/** Ask the OS for a currently-free TCP port on loopback. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class TorManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.binary     Absolute path to the tor executable.
   * @param {string} opts.dataDir    Directory for Tor state.
   * @param {string} opts.torrcTemplate  Path to resources/torrc.template.
   * @param {number} [opts.socksPort]    Force a specific SOCKS port.
   * @param {number} [opts.controlPort]  Force a specific control port.
   * @param {boolean} [opts.useBridges]
   * @param {string[]} [opts.bridges]   e.g. ['obfs4 1.2.3.4:1234 ...']
   */
  constructor(opts) {
    super();
    this.binary = opts.binary;
    this.dataDir = opts.dataDir;
    this.torrcTemplate = opts.torrcTemplate;
    this.socksPort = opts.socksPort || null;
    this.controlPort = opts.controlPort || null;
    this.useBridges = !!opts.useBridges;
    this.bridges = opts.bridges || [];
    this.logLevel = opts.logLevel || 'notice';

    this.child = null;
    this.control = null;
    this.status = {
      state: 'idle', // idle | starting | ready | error | stopped
      progress: 0,
      summary: '',
      socksPort: null,
      controlPort: null,
      binary: this.binary,
      error: null,
    };
    this._bootstrapWaiters = [];
  }

  /* ------------------------------------------------------------------ */
  /* torrc generation                                                    */
  /* ------------------------------------------------------------------ */

  _buildTorrc() {
    let template;
    try {
      template = fs.readFileSync(this.torrcTemplate, 'utf8');
    } catch (_) {
      template = this._defaultTorrcTemplate();
    }

    let torrc = template
      .replace(/%SOCKS_PORT%/g, String(this.socksPort))
      .replace(/%CONTROL_PORT%/g, String(this.controlPort))
      .replace(/%DATA_DIR%/g, this.dataDir.replace(/\\/g, '/'))
      .replace(/%LOG_LEVEL%/g, this.logLevel);

    if (this.useBridges && this.bridges.length) {
      torrc += '\n# Bridges supplied by the user\nUseBridges 1\n';
      for (const b of this.bridges) torrc += `Bridge ${b}\n`;
    }

    return torrc;
  }

  _defaultTorrcTemplate() {
    // Fallback if the template file is missing (e.g. inside a broken asar).
    return [
      'SocksPort 127.0.0.1:%SOCKS_PORT% IsolateSOCKSAuth IsolateDestAddr IsolateDestPort',
      'SafeSocks 1',
      'WarnUnsafeSocks 1',
      'ControlPort 127.0.0.1:%CONTROL_PORT%',
      'CookieAuthentication 1',
      'DataDirectory %DATA_DIR%',
      'ClientOnly 1',
      'ExitPolicy reject *:*',
      'AvoidDiskWrites 1',
      'Log %LOG_LEVEL% stdout',
      '',
    ].join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* start / stop                                                        */
  /* ------------------------------------------------------------------ */

  async start() {
    if (this.status.state === 'starting' || this.status.state === 'ready') return;

    this._setStatus({ state: 'starting', progress: 0, summary: 'Starting Tor...', error: null });

    if (!this.binary || !fs.existsSync(this.binary)) {
      const err = new Error(
        'Tor binary not found. Install Tor, set TOR_BINARY, or run "npm run fetch-tor".'
      );
      this._setStatus({ state: 'error', error: err.message });
      throw err;
    }

    fs.mkdirSync(this.dataDir, { recursive: true });

    if (!this.socksPort) this.socksPort = await getFreePort();
    if (!this.controlPort) this.controlPort = await getFreePort();
    this.status.socksPort = this.socksPort;
    this.status.controlPort = this.controlPort;

    const torrc = this._buildTorrc();
    const torrcPath = path.join(this.dataDir, 'torrc');
    fs.writeFileSync(torrcPath, torrc, { encoding: 'utf8', mode: 0o600 });

    this._spawnTor(torrcPath);

    // Wait for the control port to accept connections, then authenticate.
    this.control = new TorControl({
      host: '127.0.0.1',
      port: this.controlPort,
      cookieFile: path.join(this.dataDir, 'control_auth_cookie'),
    });
    this.control.on('bootstrap', (b) => this._onBootstrap(b));
    this.control.on('close', () => this.emit('log', 'control connection closed'));

    await this.control.connect(30000);
    await this.control.authenticate();
    await this.control.setEvents();

    // Prime the current bootstrap value (events only fire on change).
    try {
      const b = await this.control.getBootstrap();
      if (b && b.progress != null) this._onBootstrap(b);
    } catch (_) {
      /* ignore */
    }
  }

  _spawnTor(torrcPath) {
    const args = ['-f', torrcPath];
    this.emit('log', `spawning ${this.binary} ${args.join(' ')}`);

    this.child = spawn(this.binary, args, {
      cwd: this.dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const handle = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.emit('log', line);
        // Fallback bootstrap detection from logs.
        const m = /Bootstrapped (\d+)%/.exec(line);
        if (m) this._onBootstrap({ progress: parseInt(m[1], 10), summary: '', raw: line });
      }
    };
    this.child.stdout.on('data', handle);
    this.child.stderr.on('data', handle);

    this.child.on('error', (err) => {
      this._setStatus({ state: 'error', error: `Failed to launch Tor: ${err.message}` });
    });

    this.child.on('exit', (code, signal) => {
      this.emit('log', `Tor exited (code=${code} signal=${signal})`);
      if (this._stopping) {
        this._setStatus({ state: 'stopped', summary: 'Stopped' });
      } else {
        this._setStatus({ state: 'error', error: `Tor exited unexpectedly (code ${code}).` });
        this.emit('exit', { code, signal });
      }
      if (this.control) this.control.close();
    });
  }

  _onBootstrap(b) {
    const prev = this.status.progress;
    const progress = b.progress != null ? b.progress : prev;
    this._setStatus({
      state: progress >= 100 ? 'ready' : 'starting',
      progress,
      summary: b.summary || this.status.summary,
    });
    this.emit('bootstrap', b);
    if (progress >= 100) {
      const waiters = this._bootstrapWaiters;
      this._bootstrapWaiters = [];
      for (const w of waiters) w.resolve();
    }
  }

  /** Resolve when Tor reaches 100% bootstrap (or reject after timeout). */
  waitForReady(timeoutMs = 180000) {
    if (this.status.progress >= 100) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for Tor to bootstrap (network may be blocking Tor).'));
      }, timeoutMs);
      this._bootstrapWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async newIdentity() {
    if (!this.control) throw new Error('Tor control connection not available');
    await this.control.newIdentity();
  }

  async stop() {
    this._stopping = true;
    try {
      if (this.control) {
        await this.control.shutdown();
      }
    } catch (_) {
      /* ignore */
    }
    // Give Tor a moment to exit gracefully, then force-kill.
    await new Promise((resolve) => {
      if (!this.child) return resolve();
      const done = () => resolve();
      this.child.once('exit', done);
      setTimeout(() => {
        if (this.child && this.child.exitCode == null && !this.child.killed) {
          try {
            this.child.kill();
          } catch (_) {
            /* ignore */
          }
        }
        resolve();
      }, 4000);
    });
    if (this.control) this.control.close();
    this._setStatus({ state: 'stopped', summary: 'Stopped' });
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', { ...this.status });
  }

  /** Serialisable snapshot for the renderer. */
  snapshot() {
    return { ...this.status };
  }
}

module.exports = { TorManager, getFreePort };
