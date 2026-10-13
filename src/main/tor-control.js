'use strict';

/**
 * tor-control.js
 * ---------------------------------------------------------------------------
 * A minimal, dependency-free client for the Tor Control Protocol (TC).
 *
 * Reference: https://spec.torproject.org/control-spec/
 *
 * It supports everything this browser needs:
 *   - connecting with retry/backoff while Tor starts up
 *   - PROTOCOLINFO discovery + cookie / password / null authentication
 *   - GETINFO queries (e.g. status/bootstrap-phase)
 *   - SETEVENTS + asynchronous 650 event parsing (bootstrap progress)
 *   - SIGNAL NEWNYM for "new identity"
 *   - SIGNAL SHUTDOWN for a clean stop
 *
 * The protocol is line based. Replies begin with a 3 digit status code:
 *   250 OK
 *   250-foo        (a continuation line, more to follow)
 *   250+foo        (a data reply; following lines are raw data until ".")
 *   650 EVENT ...  (asynchronous event, not tied to a request)
 * All lines end with CRLF.
 */

const net = require('net');
const fs = require('fs');
const { EventEmitter } = require('events');

class TorControl extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.host=127.0.0.1]
   * @param {number} opts.port                 Control port number.
   * @param {string} [opts.password]           Plaintext control password (if used).
   * @param {string} [opts.cookieFile]         Path to control_auth_cookie (cookie auth).
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port;
    this.password = opts.password || null;
    this.cookieFile = opts.cookieFile || null;

    this.socket = null;
    this.connected = false;
    this._buffer = '';

    // Request serialisation: Tor answers one command at a time, so we queue.
    this._queue = [];
    this._current = null;
  }

  /**
   * Connect, retrying until `timeoutMs` elapses (Tor may still be booting and
   * not yet listening on the control port).
   */
  connect(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();

      const attempt = () => {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.destroy();
          this.socket = null;
        }

        const sock = net.connect({ host: this.host, port: this.port });
        let opened = false;

        sock.once('connect', () => {
          opened = true;
          this.socket = sock;
          this.connected = true;
          sock.setEncoding('utf8');
          sock.on('data', (d) => this._onData(d));
          sock.on('close', () => {
            this.connected = false;
            this.emit('close');
          });
          sock.on('error', (e) => this.emit('error', e));
          resolve(this);
        });

        sock.once('error', (err) => {
          sock.destroy();
          if (opened) return;
          if (Date.now() - started < timeoutMs) {
            setTimeout(attempt, 400);
          } else {
            reject(new Error(`Tor control port ${this.host}:${this.port} unreachable: ${err.message}`));
          }
        });
      };

      attempt();
    });
  }

  /** Discover the cookie file path via PROTOCOLINFO, then authenticate. */
  async authenticate() {
    let prolog = [];
    try {
      prolog = await this.send('PROTOCOLINFO 1');
    } catch (_) {
      // Some builds disable PROTOCOLINFO; fall back to cookie/password/null.
    }
    const prologText = prolog.join('\n');
    const cookieMatch = /COOKIEFILE="([^"]+)"/.exec(prologText);
    const discoveredCookie = cookieMatch ? cookieMatch[1] : null;
    const cookiePath = discoveredCookie || this.cookieFile;

    if (cookiePath && fs.existsSync(cookiePath)) {
      const cookie = fs.readFileSync(cookiePath);
      await this.send('AUTHENTICATE ' + cookie.toString('hex'));
      this._authMethod = 'cookie';
      return this._authMethod;
    }

    if (this.password) {
      // Quote the password and escape backslashes/quotes per control-spec.
      const escaped = this.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await this.send(`AUTHENTICATE "${escaped}"`);
      this._authMethod = 'password';
      return this._authMethod;
    }

    // Null authentication (only works if the control port allows it).
    await this.send('AUTHENTICATE');
    this._authMethod = 'null';
    return this._authMethod;
  }

  /** Subscribe to asynchronous events we care about. */
  async setEvents() {
    // STATUS_CLIENT carries bootstrap progress and guard/circuit notices.
    await this.send('SETEVENTS STATUS_CLIENT NOTICE WARN');
  }

  /**
   * GETINFO helper -> returns a map of key => value.
   * e.g. getInfo('status/bootstrap-phase') => { 'status/bootstrap-phase': '...' }
   */
  async getInfo(keys) {
    const lines = await this.send('GETINFO ' + keys);
    const out = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  /** Parse the current bootstrap phase from GETINFO. */
  async getBootstrap() {
    const info = await this.getInfo('status/bootstrap-phase');
    const raw = info['status/bootstrap-phase'] || '';
    return this._parseBootstrap(raw);
  }

  /** Request a brand new Tor identity (new circuits, new exit). */
  async newIdentity() {
    await this.send('SIGNAL NEWNYM');
  }

  /** Ask Tor to shut itself down cleanly. */
  async shutdown() {
    try {
      await this.send('SIGNAL SHUTDOWN');
    } catch (_) {
      /* Tor may close the connection before replying; that is fine. */
    }
  }

  /** Queue and write a command, resolving with the reply's text lines. */
  send(command) {
    return new Promise((resolve, reject) => {
      this._queue.push({ command, lines: [], resolve, reject, dataMode: false });
      this._pump();
    });
  }

  _pump() {
    if (this._current || this._queue.length === 0) return;
    if (!this.socket || !this.connected) {
      const job = this._queue.shift();
      job.reject(new Error('Tor control socket is not connected'));
      return this._pump();
    }
    this._current = this._queue.shift();
    this.socket.write(this._current.command + '\r\n');
  }

  _onData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    // Raw data section of a "250+" reply: consume until the lone "." line.
    if (this._current && this._current.dataMode) {
      if (line === '.') {
        this._current.dataMode = false;
      } else {
        this._current.lines.push(line);
      }
      return;
    }

    // Asynchronous event.
    if (line.startsWith('650')) {
      this._handleEvent(line);
      return;
    }

    // Synchronous reply line.
    const m = /^(\d{3})([-+ ])(.*)$/.exec(line);
    if (!m) return; // stray line, ignore

    if (!this._current) return; // reply with no outstanding request

    const code = m[1];
    const sep = m[2];
    const text = m[3];

    if (sep === '+') {
      this._current.dataMode = true;
      if (text) this._current.lines.push(text);
      return;
    }

    this._current.lines.push(text);

    if (sep === ' ') {
      const job = this._current;
      this._current = null;
      if (code === '250') job.resolve(job.lines);
      else job.reject(new Error(`Tor control error ${code}: ${job.lines.join(' | ')}`));
      this._pump();
    }
  }

  _handleEvent(line) {
    const body = line.slice(4); // strip "650 "
    const type = body.split(' ')[0];
    this.emit('event', { type, raw: body });
    this.emit('event:' + type, body);

    if (type === 'STATUS_CLIENT' && body.includes('BOOTSTRAP')) {
      this.emit('bootstrap', this._parseBootstrap(body));
    }
  }

  _parseBootstrap(raw) {
    const progressMatch = /PROGRESS=(\d+)/.exec(raw);
    const tagMatch = /TAG=([A-Za-z0-9_-]+)/.exec(raw);
    const summaryMatch = /SUMMARY="([^"]*)"/.exec(raw);
    return {
      progress: progressMatch ? parseInt(progressMatch[1], 10) : null,
      tag: tagMatch ? tagMatch[1] : null,
      summary: summaryMatch ? summaryMatch[1] : '',
      raw,
    };
  }

  close() {
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = { TorControl };
