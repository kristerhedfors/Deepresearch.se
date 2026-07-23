// Unit suite for the Settings view's pure HTML builders (account-views.js) —
// specifically the Chat mode dropdown that replaced the Introspection on/off
// switch (owner directive, 2026-07-18). The render helpers are pure string
// builders; the module is import-safe in Node (its DOM/localStorage touches are
// guarded), so these run without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { settingSelectRow, renderConfigKnobs, renderSummary } from "./account-views.js";

const baseMe = (notifications) => ({
  email: "a@b.c",
  role: "user",
  windows: { h5: { budget_pct: null, searches: 0, searches_limit: 0, reset: 0 } },
  db_configured: true,
  notifications,
});

test("renderSummary: Messages count excludes feedback replies (badge total folds them in, the message center does not)", () => {
  // A feedback reply is the ONLY unread item: it lights the header badge, but
  // the message center has nothing to show — so the Messages button must not
  // claim a count / highlight, or clicking it opens an empty view.
  const html = renderSummary(baseMe({ unread_messages: 0, unread_feedback: 1, total: 1 }));
  assert.match(html, /<button id="messagesbtn" type="button">Messages<\/button>/); // no (n), no has-badge
  assert.match(html, /Feedback \(1\)/); // the reply is surfaced by the Feedback button instead
});

test("renderSummary: Messages count still counts real messages + admin notifications", () => {
  // 2 personal messages + 1 pending user + 1 open alert (admin), plus a feedback
  // reply — Messages shows 4 (everything the view renders), Feedback shows 1.
  const me = baseMe({ unread_messages: 2, unread_feedback: 1, pending_users: 1, open_alerts: 1, total: 5 });
  me.role = "admin";
  const html = renderSummary(me);
  assert.match(html, /Messages \(4\)/);
  assert.match(html, /class="has-badge"/);
  assert.match(html, /Feedback \(1\)/);
});

test("settingSelectRow renders a labeled <select> with the value selected", () => {
  const html = settingSelectRow({
    id: "modesetting",
    label: "Chat mode",
    options: [
      { value: "normal", label: "Normal" },
      { value: "sdk", label: "SDK" },
    ],
    value: "sdk",
    disabled: false,
    popId: "modepop",
    info: "info",
  });
  assert.match(html, /<select class="settings-select" id="modesetting"/);
  assert.match(html, /<option value="sdk" selected>SDK<\/option>/);
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
  assert.doesNotMatch(html, /<option value="swe">/); // SWE mode retired, folded into SDK
  assert.doesNotMatch(html, /id="devknob"/); // the old toggle is gone
});

test("renderConfigKnobs: break-glass admin gets an ACTIVE mode dropdown (not a disabled switch)", () => {
  const html = renderConfigKnobs({ email: null });
  assert.match(html, /id="modesetting"/);
  assert.doesNotMatch(html, /<select class="settings-select" id="modesetting"[^>]* disabled>/); // active, mode is browser-local
  assert.doesNotMatch(html, /id="devknob"/);
});
