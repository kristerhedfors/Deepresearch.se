// Unit suite for the chat-mode dropdown state (public/js/chat-mode.js) — the
// mode cache, the theming classes, and adopting the server's stored mode. Runs
// without a DOM (module is import-safe); localStorage is stubbed the
// dev-mode.test.js way. The mode TABLE and the wire resolution live in the
// shared core and are tested in chat-mode-core.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DEV_MODE_CLASS } from "./dev-mode.js";
import {
  CHAT_MODES,
  CHAT_MODE_KEY,
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
  assert.deepEqual(CHAT_MODES, ["normal", "science", "introspection", "sdk", "orchestrator", "outrospection", "models"]);
  assert.equal(normalizeChatMode("science"), "science");
  assert.equal(normalizeChatMode("models"), "models");
  assert.equal(normalizeChatMode("orchestrator"), "orchestrator");
  assert.equal(normalizeChatMode("outrospection"), "outrospection");
  assert.equal(normalizeChatMode("sdk"), "sdk");
  assert.equal(normalizeChatMode("swe"), "normal"); // retired mode clamps to normal
  assert.equal(normalizeChatMode("hax"), "normal");
  assert.equal(normalizeChatMode(undefined, "introspection"), "introspection");
});

test("cachedChatMode: the cached pick, else normal", () => {
  const store = stubStorage();
  assert.equal(cachedChatMode(), "normal"); // nothing cached — the safe default
  store.set(CHAT_MODE_KEY, "sdk");
  assert.equal(cachedChatMode(), "sdk");
  store.set(CHAT_MODE_KEY, "normal");
  assert.equal(cachedChatMode(), "normal"); // an explicit Normal pick is stored, not absent
  store.set(CHAT_MODE_KEY, "junk");
  assert.equal(cachedChatMode(), "normal"); // a junk cache clamps rather than throwing
  delete globalThis.localStorage;
  assert.equal(cachedChatMode(), "normal"); // no storage at all — fail-soft
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
    applyChatModeTheme("normal");
    assert.deepEqual([...classes], []);
    applyChatModeTheme("sdk", { persist: false });
    assert.equal(store.get(CHAT_MODE_KEY), "normal"); // read-only apply
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
  // The server has already clamped to normal when the modes are unavailable, so
  // an explicit normal is adopted like any other mode — no downgrade rule here.
  assert.equal(adoptServerChatMode({ chat_mode: "normal" }), "normal");
  assert.equal(store.get(CHAT_MODE_KEY), "normal");
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
  assert.equal(storeChatMode("junk"), "normal");
  assert.equal(store.get(CHAT_MODE_KEY), "normal");
});
