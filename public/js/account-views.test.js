// Unit suite for the Settings view's pure HTML builders (account-views.js) —
// specifically the Chat mode dropdown that replaced the Introspection on/off
// switch (owner directive, 2026-07-18). The render helpers are pure string
// builders; the module is import-safe in Node (its DOM/localStorage touches are
// guarded), so these run without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { settingSelectRow, renderConfigKnobs, renderSummary } from "./account-views.js";
import { readFileSync } from "node:fs";

import { CHAT_MODES } from "./chat-mode-core.js";
import { MODE_THEMES } from "./mode-theme.js";

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

test("renderConfigKnobs: the Settings dropdown offers EVERY chat mode", () => {
  // The drift this exists to catch: CHAT_MODE_OPTIONS was hand-maintained and
  // silently lost `models`, so the Models agent was reachable from the composer
  // dropdown (public/index.html #modesel) but not from Settings — and opening
  // Settings while in it showed the wrong mode. Both dropdowns drive the same
  // state, so both have to offer the same modes.
  for (const me of [{ email: "a@b.c" }, { email: null }]) {
    const html = renderConfigKnobs(me);
    for (const mode of CHAT_MODES) {
      assert.match(
        html,
        new RegExp(`<option value="${mode}"`),
        `mode "${mode}" is missing from the Settings dropdown (me.email=${me.email})`,
      );
    }
  }
});

test("the COMPOSER dropdown in index.html offers every chat mode too", () => {
  // The mirror of the test above, and the drift it exists to catch is the one
  // that actually happened (2026-07-31, owner-reported: "I dont see the deep
  // science agent"). #modesel is hand-written markup in public/index.html, so
  // a mode can be complete everywhere — registry row, theme, CSS, settings —
  // and still have no door in the composer, which is the only place most
  // people ever pick a mode. Nothing tied the two together, and the previous
  // drift ran the OTHER way (models in #modesel but not in Settings), so this
  // pairing is the actual invariant: the two dropdowns and CHAT_MODES agree.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const sel = html.match(/<select id="modesel"[\s\S]*?<\/select>/)?.[0];
  assert.ok(sel, "#modesel is missing from public/index.html");
  const offered = [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, CHAT_MODES, "the composer dropdown and CHAT_MODES disagree");
  // The labels are the mode registry's, not a second set of names.
  for (const mode of CHAT_MODES) {
    const label = MODE_THEMES[mode].label;
    assert.match(
      sel,
      new RegExp(`<option value="${mode}">${label}</option>`),
      `#modesel labels ${mode} as something other than "${label}"`,
    );
  }
});

test("renderConfigKnobs: break-glass admin gets an ACTIVE mode dropdown (not a disabled switch)", () => {
  const html = renderConfigKnobs({ email: null });
  assert.match(html, /id="modesetting"/);
  assert.doesNotMatch(html, /<select class="settings-select" id="modesetting"[^>]* disabled>/); // active, mode is browser-local
  assert.doesNotMatch(html, /id="devknob"/);
});
