'use strict';

/**
 * socks-client.js
 * ---------------------------------------------------------------------------
 * Minimal SOCKS5 *client* used in two places:
 *   - net-test.js      : prove Tor can reach a clearnet host and a .onion
 *   - vpn-gateway.js   : answer an HTTP CONNECT by tunnelling to Tor
 *
 * It performs the full RFC 1928 handshake and, when configured, RFC 1929
 * username/password authentication (which is what Tor's IsolateSOCKSAuth
 * keys circuits on). On success it hands back the live socket plus any bytes
 * that arrived after the CONNECT reply, so the caller can start piping with
 * nothing lost.
 */

const net = require('net');

const REP_MESSAGES = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

/**
 * @param {object} opts
 * @param {string} [opts.socksHost=127.0.0.1]
 * @param {number} opts.socksPort
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {string} opts.targetHost
 * @param {number} [opts.targetPort=80]
 * @param {number} [opts.timeoutMs=25000]
 * @returns {Promise<{socket:import('net').Socket, leftover:Buffer, ms:number}>}
 */
function openTunnel(opts) {
  const {
    socksHost = '127.0.0.1',
    socksPort,
    username = '',
    password = '',
    targetHost,
    targetPort = 80,
    timeoutMs = 25000,
  } = opts;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host: socksHost, port: socksPort });
    let buf = Buffer.alloc(0);
    let phase = 'method'; // method -> auth -> connect
    let settled = false;

    const cleanup = () => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onEarlyError);
      sock.removeListener('close', onEarlyClose);
      clearTimeout(timer);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        sock.destroy();
      } catch (_) {}
      err.ms = Date.now() - started;
      reject(err);
    };
    const onEarlyError = (e) => fail(new Error(e.code || e.message));
    const onEarlyClose = () => fail(new Error('connection closed before it was established'));
    const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);

    sock.on('error', onEarlyError);
    sock.on('close', onEarlyClose);

    sock.on('connect', () => {
      const useAuth = !!(username || password);
      sock.write(useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });

    const sendConnect = () => {
      const host = Buffer.from(targetHost, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(targetPort, 0);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
    };

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (phase === 'method') {
          if (buf.length < 2) return;
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x02) {
            phase = 'auth';
            const u = Buffer.from(username, 'utf8');
            const p = Buffer.from(password, 'utf8');
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          } else if (method === 0x00) {
            phase = 'connect';
            sendConnect();
          } else if (method === 0xff) {
            fail(new Error('proxy rejected all offered authentication methods'));
          } else {
            fail(new Error(`unexpected SOCKS method 0x${method.toString(16)}`));
          }
        }

        if (phase === 'auth') {
          if (buf.length < 2) return;
          const status = buf[1];
          buf = buf.subarray(2);
          if (status !== 0x00) {
            fail(new Error('proxy rejected the SOCKS credentials'));
            return;
          }
          phase = 'connect';
          sendConnect();
        }

        if (phase === 'connect') {
          if (buf.length < 4) return;
          const rep = buf[1];
          const atyp = buf[3];
          let need;
          if (atyp === 0x01) need = 4 + 4 + 2;
          else if (atyp === 0x04) need = 4 + 16 + 2;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            need = 4 + 1 + buf[4] + 2;
          } else {
            fail(new Error('bad reply address type'));
            return;
          }
          if (buf.length < need) return;
          if (rep !== 0x00) {
            fail(new Error(REP_MESSAGES[rep] || `SOCKS failure 0x${rep.toString(16)}`));
            return;
          }
          const leftover = buf.subarray(need);
          // Success: hand the socket over fully unwrapped.
          settled = true;
          cleanup();
          resolve({ socket: sock, leftover, ms: Date.now() - started });
        }
      } catch (err) {
        fail(err);
      }
    }

    sock.on('data', onData);
  });
}

module.exports = { openTunnel, REP_MESSAGES };
