// Unit tests for the shared search-SOURCE preference (public/js/search-source.js):
// the pure normalizer, the storage helpers under a fake localStorage (and with
// storage missing entirely, which is a real browser state — a locked-down
// Safari — not a hypothetical), and the boolean "Exa web search" settings knob
// layered over them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SEARCH_SOURCE,
  EXA_SETTING_INFO,
  SEARCH_SOURCES,
  SEARCH_SOURCE_KEY,
  exaStatusText,
  getExaEnabled,
  getSearchSource,
  normalizeSearchSource,
  setExaEnabled,
  setSearchSource,
} from "./search-source.js";

/** Installs a fake localStorage for one test and restores whatever was there. */
function withStorage(fn, store = new Map()) {
  const orig = /** @type {any} */ (globalThis).localStorage;
  /** @type {any} */ (globalThis).localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    return fn(store);
  } finally {
    if (orig === undefined) delete (/** @type {any} */ (globalThis).localStorage);
    else /** @type {any} */ (globalThis).localStorage = orig;
  }
}

test("the source ids mirror the server's user-selectable set, Exa first and default", () => {
  assert.deepEqual(SEARCH_SOURCES, ["exa", "cloudflare"]);
  assert.equal(DEFAULT_SEARCH_SOURCE, "exa");
});

test("normalizeSearchSource accepts known ids only", () => {
  assert.equal(normalizeSearchSource("exa"), "exa");
  assert.equal(normalizeSearchSource(" CLOUDFLARE "), "cloudflare");
  for (const bad of ["searxng", "exa_compatible", "", "nope", null, undefined, 3, {}]) {
    assert.equal(normalizeSearchSource(bad), "");
  }
});

test("getSearchSource defaults to Exa, reads a stored pick, and ignores a junk one", () => {
  withStorage(() => assert.equal(getSearchSource(), "exa"));
  withStorage(() => assert.equal(getSearchSource(), "cloudflare"), new Map([[SEARCH_SOURCE_KEY, "cloudflare"]]));
  withStorage(() => assert.equal(getSearchSource(), "exa"), new Map([[SEARCH_SOURCE_KEY, "searxng"]]));
});

test("setSearchSource stores a known id and falls back to the default otherwise", () => {
  withStorage((store) => {
    assert.equal(setSearchSource("cloudflare"), "cloudflare");
    assert.equal(store.get(SEARCH_SOURCE_KEY), "cloudflare");
    assert.equal(setSearchSource("searxng"), "exa"); // never stores an unknown id
    assert.equal(store.get(SEARCH_SOURCE_KEY), "exa");
  });
});

test("storage being unavailable degrades to the default instead of throwing", () => {
  const orig = /** @type {any} */ (globalThis).localStorage;
  delete (/** @type {any} */ (globalThis).localStorage);
  try {
    assert.equal(getSearchSource(), "exa");
    assert.equal(setSearchSource("cloudflare"), "cloudflare"); // reported, just not persisted
    assert.equal(getExaEnabled(), true); // the knob still reads as its default
  } finally {
    if (orig !== undefined) /** @type {any} */ (globalThis).localStorage = orig;
  }
});

// ---- the "Exa web search" settings knob ------------------------------------

test("the Exa knob is ON by default, and OFF means the Worker backend", () => {
  withStorage(() => assert.equal(getExaEnabled(), true)); // nothing stored yet
  withStorage((store) => {
    assert.equal(setExaEnabled(false), false);
    assert.equal(store.get(SEARCH_SOURCE_KEY), "cloudflare");
    assert.equal(getExaEnabled(), false);
    assert.equal(getSearchSource(), "cloudflare"); // what actually rides the wire

    assert.equal(setExaEnabled(true), true);
    assert.equal(store.get(SEARCH_SOURCE_KEY), "exa");
    assert.equal(getExaEnabled(), true);
    assert.equal(getSearchSource(), "exa");
  });
});

test("a stored junk source reads as the default (knob on), not as off", () => {
  withStorage(() => assert.equal(getExaEnabled(), true), new Map([[SEARCH_SOURCE_KEY, "searxng"]]));
});

test("the knob's shared copy names both engines and distinguishes itself from the web knob", () => {
  assert.match(EXA_SETTING_INFO, /Exa/);
  assert.match(EXA_SETTING_INFO, /Worker/);
  assert.match(EXA_SETTING_INFO, /web knob/); // says what it is NOT
  assert.notEqual(exaStatusText(true), exaStatusText(false));
  assert.match(exaStatusText(false), /Worker/);
});
