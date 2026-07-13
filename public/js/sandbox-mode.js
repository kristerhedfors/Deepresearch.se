// @ts-check
// The experimental execution-sandbox knob's CLIENT cache + the cross-origin-
// isolation self-heal — the sandbox counterpart of dev-mode.js.
//
// WHY THIS EXISTS (the bug it fixes). The CheerpX sandbox needs the page to be
// cross-origin isolated (COEP `require-corp`), which the server only sends for
// /rver when the `bash_lite_mcp` knob is on. The knob is remembered
// SERVER-SIDE, but that answer only arrives after /api/settings resolves — one
// network round-trip INTO the page load. The old self-heal (app.js) fired only
// after that resolve, so there was a window on every cold load where the knob
// is really on, the page is NOT yet isolated, and settings hasn't answered — a
// send in that window silently can't boot the VM and falls back to a plain
// web-search answer with no sandbox activity at all. Observed live: chat_logs
// #306 came back `coi:false, sab:false, bl:false` on the SAME client build
// that worked 23 s later once isolated (#307).
//
// The fix, mirroring dev-mode.js: mirror the knob into localStorage
// (`dr_bash_lite`) so a returning sandbox user's isolation self-heal can fire
// SYNCHRONOUSLY at first paint from the cache — before settings resolves and
// before a send can land on a non-isolated page. loadSettings() then
// reconciles the cache with the server's authoritative value (a flip on
// another device, or a first-ever enable with no cache yet).
//
// Import-safe in Node (the unit test runs without a browser): every
// location / sessionStorage / localStorage access is guarded and fails soft.

/** The localStorage key mirroring the server's bash_lite_mcp knob. */
export const SANDBOX_MODE_KEY = "dr_bash_lite";
/** The one-shot sessionStorage guard against a COEP reload loop. */
export const COEP_RELOAD_GUARD = "dr_coep_reload";

/**
 * The locally-cached sandbox-knob state — the synchronous answer used at first
 * paint before /api/settings resolves. False (the safe default: no isolation
 * self-heal) when there is no cache or storage is unavailable.
 * @returns {boolean}
 */
export function cachedSandboxMode() {
  try {
    return globalThis.localStorage?.getItem(SANDBOX_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Mirror the sandbox-knob state into localStorage (removed when off, so the
 * default absence reads as off). Fail-soft — private-mode storage throwing
 * must never break the toggle or the boot.
 * @param {boolean} on
 * @returns {boolean} the stored value (echoed for chaining)
 */
export function storeSandboxMode(on) {
  try {
    if (on) globalThis.localStorage?.setItem(SANDBOX_MODE_KEY, "1");
    else globalThis.localStorage?.removeItem(SANDBOX_MODE_KEY);
  } catch {
    /* storage unavailable — the boot self-heal below still reads window state */
  }
  return !!on;
}

/**
 * Pure decision: should a page that WANTS the sandbox but is NOT cross-origin
 * isolated navigate to a fresh ?_coep= URL to fetch the isolated shell? Kept
 * separate from the navigation so it is directly unit-testable.
 * @param {{ want: boolean, isolated: boolean, guarded: boolean }} state
 * @returns {boolean}
 */
export function shouldIsolate({ want, isolated, guarded }) {
  return !!want && !isolated && !guarded;
}

/**
 * Perform the isolation self-heal when the sandbox is wanted but the page isn't
 * isolated: set the one-shot reload guard (so a server that never sends COEP
 * can't loop), then navigate to a FRESH `?_coep=<ts>` URL.
 *
 * NOT `location.reload()`: on iOS an installed PWA (and Safari/Firefox bfcache)
 * re-serves a device-cached shell that predates the COEP header, so reload
 * keeps returning the same non-isolated copy (skill incident #7). A distinct
 * URL forces a real network fetch of /rver, which the server sends isolated.
 *
 * `resetGuard` clears the one-shot guard first — a bfcache restore is a fresh
 * chance to isolate, so the pageshow caller passes it. Returns true iff it
 * navigated. Fully guarded for Node (no window/location/sessionStorage there).
 * @param {boolean} want the sandbox knob (cached or server) is on
 * @param {{ resetGuard?: boolean }} [opts]
 * @returns {boolean}
 */
export function isolateForSandbox(want, { resetGuard = false } = {}) {
  try {
    const ss = globalThis.sessionStorage;
    if (resetGuard) ss?.removeItem?.(COEP_RELOAD_GUARD);
    const guarded = ss?.getItem?.(COEP_RELOAD_GUARD) === "1";
    const isolated = globalThis.crossOriginIsolated === true;
    if (!shouldIsolate({ want, isolated, guarded })) return false;
    ss?.setItem?.(COEP_RELOAD_GUARD, "1");
    const loc = globalThis.location;
    if (!loc?.replace) return false;
    loc.replace(loc.pathname + "?_coep=" + Date.now());
    return true;
  } catch {
    return false; // any storage/navigation failure → no self-heal (fail-soft)
  }
}

/**
 * Clear the one-shot reload guard — called once the page IS isolated, so a
 * later loss of isolation (a bfcache resume) may self-heal again. Fail-soft.
 * @returns {void}
 */
export function clearIsolationGuard() {
  try {
    if (globalThis.crossOriginIsolated === true) {
      globalThis.sessionStorage?.removeItem?.(COEP_RELOAD_GUARD);
    }
  } catch {
    /* no sessionStorage — nothing to clear */
  }
}
