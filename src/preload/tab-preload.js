'use strict';

/**
 * tab-preload.js
 * ---------------------------------------------------------------------------
 * Runs in the isolated world of every web page. It deliberately exposes
 * NOTHING to page scripts (contextIsolation is on, so nothing can leak).
 *
 * All active hardening - removing WebRTC objects, smoothing navigator
 * properties - is injected into the page's *main* world from the main
 * process (see privacy.buildHardeningScript + tabs._injectHardening). This
 * file exists as the preload anchor and as a place for future, page-facing
 * behaviour that must run before document scripts.
 */

// Nothing to expose. Intentionally empty beyond a load beacon for debugging.
if (process.env.TSB_DEBUG) {
  // eslint-disable-next-line no-console
  console.log('[tsb] tab preload loaded');
}
