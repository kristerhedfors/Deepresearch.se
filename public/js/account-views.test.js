// Unit suite for the Settings view's pure HTML builders (account-views.js) —
// specifically the Chat mode dropdown that replaced the Introspection on/off
// switch (owner directive, 2026-07-18). The render helpers are pure string
// builders; the module is import-safe in Node (its DOM/localStorage touches are
// guarded), so these run without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { settingSelectRow, renderConfigKnobs } from "./account-views.js";

test("settingSelectRow renders a labeled <select> with the value selected", () => {
  const html = settingSelectRow({
    id: "modesetting",
    label: "Chat mode",
    options: [
      { value: "normal", label: "Normal" },
      { value: "swe", label: "SWE" },
    ],
    value: "swe",
    disabled: false,
    popId: "modepop",
    info: "info",
  });
  assert.match(html, /<select class="settings-select" id="modesetting"/);
  assert.match(html, /<option value="swe" selected>SWE<\/option>/);
  assert.match(html, /<option value="normal">Normal<\/option>/);
  assert.doesNotMatch(html, /disabled/); // enabled row
});

test("settingSelectRow honors disabled + escapes option text", () => {
  const html = settingSelectRow({
    id: "x",
    label: "L",
    options: [{ value: "a", label: "A & <b>" }],
    value: "a",
    disabled: true,
    popId: "p",
    info: "i",
  });
  assert.match(html, /<select[^>]* disabled>/);
  assert.match(html, /A &amp; &lt;b&gt;/);
});

test("renderConfigKnobs: the mode dropdown replaced the Introspection switch (signed-in)", () => {
  const html = renderConfigKnobs({ email: "a@b.c" });
  assert.match(html, /id="modesetting"/); // the new dropdown
  assert.match(html, /Chat mode/);
  assert.match(html, /<option value="introspection">/);
  assert.match(html, /<option value="sdk">/);
  assert.match(html, /<option value="swe">/);
  assert.doesNotMatch(html, /id="devknob"/); // the old toggle is gone
});

test("renderConfigKnobs: break-glass admin gets an ACTIVE mode dropdown (not a disabled switch)", () => {
  const html = renderConfigKnobs({ email: null });
  assert.match(html, /id="modesetting"/);
  assert.doesNotMatch(html, /<select class="settings-select" id="modesetting"[^>]* disabled>/); // active, mode is browser-local
  assert.doesNotMatch(html, /id="devknob"/);
});
