// Developer-mode theme + persistence (public/js/dev-mode.js). Runs in Node
// with tiny localStorage / documentElement stubs — the module is written to be
// import-safe outside a browser (every DOM/storage access is guarded).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEV_MODE_CLASS,
  DEV_MODE_KEY,
  applyDeveloperTheme,
  cachedDeveloperMode,
  storeDeveloperMode,
} from "./dev-mode.js";

/** Minimal localStorage stub with the three methods the module touches. */
function stubStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

/**
 * Minimal document stub: a classList set plus an optional theme-color <meta>.
 * Returns { classes, meta } — meta.content tracks the last value set.
 */
function stubDocument({ withMeta = false } = {}) {
  const set = new Set();
  const meta = withMeta
    ? { content: "#6fc3fd", setAttribute: (_k, v) => (meta.content = v), getAttribute: () => meta.content }
    : null;
  globalThis.document = {
    documentElement: {
      classList: {
        toggle: (cls, on) => {
          if (on) set.add(cls);
          else set.delete(cls);
          return set.has(cls);
        },
        contains: (cls) => set.has(cls),
      },
    },
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
  };
  return { classes: set, meta };
}

function reset() {
  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
}

test("cachedDeveloperMode: false without storage, and false when unset", () => {
  reset();
  assert.equal(cachedDeveloperMode(), false); // no localStorage at all — fail-soft
  stubStorage();
  assert.equal(cachedDeveloperMode(), false); // present but empty
  reset();
});

test("storeDeveloperMode: round-trips through the cache key, removes when off", () => {
  const store = stubStorage();
  storeDeveloperMode(true);
  assert.equal(store.get(DEV_MODE_KEY), "1");
  assert.equal(cachedDeveloperMode(), true);
  storeDeveloperMode(false);
  assert.equal(store.has(DEV_MODE_KEY), false); // removed, not set to "0"
  assert.equal(cachedDeveloperMode(), false);
  reset();
});

test("applyDeveloperTheme: toggles the root class AND persists by default", () => {
  const store = stubStorage();
  const { classes } = stubDocument();
  applyDeveloperTheme(true);
  assert.equal(classes.has(DEV_MODE_CLASS), true);
  assert.equal(store.get(DEV_MODE_KEY), "1");
  applyDeveloperTheme(false);
  assert.equal(classes.has(DEV_MODE_CLASS), false);
  assert.equal(store.has(DEV_MODE_KEY), false);
  reset();
});

test("applyDeveloperTheme: { persist: false } applies the class without writing the cache", () => {
  const store = stubStorage();
  const { classes } = stubDocument();
  applyDeveloperTheme(true, { persist: false });
  assert.equal(classes.has(DEV_MODE_CLASS), true); // theme applied for this page
  assert.equal(store.has(DEV_MODE_KEY), false); // but the cache was not touched
  reset();
});

test("applyDeveloperTheme: re-tints the iOS theme-color meta to match the palette", () => {
  stubStorage();
  const { meta } = stubDocument({ withMeta: true });
  // Run rAF callbacks synchronously so we can observe the settled value.
  globalThis.requestAnimationFrame = (cb) => cb();
  assert.equal(meta.content, "#6fc3fd"); // starts at the default sky blue
  applyDeveloperTheme(true);
  assert.equal(meta.content, "#8b9299"); // settles on the titanium tint
  applyDeveloperTheme(false);
  assert.equal(meta.content, "#6fc3fd"); // and back to the default when off
  reset();
});

test("applyDeveloperTheme: no DOM present is a no-op that still persists", () => {
  const store = stubStorage(); // storage present, document absent
  const applied = applyDeveloperTheme(true);
  assert.equal(applied, true);
  assert.equal(store.get(DEV_MODE_KEY), "1"); // durable part survives a missing DOM
  reset();
});
