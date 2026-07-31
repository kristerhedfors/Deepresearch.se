// Unit tests for the shared chat-mode registry — the table and the wire
// resolution that replaced the developer_mode knob (2026-07-26).
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODES,
  SOURCE_CARRYING_MODES,
  DEFAULT_CHAT_MODE,
  FLAG_FOR_MODE,
  MODE_REQUEST_FLAGS,
  modeCarriesSource,
  normalizeChatMode,
  resolveBodyChatMode,
  routingNeedsRegistry,
} from "./chat-mode-core.js";

test("normalizeChatMode: known modes pass, anything else falls back", () => {
  for (const m of CHAT_MODES) assert.equal(normalizeChatMode(m), m);
  assert.equal(normalizeChatMode("nope"), "normal");
  assert.equal(normalizeChatMode(undefined), "normal");
  assert.equal(normalizeChatMode(null), "normal");
  assert.equal(normalizeChatMode(7), "normal");
  // An explicit empty fallback is how callers ask "was this a real mode?"
  assert.equal(normalizeChatMode("nope", ""), "");
});

test("every non-normal mode has exactly one request flag", () => {
  const flagged = MODE_REQUEST_FLAGS.map((r) => r.mode).sort();
  const nonNormal = CHAT_MODES.filter((m) => m !== DEFAULT_CHAT_MODE).sort();
  assert.deepEqual(flagged, nonNormal);
  // `normal` is selected by no flag — it is what a request with none resolves to.
  assert.equal(FLAG_FOR_MODE.normal, undefined);
  // Introspection is now nameable on the wire; that is the whole point of the
  // collapse (it used to be the derived leftover of the developer_mode knob).
  assert.equal(FLAG_FOR_MODE.introspection, "introspection_mode");
});

test("modeCarriesSource: a mode carries the source because it is NAMED, not because it isn't normal", () => {
  // This was `mode !== normal` until 2026-07-31, and it agreed with the rule
  // only because all five non-normal modes happened to want the source. Deep
  // Science broke the tie: it answers from the peer-reviewed record and has no
  // more business with this repo than plain Deep Research does, so under the
  // old shortcut it would have loaded a multi-megabyte snapshot every turn to
  // ignore it. The set is declared now, and this test pins BOTH directions so
  // the next domain mode cannot inherit the enrichment by accident.
  for (const m of SOURCE_CARRYING_MODES) {
    assert.equal(modeCarriesSource(m), true, `${m} should carry source`);
  }
  for (const m of ["normal", "science"]) {
    assert.equal(modeCarriesSource(m), false, `${m} should NOT carry source`);
  }
  // Every declared carrier is a real mode, and the two lists together account
  // for every mode — so adding a mode without deciding this fails here.
  for (const m of SOURCE_CARRYING_MODES) assert.ok(CHAT_MODES.includes(m), `${m} is not a chat mode`);
  assert.deepEqual(
    CHAT_MODES.filter((m) => !SOURCE_CARRYING_MODES.includes(m)).sort(),
    ["normal", "science"],
  );
  // Unknown values normalize to normal, so they never turn the enrichment on.
  assert.equal(modeCarriesSource("bogus"), false);
});

test("resolveBodyChatMode: chat_mode names the mode outright", () => {
  for (const m of CHAT_MODES) {
    assert.equal(resolveBodyChatMode({ chat_mode: m }, { available: true }), m);
  }
});

test("resolveBodyChatMode: no capability always means normal", () => {
  assert.equal(resolveBodyChatMode({ chat_mode: "sdk" }, { available: false }), "normal");
  assert.equal(resolveBodyChatMode({ sdk_mode: true }, { available: false }), "normal");
  // Even a stored non-normal pick cannot survive the capability going away.
  assert.equal(resolveBodyChatMode({}, { available: false, stored: "introspection" }), "normal");
});

test("resolveBodyChatMode: developer_mode:false is the off-only override", () => {
  // The documented escape hatch the eval harnesses depend on: it can only ever
  // force normal, never grant a mode.
  assert.equal(
    resolveBodyChatMode({ developer_mode: false, chat_mode: "introspection" }, { available: true }),
    "normal",
  );
  assert.equal(
    resolveBodyChatMode({ developer_mode: false, sdk_mode: true }, { available: true }),
    "normal",
  );
  assert.equal(
    resolveBodyChatMode({ developer_mode: false }, { available: true, stored: "sdk" }),
    "normal",
  );
  // `developer_mode: true` grants nothing — it is not a selector any more.
  assert.equal(resolveBodyChatMode({ developer_mode: true }, { available: true }), "normal");
});

test("resolveBodyChatMode: legacy mode flags still select their mode", () => {
  for (const { mode, flag } of MODE_REQUEST_FLAGS) {
    assert.equal(resolveBodyChatMode({ [flag]: true }, { available: true }), mode);
  }
});

test("resolveBodyChatMode: flag precedence is MODE_REQUEST_FLAGS order", () => {
  // A request carrying several resolves to the first — the same precedence
  // sdk/AGENTS.json's defaults table encodes (sdk > orchestrator >
  // outrospection > models > introspection).
  const all = Object.fromEntries(MODE_REQUEST_FLAGS.map((r) => [r.flag, true]));
  assert.equal(resolveBodyChatMode(all, { available: true }), "sdk");
  delete all.sdk_mode;
  assert.equal(resolveBodyChatMode(all, { available: true }), "orchestrator");
  delete all.orchestrator_mode;
  assert.equal(resolveBodyChatMode(all, { available: true }), "outrospection");
  delete all.outrospection_mode;
  assert.equal(resolveBodyChatMode(all, { available: true }), "models");
});

test("resolveBodyChatMode: an explicit chat_mode outranks a legacy flag", () => {
  assert.equal(
    resolveBodyChatMode({ chat_mode: "introspection", sdk_mode: true }, { available: true }),
    "introspection",
  );
  // An UNKNOWN chat_mode is ignored rather than failing the request, so the
  // flag still gets its say (invariant 2 — fail soft to a lesser result).
  assert.equal(resolveBodyChatMode({ chat_mode: "bogus", sdk_mode: true }, { available: true }), "sdk");
});

test("resolveBodyChatMode: the account's stored mode is the last word before normal", () => {
  assert.equal(resolveBodyChatMode({}, { available: true, stored: "orchestrator" }), "orchestrator");
  assert.equal(resolveBodyChatMode({}, { available: true, stored: "bogus" }), "normal");
  assert.equal(resolveBodyChatMode({}, { available: true }), "normal");
  assert.equal(resolveBodyChatMode(null, { available: true }), "normal");
  // An explicit request beats the stored pick — a browser in Normal must get
  // plain research even when the account last persisted something else.
  assert.equal(
    resolveBodyChatMode({ chat_mode: "normal" }, { available: true, stored: "sdk" }),
    "normal",
  );
});

test("routingNeedsRegistry: only a non-normal mode or an addressed agent pays the load", () => {
  assert.equal(routingNeedsRegistry({}, "normal"), false);
  assert.equal(routingNeedsRegistry({ sdk_mode: true }, "normal"), false); // already resolved away
  assert.equal(routingNeedsRegistry({}, "introspection"), true);
  assert.equal(routingNeedsRegistry({}, "sdk"), true);
  assert.equal(routingNeedsRegistry({ agent: "some-agent" }, "normal"), true);
  assert.equal(routingNeedsRegistry({ agent: "   " }, "normal"), false);
  assert.equal(routingNeedsRegistry({ agent: 5 }, "normal"), false);
});
