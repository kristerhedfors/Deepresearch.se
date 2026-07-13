// Execution-sandbox knob cache + the cross-origin-isolation self-heal
// (public/js/sandbox-mode.js). Runs in Node with tiny localStorage /
// sessionStorage / location stubs — the module is written to be import-safe
// outside a browser (every storage/location/window access is guarded).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COEP_RELOAD_GUARD,
  SANDBOX_MODE_KEY,
  cachedSandboxMode,
  clearIsolationGuard,
  isolateForSandbox,
  shouldIsolate,
  storeSandboxMode,
} from "./sandbox-mode.js";

/** Minimal storage stub with the methods the module touches. */
function stubStorage() {
  const store = new Map();
  return {
    store,
    api: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
}

/** Install session storage + a recording location + isolation flag on globalThis. */
function stubEnv({ isolated = false, guarded = false } = {}) {
  const session = stubStorage();
  if (guarded) session.store.set(COEP_RELOAD_GUARD, "1");
  const nav = { count: 0, url: "" };
  globalThis.sessionStorage = session.api;
  globalThis.crossOriginIsolated = isolated;
  globalThis.location = {
    pathname: "/rver",
    replace: (u) => {
      nav.count++;
      nav.url = u;
    },
  };
  return { session, nav };
}

function reset() {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  delete globalThis.location;
  delete globalThis.crossOriginIsolated;
}

// ---- the cache (mirrors dev-mode.js) ----------------------------------------

test("cachedSandboxMode: false without storage, and false when unset", () => {
  reset();
  assert.equal(cachedSandboxMode(), false); // no localStorage at all — fail-soft
  globalThis.localStorage = stubStorage().api;
  assert.equal(cachedSandboxMode(), false); // present but empty
  reset();
});

test("storeSandboxMode: round-trips through the cache key, removes when off", () => {
  const { store, api } = stubStorage();
  globalThis.localStorage = api;
  storeSandboxMode(true);
  assert.equal(store.get(SANDBOX_MODE_KEY), "1");
  assert.equal(cachedSandboxMode(), true);
  storeSandboxMode(false);
  assert.equal(store.has(SANDBOX_MODE_KEY), false); // removed, not set to "0"
  assert.equal(cachedSandboxMode(), false);
  reset();
});

// ---- shouldIsolate (the pure decision) --------------------------------------

test("shouldIsolate: only when wanted AND not isolated AND not already guarded", () => {
  assert.equal(shouldIsolate({ want: true, isolated: false, guarded: false }), true);
  assert.equal(shouldIsolate({ want: false, isolated: false, guarded: false }), false); // sandbox off
  assert.equal(shouldIsolate({ want: true, isolated: true, guarded: false }), false); // already isolated
  assert.equal(shouldIsolate({ want: true, isolated: false, guarded: true }), false); // one-shot spent
});

// ---- isolateForSandbox (the guarded navigation) -----------------------------

test("isolateForSandbox: navigates to a fresh ?_coep= URL and sets the guard", () => {
  const { session, nav } = stubEnv({ isolated: false, guarded: false });
  const did = isolateForSandbox(true);
  assert.equal(did, true);
  assert.equal(nav.count, 1);
  assert.match(nav.url, /^\/rver\?_coep=\d+$/);
  assert.equal(session.store.get(COEP_RELOAD_GUARD), "1"); // one-shot armed
  reset();
});

test("isolateForSandbox: no-op when the sandbox knob is off", () => {
  const { nav } = stubEnv({ isolated: false });
  assert.equal(isolateForSandbox(false), false);
  assert.equal(nav.count, 0);
  reset();
});

test("isolateForSandbox: no-op when already isolated", () => {
  const { nav } = stubEnv({ isolated: true });
  assert.equal(isolateForSandbox(true), false);
  assert.equal(nav.count, 0);
  reset();
});

test("isolateForSandbox: no-op when the one-shot guard is already set (no loop)", () => {
  const { nav } = stubEnv({ isolated: false, guarded: true });
  assert.equal(isolateForSandbox(true), false);
  assert.equal(nav.count, 0);
  reset();
});

test("isolateForSandbox: resetGuard clears a spent guard so a bfcache restore retries", () => {
  const { nav } = stubEnv({ isolated: false, guarded: true });
  assert.equal(isolateForSandbox(true, { resetGuard: true }), true);
  assert.equal(nav.count, 1);
  reset();
});

test("isolateForSandbox: fail-soft with no browser globals present", () => {
  reset(); // no sessionStorage / location / crossOriginIsolated
  assert.equal(isolateForSandbox(true), false);
  assert.doesNotThrow(() => isolateForSandbox(true, { resetGuard: true }));
  reset();
});

// ---- clearIsolationGuard ----------------------------------------------------

test("clearIsolationGuard: clears the guard only once the page is isolated", () => {
  const { session } = stubEnv({ isolated: false, guarded: true });
  clearIsolationGuard();
  assert.equal(session.store.get(COEP_RELOAD_GUARD), "1"); // not isolated → left armed
  globalThis.crossOriginIsolated = true;
  clearIsolationGuard();
  assert.equal(session.store.has(COEP_RELOAD_GUARD), false); // isolated → cleared
  reset();
});
