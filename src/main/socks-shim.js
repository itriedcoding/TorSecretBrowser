'use strict';

/**
 * socks-shim.js
 * ---------------------------------------------------------------------------
 * A tiny, per-tab SOCKS5 relay.
 *
 * WHY THIS EXISTS
 * Chromium's proxy-rule string does not accept credentials
 * (`socks5://user:pass@host:port` is rejected, leaving the browser with NO
 * proxy at all). But Tor's `IsolateSOCKSAuth` needs a per-tab username to give
 * each tab its own circuits.
 *
 * So each tab gets a private relay on 127.0.0.1:
 *
 *     Chromium ──(SOCKS5, no auth)──▶ SocksShim ──(SOCKS5 + user/pass)──▶ Tor
 *
 * The shim speaks SOCKS5 on both sides. Toward the browser it accepts the
 * "no authentication" method; toward Tor it offers only "username/password"
 * and sends the tab's unique credentials. Tor, with IsolateSOCKSAuth, then
 * assigns that tab a dedicated circuit pool. The shim never sees plaintext
 * URLs beyond the SOCKS CONNECT target, and it only ever connects to Tor's
 * loopback SOCKS port.
 *
 * Only the CONNECT command is supported (that is all a browser needs); UDP
 * ASSOCIATE and BIND are refused, which also prevents any UDP escape.
 */

const net = require('net');
const { EventEmitter } = require('events');

const VER = 0x05;
const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CMD_NOT_SUPPORTED = 0x07;

/** Promise-based byte reader for a socket. */
class SocketReader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this._waiter = null;
    this._closed = false;
    this._onData = (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._try();
    };
    this._onEnd = () => {
      this._closed = true;
      this._fail(new Error('socket closed'));
    };
    sock.on('data', this._onData);
    sock.on('end', this._onEnd);
    sock.on('close', this._onEnd);
    sock.on('error', this._onEnd);
  }

  read(n) {
    return new Promise((resolve, reject) => {
      this._waiter = { n, resolve, reject };
      this._try();
    });
  }

  _try() {
    if (!this._waiter) return;
    if (this.buf.length >= this._waiter.n) {
      const w = this._waiter;
      this._waiter = null;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(out);
    }
  }

  _fail(err) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.reject(err);
    }
  }

  /** Stop reading; hand back any already-buffered bytes for piping. */
  detach() {
    this.sock.removeListener('data', this._onData);
    this.sock.removeListener('end', this._onEnd);
    this.sock.removeListener('close', this._onEnd);
    this.sock.removeListener('error', this._onEnd);
    const leftover = this.buf;
    this.buf = Buffer.alloc(0);
    return leftover;
  }
}

class SocksShim extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.torHost=127.0.0.1]
   * @param {number} opts.torPort      Tor's real SOCKS port.
   * @param {string} opts.username     Isolation username (per tab).
   * @param {string} opts.password     Isolation password (per tab).
   */
  constructor(opts) {
    super();
    this.torHost = opts.torHost || '127.0.0.1';
    this.torPort = opts.torPort;
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.server = null;
    this.port = null;
    this._sockets = new Set();
  }

  /** Rotate the credentials used for NEW connections (used on New Identity). */
  setCredentials({ username, password }) {
    this.username = username || '';
    this.password = password || '';
  }

  listen(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onClient(sock));
      this.server.once('error', reject);
      this.server.listen(0, host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    for (const s of this._sockets) {
      try {
        s.destroy();
      } catch (_) {}
    }
    this._sockets.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {}
      this.server = null;
    }
  }

  _onClient(client) {
    this._sockets.add(client);
    const cleanup = () => this._sockets.delete(client);
    client.on('close', cleanup);
    client.on('error', () => {
      cleanup();
      try {
        client.destroy();
      } catch (_) {}
    });
    this._handle(client).catch((err) => {
      this.emit('error', err);
      try {
        client.destroy();
      } catch (_) {}
    });
  }

  async _handle(client) {
    const reader = new SocketReader(client);

    // --- 1. Greeting from the browser ------------------------------------
    const head = await reader.read(2);
    if (head[0] !== VER) throw new Error('not a SOCKS5 client');
    const nmethods = head[1];
    const methods = nmethods > 0 ? await reader.read(nmethods) : Buffer.alloc(0);
    if (!methods.includes(METHOD_NONE)) throw new Error('client requires unsupported auth');
    client.write(Buffer.from([VER, METHOD_NONE]));

    // --- 2. CONNECT request from the browser -----------------------------
    const request = await this._readRequest(reader);
    if (request.cmd !== CMD_CONNECT) {
      client.write(Buffer.from([VER, REP_CMD_NOT_SUPPORTED, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
      client.end();
      return;
    }

    // --- 3. Connect to Tor and perform an authenticated handshake --------
    const upstream = await this._connectUpstream(client, request.raw);
    if (!upstream) return;

    // --- 4. Relay: browser <-> Tor ---------------------------------------
    const leftover = reader.detach();
    if (leftover.length) upstream.write(leftover);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  _readRequest(reader) {
    return reader.read(4).then(async (head) => {
      const [ver, cmd, , atyp] = head;
      if (ver !== VER) throw new Error('bad request version');
      let addrField; // address bytes as they must appear on the wire
      let host = '';
      if (atyp === ATYP_IPV4) {
        addrField = await reader.read(4);
        host = [...addrField].join('.');
      } else if (atyp === ATYP_IPV6) {
        addrField = await reader.read(16);
        host = addrField.toString('hex').match(/.{4}/g).join(':');
      } else if (atyp === ATYP_DOMAIN) {
        const len = (await reader.read(1))[0];
        const name = await reader.read(len);
        // Keep the length prefix so the forwarded request stays valid.
        addrField = Buffer.concat([Buffer.from([len]), name]);
        host = name.toString('utf8');
      } else {
        throw new Error('bad address type');
      }
      const port = await reader.read(2);
      const raw = Buffer.concat([head, addrField, port]);
      return { cmd, atyp, host, port: port.readUInt16BE(0), raw };
    });
  }

  async _connectUpstream(client, requestRaw) {
    const upstream = net.connect({ host: this.torHost, port: this.torPort });
    upstream.on('error', () => {
      try {
        client.write(Buffer.from([VER, REP_GENERAL_FAILURE, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
      } catch (_) {}
      client.end();
    });

    const ureader = new SocketReader(upstream);

    // Offer ONLY username/password so Tor treats the stream as isolated.
    upstream.write(Buffer.from([VER, 0x01, METHOD_USERPASS]));
    const chosen = await ureader.read(2);
    if (chosen[0] !== VER || chosen[1] !== METHOD_USERPASS) {
      // Tor refused user/pass; fall back to no-auth so browsing still works.
      // (Isolation is then destination-based only - see README.)
      upstream.destroy();
      return this._connectUpstreamNoAuth(client, requestRaw);
    }

    const user = Buffer.from(this.username, 'utf8');
    const pass = Buffer.from(this.password, 'utf8');
    upstream.write(
      Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass])
    );
    const authReply = await ureader.read(2);
    if (authReply[1] !== 0x00) throw new Error('Tor rejected SOCKS credentials');

    // Forward the browser's CONNECT request verbatim.
    upstream.write(requestRaw);

    // Relay Tor's reply back to the browser.
    const reply = await this._readReply(ureader);
    client.write(reply);
    if (reply[1] !== REP_SUCCESS) {
      upstream.destroy();
      client.end();
      return null;
    }
    return upstream;
  }

  async _connectUpstreamNoAuth(client, requestRaw) {
    const upstream = net.connect({ host: this.torHost, port: this.torPort });
    const ureader = new SocketReader(upstream);
    upstream.write(Buffer.from([VER, 0x01, METHOD_NONE]));
    const chosen = await ureader.read(2);
    if (chosen[1] !== METHOD_NONE) throw new Error('no acceptable SOCKS method');
    upstream.write(requestRaw);
    const reply = await this._readReply(ureader);
    client.write(reply);
    if (reply[1] !== REP_SUCCESS) {
      upstream.destroy();
      client.end();
      return null;
    }
    return upstream;
  }

  async _readReply(reader) {
    const head = await reader.read(4); // ver, rep, rsv, atyp
    const atyp = head[3];
    let addr;
    if (atyp === ATYP_IPV4) addr = await reader.read(4);
    else if (atyp === ATYP_IPV6) addr = await reader.read(16);
    else if (atyp === ATYP_DOMAIN) {
      const len = (await reader.read(1))[0];
      addr = Buffer.concat([Buffer.from([len]), await reader.read(len)]);
    } else throw new Error('bad reply address type');
    const port = await reader.read(2);
    return Buffer.concat([head, addr, port]);
  }
}

module.exports = { SocksShim };
