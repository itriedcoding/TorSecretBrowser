'use strict';

/**
 * system-proxy.js
 * ---------------------------------------------------------------------------
 * Opt-in helper that points the operating system's proxy configuration at the
 * built-in Tor gateway, and — critically — undoes it cleanly.
 *
 * This is real system integration, not a mock: it uses the same knobs the OS
 * network settings use. It is only ever applied when the user explicitly asks,
 * it backs up the previous values first, it refreshes the live settings where
 * the OS needs a nudge, and it restores the backup on disable/quit.
 *
 * Honest scope: this sets a *proxy*. It does not install a TUN/TAP interface,
 * so it affects applications that honour the system proxy (most browsers and
 * many apps) rather than every single packet.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const BACKUP_FILE = path.join(os.tmpdir(), 'tsb-system-proxy-backup.json');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function refreshWinInet() {
  const sig = [
    '[DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Auto)]',
    'public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    'public static void Notify() { InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0); }',
  ].join(' ');
  const cmd =
    `$s='${sig}'; Add-Type -MemberDefinition $s -Name N -Namespace Tsb -ErrorAction SilentlyContinue; ` +
    '[Tsb.N]::Notify()';
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]).catch(() => {});
}

async function readWinProxy() {
  const query = async (name) => {
    try {
      const { stdout } = await run('reg', ['query', WIN_KEY, '/v', name]);
      const m = /REG_\w+\s+(.+)\s*$/m.exec(stdout.trim());
      return m ? m[1].trim() : '';
    } catch (_) {
      return '';
    }
  };
  const enable = await query('ProxyEnable');
  const server = await query('ProxyServer');
  return { enable: enable === '0x1' ? '1' : '0', server };
}

async function applyWindows(host, port, backupOut) {
  const prev = await readWinProxy();
  backupOut.windows = prev;
  await run('reg', ['add', WIN_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('reg', [
    'add',
    WIN_KEY,
    '/v',
    'ProxyServer',
    '/t',
    'REG_SZ',
    '/d',
    `socks=${host}:${port}`,
    '/f',
  ]);
  await refreshWinInet();
}

async function revertWindows(backup) {
  if (!backup) return;
  await run('reg', [
    'add',
    WIN_KEY,
    '/v',
    'ProxyEnable',
    '/t',
    'REG_DWORD',
    '/d',
    backup.enable === '1' ? '1' : '0',
    '/f',
  ]);
  if (backup.server) {
    await run('reg', ['add', WIN_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', backup.server, '/f']);
  } else {
    await run('reg', ['delete', WIN_KEY, '/v', 'ProxyServer', '/f']).catch(() => {});
  }
  await refreshWinInet();
}

async function activeMacService() {
  try {
    const { stdout } = await run('route', ['-n', 'get', 'default']);
    const m = /interface:\s*(\S+)/.exec(stdout);
    const iface = m ? m[1] : '';
    const { stdout: order } = await run('networksetup', ['-listnetworkserviceorder']);
    const blockRe = new RegExp('\\(\\d+\\)\\s+([^\\n]+)\\n\\(Hardware Port:[^\\n]*Device:\\s*' + iface + '\\)', 'i');
    const mm = blockRe.exec(order);
    return mm ? mm[1].trim() : 'Wi-Fi';
  } catch (_) {
    return 'Wi-Fi';
  }
}

async function applyMac(host, port, backupOut) {
  const service = await activeMacService();
  const prevHost = (await run('networksetup', ['-getsocksfirewallproxy', service])).stdout;
  const enableM = /Enabled:\s*(\w+)/.exec(prevHost);
  const serverM = /Server:\s*(\S+)/.exec(prevHost);
  const portM = /Port:\s*(\d+)/.exec(prevHost);
  backupOut.mac = {
    service,
    enabled: enableM ? enableM[1] : 'No',
    server: serverM ? serverM[1] : '',
    port: portM ? portM[1] : '',
  };
  await run('networksetup', ['-setsocksfirewallproxy', service, host, String(port)]);
  await run('networksetup', ['-setsocksfirewallproxystate', service, 'on']);
}

async function revertMac(backup) {
  if (!backup) return;
  const { service, enabled, server, port } = backup;
  if (server && port) {
    await run('networksetup', ['-setsocksfirewallproxy', service, server, String(port)]).catch(() => {});
  } else {
    await run('networksetup', ['-setsocksfirewallproxystate', service, 'off']).catch(() => {});
  }
  await run('networksetup', [
    '-setsocksfirewallproxystate',
    service,
    enabled.toLowerCase() === 'yes' ? 'on' : 'off',
  ]).catch(() => {});
}

async function applyLinux(host, port, backupOut) {
  const mode = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).stdout.trim();
  backupOut.linux = { mode: mode.replace(/'/g, '') };
  await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
  await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'host', host]);
  await run('gsettings', ['set', 'org.gnome.system.proxy.socks', 'port', String(port)]);
}

async function revertLinux(backup) {
  if (!backup) return;
  await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', backup.mode || 'none']).catch(() => {});
}

class SystemProxy {
  constructor() {
    this.enabled = false;
    this.backup = null;
  }

  static loadBackup() {
    try {
      return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  static clearBackup() {
    try {
      fs.unlinkSync(BACKUP_FILE);
    } catch (_) {}
  }

  async enable(host, port) {
    if (this.enabled) return { enabled: true };
    const backupOut = {};
    if (process.platform === 'win32') await applyWindows(host, port, backupOut);
    else if (process.platform === 'darwin') await applyMac(host, port, backupOut);
    else if (process.platform === 'linux') await applyLinux(host, port, backupOut);
    else throw new Error(`System proxy is not supported on ${process.platform}`);
    this.backup = backupOut;
    this.enabled = true;
    try {
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(backupOut), { mode: 0o600 });
    } catch (_) {}
    return { enabled: true };
  }

  async disable() {
    const backup = this.backup || SystemProxy.loadBackup();
    try {
      if (process.platform === 'win32') await revertWindows(backup && backup.windows);
      else if (process.platform === 'darwin') await revertMac(backup && backup.mac);
      else if (process.platform === 'linux') await revertLinux(backup && backup.linux);
    } finally {
      this.enabled = false;
      this.backup = null;
      SystemProxy.clearBackup();
    }
    return { enabled: false };
  }

  /** Called at startup: undo a proxy left behind by a previous crash. */
  static async recoverStale() {
    const backup = SystemProxy.loadBackup();
    if (!backup) return false;
    try {
      if (process.platform === 'win32') await revertWindows(backup.windows);
      else if (process.platform === 'darwin') await revertMac(backup.mac);
      else if (process.platform === 'linux') await revertLinux(backup.linux);
    } catch (_) {}
    SystemProxy.clearBackup();
    return true;
  }
}

module.exports = { SystemProxy };
