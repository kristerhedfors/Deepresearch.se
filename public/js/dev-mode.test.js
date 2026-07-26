// Introspection-mode cue (public/js/dev-mode.js). Runs in Node with a tiny
// documentElement stub — the module is written to be import-safe outside a
// browser (every DOM access is guarded).
//
// The module used to own a SECOND cache (`dr_dev_mode`) mirroring the retired
// developer_mode knob; the 2026-07-26 mode collapse left it with just the class
// toggle, so the persistence tests moved to chat-mode.test.js (one cache key,
// `dr_chat_mode`, owned by chat-mode.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEV_MODE_CLASS, applyDeveloperTheme } from "./dev-mode.js";

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
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
}

test("applyDeveloperTheme: toggles the root class", () => {
  const { classes } = stubDocument();
  applyDeveloperTheme(true);
  assert.equal(classes.has(DEV_MODE_CLASS), true);
  applyDeveloperTheme(false);
  assert.equal(classes.has(DEV_MODE_CLASS), false);
  reset();
});

test("applyDeveloperTheme: writes NO cache of its own", () => {
  // The mode cache belongs to chat-mode.js. If this module ever writes storage
  // again, the three-copies-of-one-choice problem the collapse removed is back.
  const writes = [];
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (k, v) => writes.push(["set", k, v]),
    removeItem: (k) => writes.push(["remove", k]),
  };
  stubDocument();
  applyDeveloperTheme(true);
  applyDeveloperTheme(false);
  assert.deepEqual(writes, []);
  delete globalThis.localStorage;
  reset();
});

test("applyDeveloperTheme: leaves the iOS theme-color meta UNTOUCHED (background unchanged)", () => {
  const { classes, meta } = stubDocument({ withMeta: true });
  globalThis.requestAnimationFrame = (cb) => cb();
  assert.equal(meta.content, "#6fc3fd"); // the site's sky-blue bar tint
  applyDeveloperTheme(true);
  assert.equal(classes.has(DEV_MODE_CLASS), true); // the cue is the class (composer tint) …
  assert.equal(meta.content, "#6fc3fd"); // … NOT a status-bar re-tint — the field stays blue
  applyDeveloperTheme(false);
  assert.equal(meta.content, "#6fc3fd");
  reset();
});

test("applyDeveloperTheme: no DOM present is a fail-soft no-op", () => {
  reset(); // document absent
  assert.equal(applyDeveloperTheme(true), true);
  assert.equal(applyDeveloperTheme(false), false);
});
