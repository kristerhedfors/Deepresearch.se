// Unit suite for the chat-mode dropdown state (public/js/chat-mode.js) — the
// mode cache, the theming classes, and adopting the server's stored mode. Runs
// without a DOM (module is import-safe); localStorage is stubbed the
// dev-mode.test.js way. The mode TABLE and the wire resolution live in the
// shared core and are tested in chat-mode-core.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DEV_MODE_CLASS } from "./dev-mode.js";
import { MODE_ROOT_CLASSES, MODE_THEMES } from "./mode-theme.js";
import {
  CHAT_MODES,
  CHAT_MODE_KEY,
  CYBER_MODE_CLASS,
  SCI_MODE_CLASS,
  SDK_MODE_CLASS,
  adoptServerChatMode,
  applyChatModeTheme,
  cachedChatMode,
  normalizeChatMode,
  storeChatMode,
} from "./chat-mode.js";

function stubStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

test("normalizeChatMode clamps junk to the fallback", () => {
  assert.deepEqual(CHAT_MODES, ["science", "cyber", "introspection", "sdk", "orchestrator", "outrospection", "models", "lypning"]);
  assert.equal(normalizeChatMode("science"), "science");
  assert.equal(normalizeChatMode("cyber"), "cyber");
  assert.equal(normalizeChatMode("models"), "models");
  assert.equal(normalizeChatMode("lypning"), "lypning");
  assert.equal(normalizeChatMode("orchestrator"), "orchestrator");
  assert.equal(normalizeChatMode("outrospection"), "outrospection");
  assert.equal(normalizeChatMode("sdk"), "sdk");
  assert.equal(normalizeChatMode("swe"), "science"); // retired mode clamps to the default
  assert.equal(normalizeChatMode("hax"), "science");
  // `normal` is RETIRED rather than unknown (chat-mode-core.js
  // RETIRED_CHAT_MODES), so it resolves to its successor even when the caller
  // passes "" as the fallback to ask "did this name a mode at all?".
  assert.equal(normalizeChatMode("normal"), "science");
  assert.equal(normalizeChatMode("normal", ""), "science");
  assert.equal(normalizeChatMode("hax", ""), "");
  assert.equal(normalizeChatMode(undefined, "introspection"), "introspection");
});

test("cachedChatMode: the cached pick, else the default mode", () => {
  const store = stubStorage();
  assert.equal(cachedChatMode(), "science"); // nothing cached — the safe default
  store.set(CHAT_MODE_KEY, "sdk");
  assert.equal(cachedChatMode(), "sdk");
  store.set(CHAT_MODE_KEY, "cyber");
  assert.equal(cachedChatMode(), "cyber");
  store.set(CHAT_MODE_KEY, "science");
  assert.equal(cachedChatMode(), "science"); // an explicit default pick is stored, not absent
  store.set(CHAT_MODE_KEY, "normal");
  assert.equal(cachedChatMode(), "science"); // a browser cached before 2026-08-13
  store.set(CHAT_MODE_KEY, "junk");
  assert.equal(cachedChatMode(), "science"); // a junk cache clamps rather than throwing
  delete globalThis.localStorage;
  assert.equal(cachedChatMode(), "science"); // no storage at all — fail-soft
});

test("applyChatModeTheme: exactly one theme class per mode; persist opt-out honored", () => {
  const store = stubStorage();
  const classes = new Set();
  globalThis.document = {
    documentElement: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
  };
  try {
    assert.equal(applyChatModeTheme("introspection"), "introspection");
    assert.deepEqual([...classes], [DEV_MODE_CLASS]);
    assert.equal(store.get(CHAT_MODE_KEY), "introspection");
    applyChatModeTheme("sdk");
    assert.deepEqual([...classes], [SDK_MODE_CLASS]); // sdk replaces dev-mode — one class only
    applyChatModeTheme("cyber");
    assert.deepEqual([...classes], [CYBER_MODE_CLASS]);
    // No mode leaves the root bare any more: the general mode was the only
    // descriptor with `rootClass: null` and it is retired (2026-08-13), so its
    // id now paints the default mode's class like every other retired value.
    applyChatModeTheme("normal");
    assert.deepEqual([...classes], [SCI_MODE_CLASS]);
    applyChatModeTheme("sdk", { persist: false });
    assert.equal(store.get(CHAT_MODE_KEY), "science"); // read-only apply
  } finally {
    delete globalThis.document;
  }
});

// EVERY ORDERED PAIR, not a sampled path. The bug this pins (2026-08-02) hid in
// the modes the older test above never visited: `applyChatModeTheme` toggled
// five hand-written classes and Deep Science's `sci-mode` was not among them, so
// picking Science left the class off and — because index.html's parse-time
// script DOES apply it — a browser that booted in Science carried `sci-mode`
// into every other agent. The header then showed two mode tags at once and the
// palette, the composer pane and the dropdown text came from different themes.
// Walking the full matrix is what makes a sixth mode's omission fail here
// instead of on a phone.
test("applyChatModeTheme: every mode→mode switch lands on exactly its own class", () => {
  stubStorage();
  const classes = new Set();
  globalThis.document = {
    documentElement: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
  };
  try {
    for (const from of CHAT_MODES) {
      for (const to of CHAT_MODES) {
        classes.clear();
        applyChatModeTheme(from);
        applyChatModeTheme(to);
        const want = MODE_THEMES[to].rootClass;
        assert.deepEqual(
          [...classes],
          want ? [want] : [],
          `${from} → ${to} left [${[...classes]}] on the root, expected ${want || "no theme class"}`,
        );
      }
    }
    // And every class the registry declares is one this module can clear.
    assert.deepEqual([...MODE_ROOT_CLASSES].sort(), [...new Set(MODE_ROOT_CLASSES)].sort());
    assert.ok(MODE_ROOT_CLASSES.includes(SCI_MODE_CLASS));
    assert.ok(MODE_ROOT_CLASSES.includes(CYBER_MODE_CLASS));
  } finally {
    delete globalThis.document;
  }
});

test("adoptServerChatMode: the server's stored mode wins and is cached", () => {
  const store = stubStorage();
  store.set(CHAT_MODE_KEY, "sdk");
  // A mode picked on another device replaces this browser's cache.
  assert.equal(adoptServerChatMode({ chat_mode: "orchestrator" }), "orchestrator");
  assert.equal(store.get(CHAT_MODE_KEY), "orchestrator");
  // The server has already clamped to the DEFAULT mode when the modes are
  // unavailable, so an explicit default is adopted like any other mode — no
  // downgrade rule here. A stored `normal` from before the retirement adopts as
  // the successor rather than being ignored.
  assert.equal(adoptServerChatMode({ chat_mode: "science" }), "science");
  assert.equal(store.get(CHAT_MODE_KEY), "science");
  assert.equal(adoptServerChatMode({ chat_mode: "normal" }), "science");
  assert.equal(store.get(CHAT_MODE_KEY), "science");
});

test("adoptServerChatMode: a payload with no mode leaves the cached pick alone", () => {
  const store = stubStorage();
  store.set(CHAT_MODE_KEY, "introspection");
  // An older or partial /api/settings response must not silently reset the pick.
  assert.equal(adoptServerChatMode({}), "introspection");
  assert.equal(adoptServerChatMode(null), "introspection");
  assert.equal(adoptServerChatMode({ chat_mode: "junk" }), "introspection");
  assert.equal(store.get(CHAT_MODE_KEY), "introspection");
});

test("storeChatMode normalizes before storing", () => {
  const store = stubStorage();
  assert.equal(storeChatMode("junk"), "science");
  assert.equal(store.get(CHAT_MODE_KEY), "science");
  assert.equal(storeChatMode("cyber"), "cyber");
  assert.equal(store.get(CHAT_MODE_KEY), "cyber");
});
