/* Tor Secret Browser - site behaviour.
 * No external dependencies, no tracking scripts. Everything here is local. */
(function () {
  'use strict';

  var RELEASE_BASE =
    'https://github.com/itriedcoding/TorSecretBrowser/releases/latest/download/';

  var ASSETS = {
    windows: {
      label: 'Windows 10 / 11 (64-bit)',
      short: 'Windows',
      file: 'TorSecretBrowser-win-x64-setup.exe',
      note: '.exe installer'
    },
    macIntel: {
      label: 'macOS (Intel)',
      short: 'macOS Intel',
      file: 'TorSecretBrowser-mac-x64.dmg',
      note: '.dmg'
    },
    macArm: {
      label: 'macOS (Apple Silicon)',
      short: 'macOS Apple Silicon',
      file: 'TorSecretBrowser-mac-arm64.dmg',
      note: '.dmg'
    },
    linux: {
      label: 'Linux (x86_64)',
      short: 'Linux',
      file: 'TorSecretBrowser-linux-x86_64.AppImage',
      note: '.AppImage'
    }
  };

  function detectOS() {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var uaData = navigator.userAgentData;

    // Client Hints (Chromium) give the most reliable answer.
    if (uaData && uaData.platform) {
      var p = uaData.platform;
      if (/Windows/i.test(p)) return 'windows';
      if (/macOS/i.test(p)) return 'mac';
      if (/Linux|Chrome OS/i.test(p)) return 'linux';
    }
    if (/Windows/i.test(ua) || /Win/i.test(platform)) return 'windows';
    if (/Android/i.test(ua)) return 'linux';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'mac';
    if (/Mac/i.test(ua) || /Mac/i.test(platform)) return 'mac';
    if (/Linux|X11|CrOS/i.test(ua) || /Linux/i.test(platform)) return 'linux';
    return 'windows';
  }

  function url(file) {
    return RELEASE_BASE + file;
  }

  // Resolve "mac" into Intel vs Apple Silicon. There is no reliable API for the
  // CPU on all browsers, so we try to infer Apple Silicon and otherwise point at
  // the universal Intel image (which also runs under Rosetta on Apple Silicon).
  function macVariant() {
    var ua = navigator.userAgent || '';
    // Safari on Apple Silicon reports "Macintosh; ... Version/..." but so does
    // Intel Safari; we cannot be certain, so default to Apple Silicon, which is
    // now the common case, and clearly present both options alongside.
    if (/Macintosh/.test(ua)) return 'macArm';
    return 'macArm';
  }

  function assetFor(os) {
    if (os === 'mac') return ASSETS[macVariant()];
    return ASSETS[os] || ASSETS.windows;
  }

  /* ---------- download wiring ---------- */
  function wireDownloads() {
    var os = detectOS();
    var primary = assetFor(os);

    // Recommended banner on the home / downloads page.
    document.querySelectorAll('[data-recommend]').forEach(function (el) {
      var a = el.querySelector('[data-recommend-link]');
      var name = el.querySelector('[data-recommend-name]');
      var note = el.querySelector('[data-recommend-note]');
      if (a) {
        a.href = url(primary.file);
        a.setAttribute('download', '');
      }
      if (name) name.textContent = primary.label;
      if (note) note.textContent = primary.note + ' \u00b7 direct from the latest GitHub release';
    });

    // Highlight the matching platform card.
    document.querySelectorAll('[data-platform]').forEach(function (el) {
      if (el.getAttribute('data-platform') === os) el.classList.add('recommended');
    });

    // Fill every explicit download link from its data-file attribute.
    document.querySelectorAll('[data-dl]').forEach(function (a) {
      var file = a.getAttribute('data-dl');
      if (file) {
        a.href = url(file);
        a.setAttribute('download', '');
        a.setAttribute('rel', 'noopener');
      }
    });
  }

  /* ---------- mobile nav ---------- */
  function wireNav() {
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', function () {
        var open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      links.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') links.classList.remove('open');
      });
    }

    // active link
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (/\/index\.html$/.test(path)) path = path.replace(/\/index\.html$/, '');
    document.querySelectorAll('.nav-links a[data-nav]').forEach(function (a) {
      var href = a.getAttribute('href').replace(/\/+$/, '') || '/';
      if (href === path || (href !== '/' && path.indexOf(href) === 0)) {
        a.classList.add('active');
      }
    });
  }

  /* ---------- cookie consent ---------- */
  var CONSENT_KEY = 'tsb_consent';

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function writeCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie =
      name + '=' + encodeURIComponent(value) +
      '; expires=' + d.toUTCString() +
      '; path=/; SameSite=Lax';
  }
  function readConsent() {
    try {
      var v = localStorage.getItem(CONSENT_KEY);
      if (v) return v;
    } catch (e) {}
    return readCookie(CONSENT_KEY);
  }

  function wireConsent() {
    var banner = document.getElementById('cookie-banner');
    if (!banner) return;

    if (!readConsent()) {
      // small delay so it does not fight the first paint
      setTimeout(function () { banner.classList.add('show'); }, 500);
    }

    banner.addEventListener('click', function (e) {
      var choice = e.target.getAttribute && e.target.getAttribute('data-consent');
      if (!choice) return;
      try { localStorage.setItem(CONSENT_KEY, choice); } catch (err) {}
      writeCookie(CONSENT_KEY, choice, 180);
      banner.classList.remove('show');
    });
  }

  /* ---------- copy buttons ---------- */
  function wireCopy() {
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sel = btn.getAttribute('data-copy');
        var target = document.querySelector(sel);
        if (!target) return;
        var text = target.innerText;
        var done = function () {
          var old = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = old; }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
          done();
        }
      });
    });
  }

  /* ---------- link checker (links page) ---------- */
  var DDG_ONION =
    'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion';

  function analyzeLink(raw) {
    var text = String(raw || '').trim();
    if (!text) return null;

    var onion = text.match(/^([a-z2-7]+)\.onion$/i);
    if (onion) {
      var name = onion[1];
      if (name.length === 56) {
        return {
          kind: 'ok', label: 'v3 onion address',
          url: 'http://' + text + '/',
          note: 'Tor Secret Browser resolves this over its local Tor daemon. Paste it into the address bar or the new-tab "Open a link" box.'
        };
      }
      if (name.length === 16) {
        return {
          kind: 'bad', label: 'legacy v2 onion',
          url: 'http://' + text + '/',
          note: 'Version 2 onion services were removed from Tor in 2021, so a 16-character address no longer resolves. Ask the service for its current v3 address.'
        };
      }
      return {
        kind: 'warn', label: 'malformed .onion',
        url: null,
        note: 'A v3 onion address is exactly 56 base32 characters followed by ".onion" (a-z and 2-7). Check for typos or missing characters.'
      };
    }

    if (/^https?:\/\//i.test(text)) {
      return {
        kind: 'ok', label: 'clearnet URL',
        url: text,
        note: 'Opens like any other site, but the connection exits through a Tor circuit so the site sees a Tor exit node rather than you.'
      };
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      return {
        kind: 'bad', label: 'unsupported scheme',
        url: null,
        note: 'Only http and https URLs (and plain .onion names) open in the browser. Other schemes are deliberately blocked.'
      };
    }

    if (!/\s/.test(text) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) {
      return {
        kind: 'ok', label: 'clearnet host',
        url: 'http://' + text + '/',
        note: 'The app will open this as http. Add https:// yourself if the site requires a secure connection.'
      };
    }

    return {
      kind: 'warn', label: 'search query',
      url: 'http://' + DDG_ONION + '/?q=' + encodeURIComponent(text),
      note: 'This is not a URL, so it will be sent to DuckDuckGo\u2019s .onion search service \u2014 the search itself runs over Tor.'
    };
  }

  function wireLinkChecker() {
    var input = document.getElementById('link-input');
    var button = document.getElementById('link-check');
    var out = document.getElementById('link-result');
    if (!input || !button || !out) return;

    function render() {
      var result = analyzeLink(input.value);
      if (!result) { out.classList.add('hidden'); return; }
      out.innerHTML = '';
      var badge = document.createElement('span');
      badge.className = 'res-kind ' + result.kind;
      badge.textContent = result.label;
      out.appendChild(badge);
      var p = document.createElement('p');
      p.textContent = result.note;
      out.appendChild(p);
      if (result.url) {
        var code = document.createElement('code');
        code.className = 'res-url';
        code.textContent = result.url;
        out.appendChild(code);
        var copy = document.createElement('button');
        copy.className = 'btn';
        copy.type = 'button';
        copy.textContent = 'Copy URL';
        copy.addEventListener('click', function () {
          var done = function () {
            copy.textContent = 'Copied';
            setTimeout(function () { copy.textContent = 'Copy URL'; }, 1400);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(result.url).then(done, function () {});
          } else {
            var ta = document.createElement('textarea');
            ta.value = result.url;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            done();
          }
        });
        out.appendChild(copy);
      }
      out.classList.remove('hidden');
    }

    button.addEventListener('click', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); render(); }
    });
  }

  /* ---------- on-device file scanner (scan page) ---------- */

  // SHA-256 of the current release's installers, also published as
  // SHA256SUMS.txt on the GitHub release. Used only for the authenticity check.
  var OFFICIAL = {
    'TorSecretBrowser-win-x64-setup.exe':
      { sha256: '5707f8dfd7df23c2fe46611137772711423997deca974e3db2133e6401b1a879', platform: 'Windows 64-bit', version: '1.3.0' },
    'TorSecretBrowser-mac-x64.dmg':
      { sha256: 'ccbd6c7c68c008b754f2d3b446ca1bd962e253a58ee4cb55eef30c8f9a845767', platform: 'macOS Intel', version: '1.3.0' },
    'TorSecretBrowser-mac-arm64.dmg':
      { sha256: 'a3d093f24a5b502329e2b60dafac48c6b943bf477c717e478914ef3ef540ae7f', platform: 'macOS Apple Silicon', version: '1.3.0' },
    'TorSecretBrowser-linux-x86_64.AppImage':
      { sha256: '9fd2c9cd8bce03cb6dcf03df9f71df46ccea1ea01d249aecd7e260539ffcd2da', platform: 'Linux x86_64', version: '1.3.0' }
  };

  var EXT_GROUP = {
    exe: 'pe', dll: 'pe', sys: 'pe', scr: 'pe', com: 'pe', cpl: 'pe', ocx: 'pe',
    appimage: 'elf', so: 'elf', elf: 'elf', run: 'elf',
    dmg: 'dmg', iso: 'iso',
    zip: 'zip', jar: 'zip', apk: 'zip', docx: 'zip', xlsx: 'zip', pptx: 'zip',
    odt: 'zip', ods: 'zip', odp: 'zip', epub: 'zip', whl: 'zip', xpi: 'zip',
    gz: 'gzip', tgz: 'gzip', bz2: 'bzip2', xz: 'xz', zst: 'zstd', '7z': '7z',
    rar: 'rar', cab: 'cab', chm: 'chm', rpm: 'rpm', deb: 'ar', tar: 'tar',
    pdf: 'pdf', rtf: 'rtf', doc: 'ole', xls: 'ole', ppt: 'ole', msi: 'ole', msg: 'ole',
    png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', bmp: 'bmp', webp: 'webp',
    tiff: 'tiff', tif: 'tiff', ico: 'ico',
    ogg: 'ogg', oga: 'ogg', ogv: 'ogg', mp3: 'mp3', flac: 'flac', wav: 'wav',
    avi: 'avi', mp4: 'mp4', mov: 'mp4', m4a: 'mp4', mkv: 'mkv', webm: 'webm',
    woff: 'woff', woff2: 'woff2', ttf: 'ttf', otf: 'otf',
    lnk: 'lnk',
    txt: 'text', md: 'text', csv: 'text', json: 'text', xml: 'text',
    html: 'text', htm: 'text', css: 'text', log: 'text',
    sh: 'script', bash: 'script', zsh: 'script', py: 'script', rb: 'script',
    pl: 'script', ps1: 'script', psm1: 'script', bat: 'script', cmd: 'script',
    js: 'script', mjs: 'script', vbs: 'script', vbe: 'script', wsf: 'script'
  };

  var ZIP_DANGEROUS = /\.(exe|dll|scr|com|pif|bat|cmd|vbs|vbe|jse?|wsf|wsh|ps1|psm1|msi|jar|lnk|hta|apk|sys|elf|run|sh|bin)$/i;
  var ZIP_MACRO = /\.(docm|xlsm|pptm|xlsb|dotm|xltm)$/i;

  var PATTERNS = [
    { re: /(?:powershell|pwsh)[^\r\n]{0,80}?-(?:enc|encodedcommand|nop|w\s+hidden|windowstyle\s+hidden)\b/i,
      sev: 'bad', label: 'Encoded PowerShell command',
      detail: 'A base64-encoded or hidden-window PowerShell command is a very common malware launcher.' },
    { re: /-encodedcommand\b/i, sev: 'bad', label: 'Encoded PowerShell command',
      detail: 'PowerShell was asked to run a base64-encoded command, which hides its real intent.' },
    { re: /frombase64string\b/i, sev: 'warn', label: 'Base64 blob decoding',
      detail: 'The content decodes a base64 payload at runtime, a common obfuscation technique.' },
    { re: /(?:downloadstring|downloadfile|invoke-webrequest|start-bitstransfer|invoke-expression|\biex)\s*\(/i,
      sev: 'warn', label: 'Download-and-run command',
      detail: 'The file fetches and executes remote content, a frequent dropper pattern.' },
    { re: /\bwscript\.shell\b|\bshell\.application\b/i, sev: 'warn', label: 'Windows Script Host object',
      detail: 'Creates a shell object to run commands or other programs.' },
    { re: /createobject\s*\(/i, sev: 'warn', label: 'COM object creation',
      detail: 'Instantiates a COM object, often used by script-based malware.' },
    { re: /(?:cmd\.exe|cmd)\s*\/c\b/i, sev: 'warn', label: 'Spawns a shell command',
      detail: 'Runs a command through cmd.exe.' },
    { re: /(?:reg\s+add|schtasks\s+\/create|\bsc\s+create)\b/i, sev: 'warn', label: 'Persistence command',
      detail: 'Adds a registry key, scheduled task or service so code runs again later.' },
    { re: /eval\s*\(\s*atob\s*\(/i, sev: 'warn', label: 'Obfuscated JavaScript',
      detail: 'Decodes and executes a base64 string with eval().' },
    { re: /document\.write\s*\(\s*unescape\b/i, sev: 'warn', label: 'Obfuscated JavaScript',
      detail: 'Writes decoded content into the page using unescape().' },
    { re: /string\.fromcharcode\s*\(/i, sev: 'info', label: 'Character-code construction',
      detail: 'Builds strings from character codes, sometimes used to hide text.' },
    { re: /vbaproject\.bin/i, sev: 'warn', label: 'Office macro stream',
      detail: 'Contains a VBA project, i.e. a document macro.' },
    { re: /\bautoopen\b|\bdocument_open\b|\bworkbook_open\b/i, sev: 'warn', label: 'Office macro entry point',
      detail: 'A macro routine that runs automatically when the document opens.' },
    { re: /http:\/\/\d{1,3}(?:\.\d{1,3}){3}/, sev: 'warn', label: 'URL to a raw IP address',
      detail: 'Hardcoded plaintext URLs to bare IP addresses are common in malware.' },
    { re: /[a-z2-7]{56}\.onion/i, sev: 'info', label: 'Embedded .onion address',
      detail: 'A Tor onion address is embedded in the file. Legitimate for Tor tools; noteworthy elsewhere.' }
  ];

  function toHex(u8) {
    var h = '', i;
    for (i = 0; i < u8.length; i++) h += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return h;
  }

  function bytesToLatin1(u8, start, end) {
    var s = '', CH = 8192, i;
    for (i = start; i < end; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, end)));
    }
    return s;
  }

  function starts(u8, off, sig) {
    if (off + sig.length > u8.length) return false;
    for (var i = 0; i < sig.length; i++) if (u8[off + i] !== sig[i]) return false;
    return true;
  }

  function ascii(u8, off, str) {
    return starts(u8, off, Array.prototype.map.call(str, function (c) { return c.charCodeAt(0); }));
  }

  function detectType(u8) {
    var n = u8.length;
    if (n < 4) return { name: 'Empty or truncated file', category: 'unknown', group: 'unknown' };

    if (starts(u8, 0, [0x4d, 0x5a])) {
      var pe = false;
      if (n > 0x40) {
        var lf = u8[0x3c] | (u8[0x3d] << 8) | (u8[0x3e] << 16) | (u8[0x3f] << 24);
        if (lf > 0 && lf + 4 < n && u8[lf] === 0x50 && u8[lf + 1] === 0x45) pe = true;
      }
      return { name: pe ? 'Windows executable (PE)' : 'DOS/Windows executable (MZ)', category: 'executable', group: 'pe' };
    }
    if (starts(u8, 0, [0x7f, 0x45, 0x4c, 0x46])) {
      if (n > 11 && ascii(u8, 8, 'AI') && u8[10] === 0x02) {
        return { name: 'Linux AppImage (type 2)', category: 'executable', group: 'elf' };
      }
      return { name: 'Linux/Unix executable (ELF)', category: 'executable', group: 'elf' };
    }
    if (starts(u8, 0, [0xfe, 0xed, 0xfa, 0xce]) || starts(u8, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
        starts(u8, 0, [0xce, 0xfa, 0xed, 0xfe]) || starts(u8, 0, [0xcf, 0xfa, 0xed, 0xfe])) {
      return { name: 'macOS executable (Mach-O)', category: 'executable', group: 'macho' };
    }
    if (starts(u8, 0, [0xca, 0xfe, 0xba, 0xbe])) {
      return { name: 'Java class', category: 'executable', group: 'java' };
    }
    if (starts(u8, 0, [0x50, 0x4b, 0x03, 0x04]) || starts(u8, 0, [0x50, 0x4b, 0x05, 0x06]) ||
        starts(u8, 0, [0x50, 0x4b, 0x07, 0x08])) {
      return { name: 'ZIP archive', category: 'archive', group: 'zip' };
    }
    if (starts(u8, 0, [0x1f, 0x8b])) return { name: 'gzip archive', category: 'archive', group: 'gzip' };
    if (ascii(u8, 0, 'BZh')) return { name: 'bzip2 archive', category: 'archive', group: 'bzip2' };
    if (starts(u8, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { name: '7-Zip archive', category: 'archive', group: '7z' };
    if (ascii(u8, 0, 'Rar!')) return { name: 'RAR archive', category: 'archive', group: 'rar' };
    if (starts(u8, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { name: 'xz archive', category: 'archive', group: 'xz' };
    if (starts(u8, 0, [0x28, 0xb5, 0x2f, 0xfd])) return { name: 'Zstandard archive', category: 'archive', group: 'zstd' };
    if (ascii(u8, 0, 'MSCF')) return { name: 'Microsoft Cabinet (CAB)', category: 'archive', group: 'cab' };
    if (ascii(u8, 0, 'ITSF')) return { name: 'Compiled HTML help (CHM)', category: 'archive', group: 'chm' };
    if (ascii(u8, 0, '!<arch>')) return { name: 'Unix ar archive (deb)', category: 'archive', group: 'ar' };
    if (starts(u8, 0, [0xed, 0xab, 0xee, 0xdb])) return { name: 'RPM package', category: 'archive', group: 'rpm' };
    if (n > 262 && ascii(u8, 257, 'ustar')) return { name: 'tar archive', category: 'archive', group: 'tar' };

    if (n > 512 && bytesToLatin1(u8, Math.max(0, n - 1024), n).indexOf('koly') !== -1) {
      return { name: 'Apple disk image (DMG)', category: 'disk', group: 'dmg' };
    }
    if (n > 32774 && ascii(u8, 32769, 'CD001')) return { name: 'ISO 9660 image', category: 'disk', group: 'iso' };

    if (ascii(u8, 0, '%PDF')) return { name: 'PDF document', category: 'document', group: 'pdf' };
    if (starts(u8, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      return { name: 'OLE compound file (legacy Office / MSI)', category: 'document', group: 'ole' };
    }
    if (ascii(u8, 0, '{\\rtf')) return { name: 'RTF document', category: 'document', group: 'rtf' };
    if (ascii(u8, 0, 'SQLite format 3')) return { name: 'SQLite database', category: 'data', group: 'sqlite' };

    if (starts(u8, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { name: 'PNG image', category: 'image', group: 'png' };
    if (starts(u8, 0, [0xff, 0xd8, 0xff])) return { name: 'JPEG image', category: 'image', group: 'jpeg' };
    if (ascii(u8, 0, 'GIF8')) return { name: 'GIF image', category: 'image', group: 'gif' };
    if (starts(u8, 0, [0x42, 0x4d])) return { name: 'BMP image', category: 'image', group: 'bmp' };
    if (ascii(u8, 0, 'RIFF') && ascii(u8, 8, 'WEBP')) return { name: 'WebP image', category: 'image', group: 'webp' };
    if (starts(u8, 0, [0x49, 0x49, 0x2a, 0x00]) || starts(u8, 0, [0x4d, 0x4d, 0x00, 0x2a])) return { name: 'TIFF image', category: 'image', group: 'tiff' };
    if (starts(u8, 0, [0x00, 0x00, 0x01, 0x00])) return { name: 'ICO icon', category: 'image', group: 'ico' };

    if (ascii(u8, 0, 'OggS')) return { name: 'Ogg media', category: 'media', group: 'ogg' };
    if (ascii(u8, 0, 'ID3') || starts(u8, 0, [0xff, 0xfb])) return { name: 'MP3 audio', category: 'media', group: 'mp3' };
    if (ascii(u8, 0, 'fLaC')) return { name: 'FLAC audio', category: 'media', group: 'flac' };
    if (ascii(u8, 0, 'RIFF') && ascii(u8, 8, 'WAVE')) return { name: 'WAV audio', category: 'media', group: 'wav' };
    if (ascii(u8, 0, 'RIFF') && ascii(u8, 8, 'AVI ')) return { name: 'AVI video', category: 'media', group: 'avi' };
    if (n > 12 && ascii(u8, 4, 'ftyp')) return { name: 'MP4/QuickTime video', category: 'media', group: 'mp4' };
    if (starts(u8, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { name: 'Matroska/WebM video', category: 'media', group: 'mkv' };

    if (ascii(u8, 0, 'wOFF')) return { name: 'WOFF font', category: 'font', group: 'woff' };
    if (ascii(u8, 0, 'wOF2')) return { name: 'WOFF2 font', category: 'font', group: 'woff2' };
    if (starts(u8, 0, [0x00, 0x01, 0x00, 0x00])) return { name: 'TrueType font', category: 'font', group: 'ttf' };
    if (ascii(u8, 0, 'OTTO')) return { name: 'OpenType font', category: 'font', group: 'otf' };

    if (starts(u8, 0, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) {
      return { name: 'Windows shortcut (LNK)', category: 'executable', group: 'lnk' };
    }
    if (ascii(u8, 0, '#!')) return { name: 'Script (shebang)', category: 'script', group: 'shebang' };

    var sample = bytesToLatin1(u8, 0, Math.min(n, 4096));
    var printable = 0;
    for (var i = 0; i < sample.length; i++) {
      var c = sample.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable++;
    }
    if (sample.length && printable / sample.length > 0.93) {
      return { name: 'Plain text / source', category: 'text', group: 'text' };
    }
    return { name: 'Unknown / binary', category: 'unknown', group: 'unknown' };
  }

  function groupsCompatible(expected, detected) {
    if (expected === detected) return true;
    var set = expected + '>' + detected;
    return set === 'script>text' || set === 'text>script' ||
           set === 'script>shebang' || set === 'shebang>script' ||
           set === 'shebang>text' || set === 'text>shebang';
  }

  function zipEntries(u8) {
    var n = u8.length, i;
    var minEocd = Math.max(0, n - 66000), eocd = -1;
    for (i = n - 22; i >= minEocd; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    var cdOff = u8[eocd + 16] | (u8[eocd + 17] << 8) | (u8[eocd + 18] << 16) | (u8[eocd + 19] << 24);
    var p = cdOff, names = [], guard = 0;
    while (p + 46 <= n && guard < 50000) {
      if (!(u8[p] === 0x50 && u8[p + 1] === 0x4b && u8[p + 2] === 0x01 && u8[p + 3] === 0x02)) break;
      var nameLen = u8[p + 28] | (u8[p + 29] << 8);
      var extraLen = u8[p + 30] | (u8[p + 31] << 8);
      var commentLen = u8[p + 32] | (u8[p + 33] << 8);
      if (p + 46 + nameLen > n) break;
      names.push(bytesToLatin1(u8, p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      guard++;
    }
    return names.length ? names : null;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'], v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 2 : 1) + ' ' + units[i] + ' (' + bytes.toLocaleString() + ' bytes)';
  }

  function readBytes(file) {
    if (file.arrayBuffer) {
      return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function hashBytes(algo, bytes) {
    if (!(window.crypto && window.crypto.subtle)) {
      return Promise.reject(new Error('Web Crypto is unavailable, so files cannot be hashed. Serve this site over HTTPS.'));
    }
    return window.crypto.subtle.digest(algo, bytes).then(function (d) { return toHex(new Uint8Array(d)); });
  }

  function analyse(file, bytes, sha256, sha1) {
    var info = detectType(bytes);
    var findings = [];
    function add(sev, label, detail) { findings.push({ sev: sev, label: label, detail: detail }); }

    // Authenticity against the published release checksums.
    var official = OFFICIAL[file.name];
    if (official) {
      if (official.sha256 === sha256) {
        add('ok', 'Authentic Tor Secret Browser installer',
          'The SHA-256 matches the published checksum for the ' + official.platform +
          ' build of release v' + official.version + '. The file is exactly as we published it.');
      } else {
        add('bad', 'Fake or modified installer',
          'This file has the name of the official ' + official.platform + ' installer for v' +
          official.version + ', but its SHA-256 does not match the published value. Do not run it; ' +
          'download again from the download page or GitHub.');
      }
    } else if (/^TorSecretBrowser-.*\.(exe|dmg|appimage)$/i.test(file.name)) {
      add('warn', 'Unknown Tor Secret Browser build',
        'This looks like a Tor Secret Browser installer, but it is not the current published file. ' +
        'Compare its SHA-256 with SHA256SUMS.txt on the release page.');
    }

    // True file type versus the extension.
    var extMatch = /\.([a-z0-9]+)$/i.exec(file.name || '');
    var ext = extMatch ? extMatch[1].toLowerCase() : '';
    var expected = EXT_GROUP[ext];
    if (expected && info.group !== 'unknown' && !groupsCompatible(expected, info.group)) {
      var dangerous = info.category === 'executable';
      add(dangerous ? 'bad' : 'warn', 'Extension does not match the file',
        'The file is named ".' + ext + '" but its content is really ' + info.name + '.' +
        (dangerous ? ' An executable disguised with a harmless-looking extension is a classic malware trick.' : ''));
    }

    // Archive contents.
    if (info.group === 'zip') {
      var names = zipEntries(bytes);
      if (names) {
        var risky = names.filter(function (nm) { return ZIP_DANGEROUS.test(nm); });
        var macros = names.filter(function (nm) { return ZIP_MACRO.test(nm); });
        if (risky.length) {
          add('warn', 'Executables inside the archive',
            risky.length + ' runnable file' + (risky.length > 1 ? 's' : '') + ' inside: ' +
            risky.slice(0, 8).join(', ') + (risky.length > 8 ? ', …' : '') +
            '. Legitimate archives can contain these, so check you trust the source.');
        }
        if (macros.length) {
          add('warn', 'Macro-enabled documents inside the archive',
            macros.slice(0, 8).join(', ') + '. Documents with macros can run code when opened.');
        }
        add('info', 'Archive contents listed',
          names.length + ' entr' + (names.length === 1 ? 'y' : 'ies') + ' in the central directory.');
      }
    }

    // Content indicators.
    var scanLen = Math.min(bytes.length, 8 * 1024 * 1024);
    var text = bytesToLatin1(bytes, 0, scanLen);
    var lower = text.toLowerCase();
    var seen = {};
    for (var i = 0; i < PATTERNS.length; i++) {
      var p = PATTERNS[i];
      if (p.re.test(lower) && !seen[p.label]) { seen[p.label] = true; add(p.sev, p.label, p.detail); }
    }

    // Embedded executable / archive signatures.
    if (info.group !== 'pe' && lower.indexOf('pe\u0000\u0000') > 1024) {
      add('warn', 'Embedded executable',
        'A Windows PE header was found inside a file that is not itself an executable.');
    }
    if (info.group !== 'zip' && lower.indexOf('pk\u0003\u0004') > 0) {
      add('info', 'Embedded archive', 'A ZIP stream is embedded inside this file.');
    }

    // Filename tricks.
    if (/\u202e/.test(file.name)) {
      add('bad', 'Right-to-left override in the filename',
        'The filename contains a Unicode RTL character, a technique used to make one extension look like another.');
    }
    if (/\.(jpg|jpeg|png|gif|bmp|pdf|txt|doc|docx|xls|xlsx|mp3|mp4|avi|mov|csv)\s*\.(exe|scr|com|pif|bat|cmd|js|jse|vbs|vbe|wsf|wsh|ps1|jar|msi|lnk|hta)$/i.test(file.name)) {
      add('bad', 'Double extension',
        'The filename ends in a harmless extension followed by a real executable one.');
    }

    findings.sort(function (a, b) {
      var rank = { bad: 0, warn: 1, info: 2, ok: 3 };
      return rank[a.sev] - rank[b.sev];
    });
    return { info: info, findings: findings, ext: ext, expected: expected };
  }

  function sevTitle(sev) {
    return sev === 'ok' ? 'Verified' : sev === 'info' ? 'Info' : sev === 'warn' ? 'Review' : 'Suspicious';
  }

  function renderScan(file, res, out) {
    var rows = out;
    rows.innerHTML = '';

    var hasBad = res.findings.some(function (f) { return f.sev === 'bad'; });
    var hasWarn = res.findings.some(function (f) { return f.sev === 'warn'; });
    var verdict = hasBad ? 'bad' : hasWarn ? 'warn' : 'ok';
    var verdictText = hasBad
      ? 'Suspicious file — do not open it until you understand the warnings below.'
      : hasWarn
        ? 'Some things are worth a closer look before you open this file.'
        : 'The on-device checks found no indicators. This is not a guarantee of safety — see the note below.';

    var v = document.createElement('div');
    v.className = 'verdict ' + verdict;
    var vh = document.createElement('strong');
    vh.textContent = verdict === 'bad' ? 'Suspicious' : verdict === 'warn' ? 'Review recommended' : 'No indicators found';
    var vp = document.createElement('span');
    vp.textContent = verdictText;
    v.appendChild(vh); v.appendChild(vp);
    rows.appendChild(v);

    var dl = document.createElement('dl');
    dl.className = 'scan-meta';
    function meta(k, val, cls) {
      var dt = document.createElement('dt'); dt.textContent = k;
      var dd = document.createElement('dd');
      if (cls) dd.className = cls;
      if (val instanceof Node) dd.appendChild(val); else dd.textContent = val;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    meta('File name', file.name || '(no name)');
    meta('Size', formatSize(file.size));
    meta('Detected type', res.info.name);
    var extText;
    if (!res.expected) extText = res.ext ? '.' + res.ext + ' (not a known extension)' : 'No extension';
    else if (res.info.group === 'unknown') extText = '.' + res.ext + ' — content could not be identified';
    else if (groupsCompatible(res.expected, res.info.group)) extText = '.' + res.ext + ' — matches';
    else extText = '.' + res.ext + ' — does not match the content';
    meta('Extension', extText, /match the content|not a known/.test(extText) ? 'bad' : '');
    meta('SHA-256', shaCode(res.sha256));
    meta('SHA-1', shaCode(res.sha1));
    rows.appendChild(dl);

    function shaCode(val) {
      var c = document.createElement('code');
      c.className = 'scan-hash';
      c.textContent = val;
      return c;
    }

    if (res.findings.length) {
      var ul = document.createElement('ul');
      ul.className = 'findings';
      res.findings.forEach(function (f) {
        var li = document.createElement('li');
        li.className = 'finding sev-' + f.sev;
        var dot = document.createElement('span');
        dot.className = 'dot';
        dot.setAttribute('aria-hidden', 'true');
        var body = document.createElement('div');
        var lab = document.createElement('span');
        lab.className = 'f-label';
        lab.textContent = sevTitle(f.sev) + ': ' + f.label;
        var det = document.createElement('p');
        det.textContent = f.detail;
        body.appendChild(lab); body.appendChild(det);
        li.appendChild(dot); li.appendChild(body);
        ul.appendChild(li);
      });
      rows.appendChild(ul);
    }

    var foot = document.createElement('p');
    foot.className = 'scan-foot';
    foot.textContent = 'Analysed locally in your browser. The file was not uploaded. ' +
      'Heuristic scanning cannot prove a file is safe; it only reports the indicators above.';
    rows.appendChild(foot);

    out.classList.remove('hidden');
  }

  function wireScanner() {
    var drop = document.getElementById('scan-drop');
    var input = document.getElementById('scan-file');
    var out = document.getElementById('scan-result');
    if (!drop || !input || !out) return;

    function run(file) {
      if (!file) return;
      out.classList.remove('hidden');
      out.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'scan-loading';
      loading.textContent = 'Reading and analysing ' + (file.name || 'file') + '…';
      out.appendChild(loading);

      var started = Date.now();
      readBytes(file).then(function (bytes) {
        return Promise.all([hashBytes('SHA-256', bytes), hashBytes('SHA-1', bytes)]).then(function (h) {
          return { bytes: bytes, sha256: h[0], sha1: h[1] };
        });
      }).then(function (r) {
        var result = analyse(file, r.bytes, r.sha256, r.sha1);
        result.elapsed = Date.now() - started;
        renderScan(file, result, out);
      }).catch(function (err) {
        out.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'scan-error';
        p.textContent = 'Could not analyse this file: ' + (err && err.message ? err.message : String(err));
        out.appendChild(p);
      });
    }

    input.addEventListener('change', function () {
      if (input.files && input.files[0]) run(input.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) run(e.dataTransfer.files[0]);
    });
  }

  /* ---------- misc ---------- */
  function wireMisc() {
    var y = document.getElementById('year');
    if (y) y.textContent = new Date().getFullYear();
  }

  function init() {
    wireDownloads();
    wireNav();
    wireConsent();
    wireCopy();
    wireLinkChecker();
    wireScanner();
    wireMisc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
