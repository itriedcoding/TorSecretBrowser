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
    wireMisc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
