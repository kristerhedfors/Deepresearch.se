// Unit suite for the composer deep-link parser (deeplink-core.js): the mode
// aliases, the ask/q resolution and bound, the auto-submit flag, and the
// round-trip with buildComposerDeepLink. This is what the agent-platform docs'
// "ask the source" links rely on, so it is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseComposerDeepLink,
  buildComposerDeepLink,
  DEEPLINK_MODES,
  MAX_ASK_CHARS,
} from "./deeplink-core.js";

test("parses mode aliases to canonical ids", () => {
  assert.equal(parseComposerDeepLink("?mode=introspection").mode, "introspection");
  assert.equal(parseComposerDeepLink("?mode=introspect").mode, "introspection");
  assert.equal(parseComposerDeepLink("?mode=source").mode, "introspection");
  assert.equal(parseComposerDeepLink("?mode=agent-builder").mode, "sdk");
  assert.equal(parseComposerDeepLink("?mode=builder").mode, "sdk");
  assert.equal(parseComposerDeepLink("?mode=research").mode, "normal");
  assert.equal(parseComposerDeepLink("?mode=bogus").mode, null);
  assert.equal(parseComposerDeepLink("").mode, null);
});

test("resolves ask, then q as an alias, trimmed and bounded", () => {
  assert.equal(parseComposerDeepLink("?ask=%20hello%20").ask, "hello");
  assert.equal(parseComposerDeepLink("?q=fallback").ask, "fallback");
  assert.equal(parseComposerDeepLink("?ask=&q=used").ask, "used"); // empty ask falls through to q
  assert.equal(parseComposerDeepLink("?nope=1").ask, null);
  const long = "a".repeat(MAX_ASK_CHARS + 500);
  assert.equal(parseComposerDeepLink("?ask=" + long).ask.length, MAX_ASK_CHARS);
});

test("send defaults off and reads go/send truthy", () => {
  assert.equal(parseComposerDeepLink("?ask=x").send, false);
  assert.equal(parseComposerDeepLink("?ask=x&go=1").send, true);
  assert.equal(parseComposerDeepLink("?ask=x&send=true").send, true);
  assert.equal(parseComposerDeepLink("?ask=x&go=0").send, false);
});

test("never throws on garbage", () => {
  assert.deepEqual(parseComposerDeepLink(null), { mode: null, ask: null, send: false });
  assert.deepEqual(parseComposerDeepLink(undefined), { mode: null, ask: null, send: false });
});

test("build → parse round-trips", () => {
  const url = buildComposerDeepLink({ mode: "introspection", ask: "how does split routing work?", send: true });
  assert.ok(url.includes("mode=introspection"));
  const parsed = parseComposerDeepLink(url.slice(url.indexOf("?")));
  assert.equal(parsed.mode, "introspection");
  assert.equal(parsed.ask, "how does split routing work?");
  assert.equal(parsed.send, true);
  // an invalid mode is dropped, ask still set
  const u2 = buildComposerDeepLink({ mode: "nope", ask: "x" });
  assert.ok(!u2.includes("mode="));
  assert.ok(DEEPLINK_MODES.length === 3);
});
