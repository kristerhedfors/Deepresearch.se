// Unit tests for the shared chat-mode registry — the table and the wire
// resolution that replaced the developer_mode knob (2026-07-26).
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODES,
  RETIRED_CHAT_MODES,
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
  assert.equal(normalizeChatMode("nope"), DEFAULT_CHAT_MODE);
  assert.equal(normalizeChatMode(undefined), DEFAULT_CHAT_MODE);
  assert.equal(normalizeChatMode(null), DEFAULT_CHAT_MODE);
  assert.equal(normalizeChatMode(7), DEFAULT_CHAT_MODE);
  // An explicit empty fallback is how callers ask "was this a real mode?"
  assert.equal(normalizeChatMode("nope", ""), "");
});

test("a RETIRED mode id resolves to its successor, not to the generic fallback", () => {
  // `normal` — the general Deep Research turn, retired 2026-08-13 — is still
  // arriving from stored settings, un-reloaded browsers, share links and the
  // eval harnesses. It lands in the same place the generic fallback would, but
  // for a different and checkable reason, which is why it is a table rather
  // than an accident.
  for (const [retired, successor] of Object.entries(RETIRED_CHAT_MODES)) {
    assert.equal(CHAT_MODES.includes(retired), false, `${retired} is retired, not shipped`);
    assert.ok(CHAT_MODES.includes(successor), `${successor} is a real mode`);
    assert.equal(normalizeChatMode(retired), successor);
    // The distinction that earns the table: with an empty fallback, an unknown
    // value answers "" ("no mode was named") while a retired one still answers
    // with a mode — because a mode WAS named, and it still means something.
    assert.equal(normalizeChatMode(retired, ""), successor);
    assert.equal(normalizeChatMode("nope", ""), "");
  }
});

test("every mode has exactly one request flag, the default included", () => {
  const flagged = MODE_REQUEST_FLAGS.map((r) => r.mode).sort();
  assert.deepEqual(flagged, CHAT_MODES.slice().sort());
  // The DEFAULT mode keeps its flag now. While the default was the general
  // agent it had none — being the default WAS its selector, and there was
  // nothing to name. Deep Science is a domain agent that happens to be the
  // fallback, and `science_mode: true` was a real thing callers already sent,
  // so taking the flag away to preserve a symmetry would have broken them for
  // nothing. The retired id is what carries the old "no flag" spelling.
  assert.equal(FLAG_FOR_MODE.normal, undefined);
  assert.equal(FLAG_FOR_MODE[DEFAULT_CHAT_MODE], "science_mode");
  // Introspection is now nameable on the wire; that is the whole point of the
  // collapse (it used to be the derived leftover of the developer_mode knob).
  assert.equal(FLAG_FOR_MODE.introspection, "introspection_mode");
});

test("modeCarriesSource: a mode carries the source because it is NAMED, not because it isn't normal", () => {
  // This was `mode !== normal` until 2026-07-31, and it agreed with the rule
  // only because all five non-default modes happened to want the source. Deep
  // Science broke the tie: it answers from the peer-reviewed record and has no
  // more business with this repo than a general research turn did, so under the
  // old shortcut it would have loaded a multi-megabyte snapshot every turn to
  // ignore it. The set is declared now, and this test pins BOTH directions so
  // the next domain mode cannot inherit the enrichment by accident.
  for (const m of SOURCE_CARRYING_MODES) {
    assert.equal(modeCarriesSource(m), true, `${m} should carry source`);
  }
  for (const m of ["science", "cyber"]) {
    assert.equal(modeCarriesSource(m), false, `${m} should NOT carry source`);
  }
  // Every declared carrier is a real mode, and the two lists together account
  // for every mode — so adding a mode without deciding this fails here.
  for (const m of SOURCE_CARRYING_MODES) assert.ok(CHAT_MODES.includes(m), `${m} is not a chat mode`);
  assert.deepEqual(
    CHAT_MODES.filter((m) => !SOURCE_CARRYING_MODES.includes(m)).sort(),
    ["cyber", "science"],
  );
  // Unknown values normalize to the default, which is not a carrier — so they
  // never turn the enrichment on.
  assert.equal(modeCarriesSource("bogus"), false);
});

test("resolveBodyChatMode: chat_mode names the mode outright", () => {
  for (const m of CHAT_MODES) {
    assert.equal(resolveBodyChatMode({ chat_mode: m }, { available: true }), m);
  }
});

test("resolveBodyChatMode: no capability always means the default mode", () => {
  assert.equal(resolveBodyChatMode({ chat_mode: "sdk" }, { available: false }), DEFAULT_CHAT_MODE);
  assert.equal(resolveBodyChatMode({ sdk_mode: true }, { available: false }), DEFAULT_CHAT_MODE);
  // Even a stored non-default pick cannot survive the capability going away.
  assert.equal(resolveBodyChatMode({}, { available: false, stored: "introspection" }), DEFAULT_CHAT_MODE);
  assert.equal(resolveBodyChatMode({ chat_mode: "cyber" }, { available: false }), DEFAULT_CHAT_MODE);
});

test("resolveBodyChatMode: developer_mode:false is the off-only override", () => {
  // The documented escape hatch the eval harnesses depend on: it can only ever
  // force the DEFAULT mode, never grant one. What that default IS changed on
  // 2026-08-13 — it is Deep Science, not a general research turn — so callers
  // using this to mean "plain web research" now get a literature agent. The
  // promise the flag makes ("clear the mode") is unchanged; what it clears TO
  // is a domain, because the roster no longer has anything else.
  assert.equal(
    resolveBodyChatMode({ developer_mode: false, chat_mode: "introspection" }, { available: true }),
    DEFAULT_CHAT_MODE,
  );
  assert.equal(
    resolveBodyChatMode({ developer_mode: false, sdk_mode: true }, { available: true }),
    DEFAULT_CHAT_MODE,
  );
  assert.equal(
    resolveBodyChatMode({ developer_mode: false }, { available: true, stored: "sdk" }),
    DEFAULT_CHAT_MODE,
  );
  // `developer_mode: true` grants nothing — it is not a selector any more.
  assert.equal(resolveBodyChatMode({ developer_mode: true }, { available: true }), DEFAULT_CHAT_MODE);
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

test("resolveBodyChatMode: the account's stored mode is the last word before the default", () => {
  assert.equal(resolveBodyChatMode({}, { available: true, stored: "orchestrator" }), "orchestrator");
  assert.equal(resolveBodyChatMode({}, { available: true, stored: "bogus" }), DEFAULT_CHAT_MODE);
  assert.equal(resolveBodyChatMode({}, { available: true }), DEFAULT_CHAT_MODE);
  assert.equal(resolveBodyChatMode(null, { available: true }), DEFAULT_CHAT_MODE);
  // An explicit request beats the stored pick — a browser sitting in the
  // default mode must get the default agent even when the account last
  // persisted something else. A client still sending the retired id gets the
  // same answer, which is what keeps un-reloaded tabs working.
  assert.equal(
    resolveBodyChatMode({ chat_mode: DEFAULT_CHAT_MODE }, { available: true, stored: "sdk" }),
    DEFAULT_CHAT_MODE,
  );
  assert.equal(
    resolveBodyChatMode({ chat_mode: "normal" }, { available: true, stored: "sdk" }),
    DEFAULT_CHAT_MODE,
  );
});

test("routingNeedsRegistry: every request pays it, because every mode is a domain", () => {
  // The shortcut this used to encode — "the default turn always resolves to the
  // general agent, so do not read the registry for it" — died with the general
  // agent (2026-08-13). A domain is enforced by the resolved capability, and a
  // request that skipped the registry would carry a NULL one, which means the
  // unrestricted platform default: Deep Science would quietly stop being
  // literature-only, and Cyber's exclusive sources would open to everyone. What
  // pays for it is a smaller artifact and the per-isolate cache, not a cheaper
  // rule (see src/agent-registry.js).
  for (const m of CHAT_MODES) assert.equal(routingNeedsRegistry({}, m), true, m);
  assert.equal(routingNeedsRegistry({}, DEFAULT_CHAT_MODE), true);
  assert.equal(routingNeedsRegistry({ agent: "some-agent" }, DEFAULT_CHAT_MODE), true);
  assert.equal(routingNeedsRegistry({ agent: "   " }, DEFAULT_CHAT_MODE), true);
  assert.equal(routingNeedsRegistry(null, undefined), true);
});
