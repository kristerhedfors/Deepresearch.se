// The iOS bar-tint re-assert helper (public/js/bar-tint.js). Runs in Node with
// tiny document/window stubs injected through wireBarTint's doc/win params —
// what's pinned here is the SHAPE of the fix for the 2026-07-17 recurrence:
// the nudge is layered (first frame + load + pageshow + visibility + lagged
// timers), each nudge is a real changed-then-target two-step (WebKit only
// re-evaluates the tint on an actual content change), and the meta always
// lands back on the target color.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BAR_TINT_DELAYS_MS, offTint, wireBarTint } from "./bar-tint.js";

/** Meta stub recording every content value ever set. */
function stubMeta(initial) {
  const meta = {
    content: initial,
    history: /** @type {string[]} */ ([]),
    setAttribute(_k, v) {
      meta.content = v;
      meta.history.push(v);
    },
    getAttribute: () => meta.content,
  };
  return meta;
}

/** Document stub: theme-color meta + visibility + listener registry. */
function stubDoc(meta) {
  const listeners = new Map();
  return {
    visibilityState: "visible",
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    fire: (ev) => listeners.get(ev)?.(),
    listeners,
  };
}

/** Window stub: rAF and timers run only when the test flushes them. */
function stubWin() {
  const listeners = new Map();
  const rafQueue = [];
  const timers = [];
  return {
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    fire: (ev) => listeners.get(ev)?.(),
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    flushRaf() {
      while (rafQueue.length) rafQueue.shift()();
    },
    listeners,
    timers,
  };
}

test("offTint: perturbs only the last hex digit, f steps down", () => {
  assert.equal(offTint("#c3b091"), "#c3b092"); // the khaki pair the 07-10 fix shipped
  assert.equal(offTint("#6fc3fd"), "#6fc3fe"); // the Se/rver blue
  assert.equal(offTint("#ffffff"), "#fffffe"); // f wraps DOWN, stays valid hex
  assert.equal(offTint("khaki"), "khaki"); // non-hex tail left alone
});

test("wireBarTint: no theme-color meta → null, nothing throws", () => {
  const win = stubWin();
  const doc = stubDoc(null);
  assert.equal(wireBarTint("#c3b091", doc, win), null);
});

test("wireBarTint: first-frame nudge is the changed-then-target two-step", () => {
  const meta = stubMeta("#c3b091");
  const win = stubWin();
  const nudge = wireBarTint("#c3b091", stubDoc(meta), win);
  assert.equal(typeof nudge, "function");
  assert.deepEqual(meta.history, []); // nothing before the first frame
  win.flushRaf(); // boot rAF runs the nudge, its inner rAF restores the target
  assert.deepEqual(meta.history, ["#c3b092", "#c3b091"]);
  assert.equal(meta.content, "#c3b091"); // always lands on the real color
});

test("wireBarTint: re-nudges on load, pageshow (bfcache), and visible", () => {
  const meta = stubMeta("#6fc3fd");
  const win = stubWin();
  const doc = stubDoc(meta);
  wireBarTint("#6fc3fd", doc, win);
  win.flushRaf();
  const afterBoot = meta.history.length;

  for (const ev of ["load", "pageshow"]) {
    win.fire(ev);
    win.flushRaf();
  }
  doc.fire("visibilitychange"); // visible → nudges
  win.flushRaf();
  assert.equal(meta.history.length, afterBoot + 6); // 3 nudges × two-step
  assert.equal(meta.content, "#6fc3fd");

  doc.visibilityState = "hidden"; // going hidden must NOT nudge
  doc.fire("visibilitychange");
  win.flushRaf();
  assert.equal(meta.history.length, afterBoot + 6);
});

test("wireBarTint: lagged timers sit past Safari's chrome transition", () => {
  const meta = stubMeta("#c3b091");
  const win = stubWin();
  wireBarTint("#c3b091", stubDoc(meta), win);
  assert.deepEqual(
    win.timers.map((t) => t.ms),
    BAR_TINT_DELAYS_MS,
  );
  assert.ok(BAR_TINT_DELAYS_MS.every((ms) => ms >= 500)); // after the ~300ms transition window
  for (const t of win.timers) t.fn();
  win.flushRaf();
  assert.equal(meta.content, "#c3b091");
});
