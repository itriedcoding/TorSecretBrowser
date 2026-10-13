'use strict';

/**
 * vpn-gateway.js
 * ---------------------------------------------------------------------------
 * A real, built-in Tor-routed network gateway.
 *
 * It listens on loopback (or an interface you explicitly opt in to) and offers
 * two standard proxy protocols, both of which forward through the bundled Tor
 * daemon:
 *
 *   - SOCKS5        : any app that speaks SOCKS5
 *   - HTTP CONNECT  : any app that speaks an HTTP proxy (HTTPS/any-TCP)
 *
 * This is honestly a Tor *gateway*, not a commercial VPN: there are no third
 * party servers, and it is TCP-only (Tor carries no UDP). Nothing here is
 * mocked — if Tor is down, connections fail with the real error.
 *
 * A kill switch is inherent: nothing is forwarded to the clearnet. Every byte
 * can only leave through Tor, and if Tor is not reachable the connection is
 * refused rather than leaked.
 */

const http = require('http');
const { EventEmitter } = require('events');

const { SocksShim } = require('./socks-shim');
const { openTunnel } = require('./socks-client');

/** Stable identity for gateway circuits (kept separate from per-tab ones). */
const GATEWAY_IDENTITY = 'tsb-vpn-gateway';
const GATEWAY_PASSWORD = 'gateway';

class VpnGateway extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.torHost=127.0.0.1]
   * @param {number} opts.torPort         Tor's real SOCKS port.
   * @param {string} [opts.bindHost=127.0.0.1]
   * @param {boolean} [opts.requireAuth]  Require client auth (use when non-loopback).
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   */
  constructor(opts = {}) {
    super();
    this.torHost = opts.torHost || '127.0.0.1';
    this.torPort = opts.torPort;
    this.bindHost = opts.bindHost || '127.0.0.1';
    this.requireAuth = !!opts.requireAuth;
    this.username = opts.username || '';
    this.password = opts.password || '';

    this.socks = null;
    this.httpServer = null;
    this.socksPort = null;
    this.httpPort = null;
    this.running = false;
    this.startedAt = null;
    this._conns = new Set();
  }

  async start() {
    if (this.running) return this.snapshot();
    if (!this.torPort) throw new Error('VPN gateway requires a Tor SOCKS port');

    // --- SOCKS5 endpoint ---------------------------------------------------
    this.socks = new SocksShim({
      torHost: this.torHost,
      torPort: this.torPort,
      username: GATEWAY_IDENTITY,
      password: GATEWAY_PASSWORD,
      clientAuth: this.requireAuth ? { username: this.username, password: this.password } : null,
    });
    this.socksPort = await this.socks.listen(this.bindHost);

    // --- HTTP CONNECT endpoint --------------------------------------------
    this.httpServer = http.createServer((req, res) => {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Tor Secret Browser gateway: this HTTP proxy only supports CONNECT. Use SOCKS5 for other traffic.\n');
    });
    this.httpServer.on('connect', (req, clientSocket, head) =>
      this._onConnect(req, clientSocket, head)
    );
    this.httpServer.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(0, this.bindHost, () => {
        this.httpPort = this.httpServer.address().port;
        resolve();
      });
    });

    this.running = true;
    this.startedAt = Date.now();
    this.emit('status', this.snapshot());
    return this.snapshot();
  }

  async _onConnect(req, clientSocket, head) {
    if (this.requireAuth && !this._checkProxyAuth(req)) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="Tor Secret Browser"\r\n\r\n'
      );
      clientSocket.destroy();
      return;
    }

    const m = /^\[([^\]]+)\]:(\d+)$/.exec(req.url) || /^([^\s:]+):(\d+)$/.exec(req.url);
    if (!m) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const host = m[1];
    const port = parseInt(m[2], 10);

    let tunnel;
    try {
      tunnel = await openTunnel({
        socksHost: this.torHost,
        socksPort: this.torPort,
        username: GATEWAY_IDENTITY,
        password: GATEWAY_PASSWORD,
        targetHost: host,
        targetPort: port,
        timeoutMs: 45000,
      });
    } catch (err) {
      this.emit('log', `CONNECT ${host}:${port} failed: ${err.message}`);
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch (_) {}
      clientSocket.destroy();
      return;
    }

    const upstream = tunnel.socket;
    this._track(clientSocket);
    this._track(upstream);

    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      if (tunnel.leftover && tunnel.leftover.length) clientSocket.write(tunnel.leftover);
    } catch (_) {
      // Either side went away mid-handshake; drop both halves quietly.
      try {
        clientSocket.destroy();
      } catch (_) {}
      try {
        upstream.destroy();
      } catch (_) {}
      return;
    }
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  }

  _checkProxyAuth(req) {
    const header = req.headers['proxy-authorization'] || '';
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    return (
      decoded.slice(0, idx) === this.username && decoded.slice(idx + 1) === this.password
    );
  }

  _track(socket) {
    this._conns.add(socket);
    const drop = () => this._conns.delete(socket);
    socket.on('close', drop);
    socket.on('error', () => {
      drop();
      try {
        socket.destroy();
      } catch (_) {}
    });
  }

  async stop() {
    this.running = false;
    for (const s of this._conns) {
      try {
        s.destroy();
      } catch (_) {}
    }
    this._conns.clear();
    if (this.socks) {
      try {
        this.socks.close();
      } catch (_) {}
      this.socks = null;
    }
    if (this.httpServer) {
      await new Promise((resolve) => {
        try {
          this.httpServer.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
      this.httpServer = null;
    }
    this.socksPort = null;
    this.httpPort = null;
    this.startedAt = null;
    this.emit('status', this.snapshot());
  }

  /** @returns {{running:boolean, bindHost:string, socksPort:?number, httpPort:?number, requireAuth:boolean, username:string, startedAt:?number, connections:number}} */
  snapshot() {
    return {
      running: this.running,
      bindHost: this.bindHost,
      socksPort: this.socksPort,
      httpPort: this.httpPort,
      requireAuth: this.requireAuth,
      username: this.username,
      startedAt: this.startedAt,
      connections: this._conns.size,
    };
  }
}

module.exports = { VpnGateway, GATEWAY_IDENTITY };
