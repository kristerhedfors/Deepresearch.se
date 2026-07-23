// Regression suite for the "Original ⇄ Cleaned" docs toggle (doc-variant.js).
//
// The bug: apply() reflects the active variant onto <html> as a styling hook
// (document.documentElement.setAttribute("data-doc-variant", …)). That makes
// the root element ALSO match the [data-doc-variant] selector apply() uses to
// find inline content blocks. On the next toggle the root's stored (previous)
// variant differed from the new one, so it got .hidden=true — blanking the
// whole page. Reloading reset html.hidden; toggling again re-hid it. That was
// the reported "touching the knob turns the screen white" crash.
//
// Runs without a real DOM: a tiny fake models the ONE behavior that matters —
// querySelectorAll("[data-doc-variant]") returns every element currently
// carrying the attribute, INCLUDING documentElement once apply() has stamped
// it. Without the fix, this test would see html.hidden flip to true.
import test from "node:test";
import assert from "node:assert/strict";

function makeEl(tag) {
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(),
    hidden: false,
    _attrs: attrs,
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    classList: { toggle() {} },
  };
}

// Fresh globals per test; import is cached, but the module resolves document/
// window/localStorage dynamically from globalThis at call time.
function setup() {
  const html = makeEl("html");
  const origBlock = makeEl("div");
  origBlock.setAttribute("data-doc-variant", "original");
  const cleanBlock = makeEl("div");
  cleanBlock.setAttribute("data-doc-variant", "clean");
  const registry = [origBlock, cleanBlock, html]; // html last: matches only once stamped

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
  };
  globalThis.document = {
    documentElement: html,
    readyState: "complete",
    addEventListener() {},
    getElementById: () => null,
    // querySelector is only consulted by the auto-init opt-in probe; returning
    // null keeps import inert so the test drives setDocVariant itself.
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === "[data-doc-variant]") return registry.filter((e) => e._attrs.has("data-doc-variant"));
      return []; // ".dv-pill button" etc.
    },
    createElement: () => makeEl("div"),
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  return { html, origBlock, cleanBlock };
}

test("toggling variants never hides the documentElement (white-screen crash)", async () => {
  const { html, origBlock, cleanBlock } = setup();
  const { setDocVariant } = await import("./doc-variant.js");

  setDocVariant("original");
  assert.equal(html.hidden, false, "root visible after first apply");
  assert.equal(origBlock.hidden, false);
  assert.equal(cleanBlock.hidden, true);
  // apply() stamped the root — it now matches the block selector.
  assert.equal(html.getAttribute("data-doc-variant"), "original");

  // The toggle that used to crash: root carries "original", new variant "clean".
  setDocVariant("clean");
  assert.equal(html.hidden, false, "root MUST stay visible after toggle — the crash");
  assert.equal(origBlock.hidden, true);
  assert.equal(cleanBlock.hidden, false);
  assert.equal(html.getAttribute("data-doc-variant"), "clean");

  // And back again — still never blanks.
  setDocVariant("original");
  assert.equal(html.hidden, false, "root stays visible toggling back");
  assert.equal(origBlock.hidden, false);
  assert.equal(cleanBlock.hidden, true);
});

test("variant persists to localStorage and clamps junk to original", async () => {
  setup();
  const { setDocVariant, getDocVariant } = await import("./doc-variant.js");
  assert.equal(setDocVariant("clean"), "clean");
  assert.equal(getDocVariant(), "clean");
  assert.equal(setDocVariant("nonsense"), "original"); // clamps
  assert.equal(getDocVariant(), "original");
});
