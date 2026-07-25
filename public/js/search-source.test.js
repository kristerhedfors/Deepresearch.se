// Unit tests for the shared search-SOURCE preference (public/js/search-source.js):
// the pure normalizer + picker markup, and the storage helpers under a fake
// localStorage (and with storage missing entirely, which is a real browser
// state — a locked-down Safari — not a hypothetical).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SEARCH_SOURCE,
  SEARCH_SOURCES,
  SEARCH_SOURCE_KEY,
  getSearchSource,
  normalizeSearchSource,
  searchSourcePickerHtml,
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

test("the option set mirrors the server's user-selectable ids, Exa first and default", () => {
  assert.deepEqual(SEARCH_SOURCES.map((s) => s.id), ["exa", "cloudflare"]);
  assert.equal(DEFAULT_SEARCH_SOURCE, "exa");
  for (const s of SEARCH_SOURCES) {
    assert.ok(s.label && s.note, `${s.id} needs a label and a note`);
  }
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
  } finally {
    if (orig !== undefined) /** @type {any} */ (globalThis).localStorage = orig;
  }
});

test("searchSourcePickerHtml checks exactly the effective source and names its group", () => {
  const html = searchSourcePickerHtml("cloudflare", "drcsrc");
  assert.equal((html.match(/ checked/g) || []).length, 1);
  assert.match(html, /value="cloudflare" checked/);
  assert.match(html, /name="drcsrc"/);
  assert.match(html, /role="radiogroup"/);
  for (const s of SEARCH_SOURCES) assert.ok(html.includes(s.label), `${s.id} label rendered`);

  // An unknown/absent selection renders as the default rather than nothing
  // checked — a radio group with no selection is a dead control.
  assert.match(searchSourcePickerHtml("searxng"), /value="exa" checked/);
  assert.match(searchSourcePickerHtml(""), /value="exa" checked/);
});
