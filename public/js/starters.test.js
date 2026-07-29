// Unit suite for the starter strip's DOM half (public/js/starters.js) — the
// half of "new questions every time" the pure core cannot enforce.
//
// selectEvalBatch is what ORDERS the pool (starters-core.test.js pins that);
// this file pins the thing that makes the ordering bite: the strip records the
// four it rendered AS IT RENDERS THEM, so the next render — a new chat, a mode
// switch, "Four more" — cannot reach for them again. A selector that sinks seen
// entries is useless if nothing ever marks one seen, and that bug would be
// invisible to the core suite.
//
// The DOM is stubbed rather than pulled in: this module builds a handful of
// elements and reads nothing back off layout, so a ~40-line stub covers it and
// the suite stays dependency-free (invariant 5). localStorage is stubbed the
// dev-mode.test.js way.

import test from "node:test";
import assert from "node:assert/strict";

import { EVAL_KEY, renderStarterStrip } from "./starters.js";

/** A DOM node with just enough of the surface starters.js touches. */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.className = "";
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = "";
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  /** Depth-first, class-selector only — the only form this module uses. */
  querySelector(sel) {
    const want = sel.replace(/^\./, "");
    for (const c of this.children) {
      if (String(c.className).split(/\s+/).includes(want)) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  /** Every descendant carrying a class — the test's own reader. */
  all(cls) {
    return this.children.flatMap((c) => [
      ...(String(c.className).split(/\s+/).includes(cls) ? [c] : []),
      ...c.all(cls),
    ]);
  }
}

function stubDom() {
  globalThis.document = {
    createElement: (tag) => new El(tag),
    createTextNode: (t) => {
      const n = new El("#text");
      n.textContent = t;
      return n;
    },
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  store.set(EVAL_KEY, "on");
  return store;
}

/** Render one evaluation strip into a fresh mount; give back the chips' ids. */
function renderOnce() {
  const mount = new El("div");
  const n = renderStarterStrip({ mount, compose: () => {}, platform: undefined });
  return { mount, n, ids: mount.all("starter").map((c) => c.dataset.starter) };
}

test("evaluation mode: every render serves questions this browser has not seen", () => {
  // The owner directive (2026-07-29) at the layer that implements it. Ten
  // renders in a row, nothing repeating: the strip has to be writing the seen
  // ledger as it draws, not waiting for the reviewer to do something.
  stubDom();
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const { ids, n } = renderOnce();
    assert.equal(n, 4, `render ${i} drew ${n} chips`);
    for (const id of ids) {
      assert.ok(!seen.has(id), `render ${i} repeated ${id}`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, 40);
});

test("evaluation mode: the seen ledger is what carries the guarantee", () => {
  const store = stubDom();
  const first = renderOnce().ids;
  const ledger = JSON.parse(store.get("dr_starter_eval_seen"));
  assert.deepEqual(Object.keys(ledger).sort(), [...first].sort());
  assert.ok(Object.values(ledger).every((v) => v === 1));
  // A browser that loses the ledger falls back to the cursor alone, which is
  // the pre-existing behaviour rather than a crash.
  store.delete("dr_starter_eval_seen");
  assert.equal(renderOnce().n, 4);
});

test("evaluation mode: a chip carries its #XP tag, agent and band — and no rating control", () => {
  stubDom();
  const { mount } = renderOnce();
  const bands = mount.all("starter-band");
  assert.equal(bands.length, 4);
  for (const b of bands) assert.match(b.textContent, /^#XP-\d+ · [a-z-]+ · /);
  // The verdict is a "feedback ..." message in the chat the chip opens; a
  // 👍/👎 pair here would put it back in localStorage where nobody reads it.
  assert.equal(mount.all("starter-rate").length, 0);
  assert.equal(mount.all("starter-vote").length, 0);
  assert.match(mount.querySelector(".starter-eval-head").textContent, /feedback/);
});

test("evaluation mode: a chip composes the tagged text and follows the starter to its agent", () => {
  stubDom();
  const mount = new El("div");
  const composed = [];
  const modes = [];
  renderStarterStrip({
    mount,
    compose: (t) => composed.push(t),
    setMode: (m) => modes.push(m),
  });
  const chip = mount.all("starter")[0];
  chip.listeners.click[0]();
  assert.equal(composed.length, 1);
  assert.match(composed[0], /^#XP-\d+ \S/);
  assert.equal(modes.length, 1, "a cross-agent batch has to take the app to the starter's own agent");
});

test("evaluation mode: the retired verdict store seeds the ledger once, then goes away", () => {
  // A starter someone rated 👍/👎 was certainly shown to them, so it must not
  // come back round as if it were new — and leaving the old blob in place would
  // be a small lie about where the verdicts went.
  const store = stubDom();
  const rated = JSON.parse(store.get("dr_starter_eval_seen") || "null") || {};
  assert.deepEqual(rated, {});
  store.set("dr_starter_verdicts", JSON.stringify({ "int-pipeline": { v: "good" } }));
  const { ids } = renderOnce();
  assert.ok(!ids.includes("int-pipeline"), "a previously rated starter came back as unseen");
  assert.equal(store.get("dr_starter_verdicts"), undefined);
  assert.ok(JSON.parse(store.get("dr_starter_eval_seen"))["int-pipeline"] >= 1);
});

test("the ordinary visitor strip is untouched by all of this: four chips, no tags", () => {
  const store = stubDom();
  store.set(EVAL_KEY, "off");
  const mount = new El("div");
  const composed = [];
  const n = renderStarterStrip({ mount, compose: (t) => composed.push(t), mode: "normal", lang: "en" });
  assert.equal(n, 4);
  assert.equal(mount.all("starter-band").length, 0, "band labels belong to the review batch only");
  mount.all("starter")[0].listeners.click[0]();
  // A visitor's first message must not carry an identifier they never asked
  // about — the pick signal is local-only and this is the byte it promises is
  // not on the wire.
  assert.doesNotMatch(composed[0], /#XP-/);
});
