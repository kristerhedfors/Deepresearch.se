// Unit suite for the chat-mode dropdown state (public/js/chat-mode.js) — the
// Normal / Introspection / SDK / SWE mode cache, theming classes, and the
// settings reconcile. Runs without a DOM (module is import-safe); localStorage
// is stubbed the dev-mode.test.js way.
import test from "node:test";
import assert from "node:assert/strict";
import { DEV_MODE_CLASS, DEV_MODE_KEY } from "./dev-mode.js";
import {
  CHAT_MODES,
  CHAT_MODE_KEY,
  SDK_MODE_CLASS,
  SWE_MODE_CLASS,
  applyChatModeTheme,
  cachedChatMode,
  normalizeChatMode,
  reconcileChatMode,
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
  assert.deepEqual(CHAT_MODES, ["normal", "introspection", "sdk", "swe"]);
  assert.equal(normalizeChatMode("sdk"), "sdk");
  assert.equal(normalizeChatMode("swe"), "swe");
  assert.equal(normalizeChatMode("hax"), "normal");
  assert.equal(normalizeChatMode(undefined, "introspection"), "introspection");
});

test("cachedChatMode: stored choice wins; else the dev-mode cache maps to introspection", () => {
  const store = stubStorage();
  assert.equal(cachedChatMode(), "normal");
  store.set(DEV_MODE_KEY, "1");
  assert.equal(cachedChatMode(), "introspection"); // legacy knob-on default
  store.set(CHAT_MODE_KEY, "sdk");
  assert.equal(cachedChatMode(), "sdk"); // explicit choice beats the knob
  store.set(CHAT_MODE_KEY, "normal");
  assert.equal(cachedChatMode(), "normal"); // explicit Normal survives knob-on
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
    assert.deepEqual([...classes], [SDK_MODE_CLASS]);
    applyChatModeTheme("swe");
    assert.deepEqual([...classes], [SWE_MODE_CLASS]); // swe replaces sdk — one class only
    applyChatModeTheme("normal");
    assert.deepEqual([...classes], []);
    applyChatModeTheme("sdk", { persist: false });
    assert.equal(store.get(CHAT_MODE_KEY), "normal"); // read-only apply
  } finally {
    delete globalThis.document;
  }
});

test("reconcileChatMode: a knob turned off elsewhere downgrades a non-normal mode", () => {
  const store = stubStorage();
  store.set(CHAT_MODE_KEY, "sdk");
  assert.equal(reconcileChatMode(false), "normal");
  assert.equal(store.get(CHAT_MODE_KEY), "normal");
  store.set(CHAT_MODE_KEY, "introspection");
  assert.equal(reconcileChatMode(true), "introspection");
  store.delete(CHAT_MODE_KEY);
  store.set(DEV_MODE_KEY, "1");
  assert.equal(reconcileChatMode(true), "introspection"); // legacy default kept
});

test("storeChatMode normalizes before storing", () => {
  const store = stubStorage();
  assert.equal(storeChatMode("junk"), "normal");
  assert.equal(store.get(CHAT_MODE_KEY), "normal");
});
