// Unit tests for src/mcp-modern.js — the stateless MCP revision (2026-07-28)
// served beside the handshake one.
//
// The rules here are the ones a CLIENT branches on. A conforming client decides
// what kind of server this is from the code and status of the first error it
// gets: a recognized modern error means "modern, retry properly", anything else
// means "legacy, fall back to initialize". So a wrong code is not a cosmetic
// bug — it makes a client speak the wrong protocol at us forever, and it does it
// silently. Every predicate below is therefore exercised with the shape that
// must pass AND with the specific wrong shape it exists to catch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVER_METHOD,
  LEGACY_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  MODERN_PROTOCOL_VERSION,
  RPC_HEADER_MISMATCH,
  RPC_UNSUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  completeResult,
  decodeHeaderValue,
  discoverResult,
  forbiddenOrigin,
  headerValue,
  isModernRequest,
  requestProtocolVersion,
  validateModernRequest,
} from "./mcp-modern.js";

const SERVER = { name: "deepresearch.se", version: "1.0.0" };

/** A well-formed modern request: body `_meta` plus the mirrored headers. */
function modern(method, { params = {}, headers = {}, version = MODERN_PROTOCOL_VERSION, meta = true } = {}) {
  const body = {
    method,
    params: {
      ...params,
      ...(meta
        ? {
            _meta: {
              [META_PROTOCOL_VERSION]: version,
              [META_CLIENT_CAPABILITIES]: {},
            },
          }
        : {}),
    },
  };
  const base = { "mcp-protocol-version": version, "mcp-method": method };
  if (method === "tools/call" && params.name) base["mcp-name"] = params.name;
  return { parsed: body, headers: { ...base, ...headers } };
}

// ---------------------------------------------------------------------------
// Which era a request belongs to
// ---------------------------------------------------------------------------

test("the version list is newest-first and claims only what we serve", () => {
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS[0], MODERN_PROTOCOL_VERSION);
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2026-07-28", "2025-06-18"]);
  // 2025-11-25 exists upstream and we do NOT implement it. Advertising a
  // revision we have not built is how a client sends requests we cannot answer.
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes("2025-11-25"), false);
  assert.equal(LEGACY_PROTOCOL_VERSION, "2025-06-18");
});

test("era selection: three signals say modern, and initialize outranks all of them", () => {
  // The method that only exists in the modern revision.
  assert.equal(isModernRequest({ method: DISCOVER_METHOD, params: {} }, {}), true);
  // The modern envelope itself.
  assert.equal(isModernRequest(modern("tools/list").parsed, {}), true);
  // A mirrored header with a malformed body — still modern, so the client gets a
  // modern error rather than a silently legacy answer.
  assert.equal(
    isModernRequest({ method: "tools/list", params: {} }, { "mcp-protocol-version": MODERN_PROTOCOL_VERSION }),
    true,
  );
  // A legacy client after its handshake: header present, but naming its own era.
  assert.equal(
    isModernRequest({ method: "tools/list", params: {} }, { "mcp-protocol-version": LEGACY_PROTOCOL_VERSION }),
    false,
  );
  assert.equal(isModernRequest({ method: "tools/list", params: {} }, {}), false);
  // `initialize` SELECTS legacy semantics by definition — answering it with a
  // modern error would leave a legacy client with no way forward, since it has
  // no fall-forward mechanism.
  assert.equal(isModernRequest(modern("initialize").parsed, modern("initialize").headers), false);
});

test("requestProtocolVersion reads only a non-empty string", () => {
  assert.equal(requestProtocolVersion({ _meta: { [META_PROTOCOL_VERSION]: "2026-07-28" } }), "2026-07-28");
  assert.equal(requestProtocolVersion({ _meta: { [META_PROTOCOL_VERSION]: "" } }), null);
  assert.equal(requestProtocolVersion({ _meta: { [META_PROTOCOL_VERSION]: 20260728 } }), null);
  assert.equal(requestProtocolVersion({}), null);
  assert.equal(requestProtocolVersion(undefined), null);
});

// ---------------------------------------------------------------------------
// Validation — the three codes that must not be confused
// ---------------------------------------------------------------------------

test("a valid modern request passes", () => {
  const { parsed, headers } = modern("tools/list");
  assert.equal(validateModernRequest(parsed, headers), null);
});

test("a missing _meta field is -32602, NOT the version error", () => {
  const { parsed, headers } = modern("tools/list", { meta: false });
  const bad = validateModernRequest(parsed, headers);
  assert.equal(bad?.code, -32602);
  assert.equal(bad?.status, 400);

  // clientCapabilities is required even though clientInfo is not — a stateless
  // server has no earlier request to learn them from.
  const noCaps = modern("tools/list");
  delete noCaps.parsed.params._meta[META_CLIENT_CAPABILITIES];
  assert.equal(validateModernRequest(noCaps.parsed, noCaps.headers)?.code, -32602);

  // …and an EMPTY object is a valid answer, not a missing one.
  const empty = modern("tools/list");
  empty.parsed.params._meta[META_CLIENT_CAPABILITIES] = {};
  assert.equal(validateModernRequest(empty.parsed, empty.headers), null);
});

test("an unimplemented version is -32022 and carries the list to retry with", () => {
  const { parsed, headers } = modern("tools/list", { version: "1900-01-01" });
  const bad = validateModernRequest(parsed, headers);
  assert.equal(bad?.code, RPC_UNSUPPORTED_PROTOCOL_VERSION);
  assert.equal(bad?.status, 400);
  assert.deepEqual(bad?.data, { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "1900-01-01" });
  // The schema makes both members required: a client uses `supported` to retry
  // and `requested` to explain itself to its user.
  assert.ok(Array.isArray(bad?.data.supported) && bad.data.supported.length);
});

test("every mirrored header is required, and a disagreement is -32020", () => {
  // Missing entirely.
  const noVersion = modern("tools/list");
  delete noVersion.headers["mcp-protocol-version"];
  assert.equal(validateModernRequest(noVersion.parsed, noVersion.headers)?.code, RPC_HEADER_MISMATCH);
  const noMethod = modern("tools/list");
  delete noMethod.headers["mcp-method"];
  assert.equal(validateModernRequest(noMethod.parsed, noMethod.headers)?.code, RPC_HEADER_MISMATCH);

  // Present but disagreeing with the body — the case the rule exists for: an
  // intermediary routing on the header while the server executes the body.
  const wrongMethod = modern("tools/list", { headers: { "mcp-method": "tools/call" } });
  const bad = validateModernRequest(wrongMethod.parsed, wrongMethod.headers);
  assert.equal(bad?.code, RPC_HEADER_MISMATCH);
  assert.equal(bad?.status, 400);
  assert.match(String(bad?.message), /tools\/call/);

  const wrongVersion = modern("tools/list", { headers: { "mcp-protocol-version": "2025-06-18" } });
  assert.equal(validateModernRequest(wrongVersion.parsed, wrongVersion.headers)?.code, RPC_HEADER_MISMATCH);
});

test("Mcp-Name is required for tools/call only, and is compared after Base64 decoding", () => {
  const ok = modern("tools/call", { params: { name: "deep_research" } });
  assert.equal(validateModernRequest(ok.parsed, ok.headers), null);

  const missing = modern("tools/call", { params: { name: "deep_research" } });
  delete missing.headers["mcp-name"];
  assert.equal(validateModernRequest(missing.parsed, missing.headers)?.code, RPC_HEADER_MISMATCH);

  const wrong = modern("tools/call", { params: { name: "deep_research" }, headers: { "mcp-name": "host_intel" } });
  assert.equal(validateModernRequest(wrong.parsed, wrong.headers)?.code, RPC_HEADER_MISMATCH);

  // The sentinel: a client MUST encode a value it cannot send as plain ASCII —
  // and MUST also encode a plain value that merely looks like the sentinel.
  const encoded = Buffer.from("deep_research", "utf8").toString("base64");
  const sentinel = modern("tools/call", {
    params: { name: "deep_research" },
    headers: { "mcp-name": `=?base64?${encoded}?=` },
  });
  assert.equal(validateModernRequest(sentinel.parsed, sentinel.headers), null);

  // tools/list has no name source, so no Mcp-Name is expected or read.
  const list = modern("tools/list", { headers: { "mcp-name": "irrelevant" } });
  assert.equal(validateModernRequest(list.parsed, list.headers), null);
});

test("a notification is held to the metadata rules but not to the header rules", () => {
  // The spec declines to define header requirements for notification POSTs, and
  // inventing one would refuse conforming clients.
  const note = modern("notifications/progress");
  delete note.headers["mcp-method"];
  note.parsed.isNotification = true;
  assert.equal(validateModernRequest(note.parsed, note.headers), null);
  // …but a version we cannot serve is still a version we cannot serve.
  const bad = modern("notifications/progress", { version: "1900-01-01" });
  bad.parsed.isNotification = true;
  assert.equal(validateModernRequest(bad.parsed, bad.headers)?.code, RPC_UNSUPPORTED_PROTOCOL_VERSION);
});

test("decodeHeaderValue unwraps the sentinel and leaves everything else alone", () => {
  assert.equal(decodeHeaderValue("us-west1"), "us-west1");
  assert.equal(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
  // Undecodable input comes back raw: the comparison then fails and produces a
  // HeaderMismatch, which is a better answer than a 500.
  assert.equal(decodeHeaderValue("=?base64?!!!not base64!!!?="), "=?base64?!!!not base64!!!?=");
  assert.equal(decodeHeaderValue(""), "");
  assert.equal(decodeHeaderValue(/** @type {any} */ (null)), "");
});

test("header lookup is case-insensitive over both Headers and plain objects", () => {
  assert.equal(headerValue({ "Mcp-Method": "tools/list" }, "mcp-method"), "tools/list");
  assert.equal(headerValue(new Headers({ "MCP-Protocol-Version": "2026-07-28" }), "mcp-protocol-version"), "2026-07-28");
  assert.equal(headerValue({}, "mcp-method"), null);
  assert.equal(headerValue(null, "mcp-method"), null);
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test("every result declares resultType and identifies the server", () => {
  const result = completeResult({ tools: [] }, SERVER);
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result._meta[META_SERVER_INFO], SERVER);
  // No caching hints unless the method is a cacheable one — tools/call is not.
  assert.equal("ttlMs" in result, false);
  assert.equal("cacheScope" in result, false);
  assert.deepEqual(result.tools, []);
});

test("a cacheable result carries a non-negative ttl and a scope", () => {
  const listing = completeResult({ tools: [] }, SERVER, { ttlMs: 300_000, cacheScope: "private" });
  assert.equal(listing.ttlMs, 300_000);
  assert.equal(listing.cacheScope, "private");
  // "Servers MUST provide a ttlMs value that is >= 0" — clamped rather than sent
  // negative, since a client would read it as 0 anyway.
  assert.equal(completeResult({}, SERVER, { ttlMs: -5 }).ttlMs, 0);
  // Anything but "public" is private: the safe direction for a per-account
  // listing is never to invite a shared cache.
  assert.equal(completeResult({}, SERVER, { ttlMs: 1, cacheScope: /** @type {any} */ ("wide") }).cacheScope, "private");
});

test("server/discover advertises the versions, the capability and its cache life", () => {
  const result = discoverResult(SERVER, { tools: {} }, "what this server does");
  assert.deepEqual(result.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.resultType, "complete");
  assert.equal(typeof result.ttlMs, "number");
  // Identical for every caller — nothing account-derived in it — so it may be
  // shared across authorization contexts. The tools LISTING may not.
  assert.equal(result.cacheScope, "public");
  assert.equal(result.instructions, "what this server does");
  assert.deepEqual(result._meta[META_SERVER_INFO], SERVER);
  // The list is copied, so a caller cannot mutate the module's own constant.
  result.supportedVersions.push("nonsense");
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes("nonsense"), false);
});

// ---------------------------------------------------------------------------
// The Origin rule
// ---------------------------------------------------------------------------

test("a cookie-authenticated cross-site POST is refused, and nothing else is", () => {
  // The dangerous case: no bearer of its own, so it can only be the site's
  // session cookie, driven from someone else's page.
  assert.equal(forbiddenOrigin("https://evil.example", "mcp.deepresearch.se", false), true);
  // A bearer credential cannot be forged by a page that does not hold it.
  assert.equal(forbiddenOrigin("https://evil.example", "mcp.deepresearch.se", true), false);
  // Same site, and the sibling label of the same deployment.
  assert.equal(forbiddenOrigin("https://mcp.deepresearch.se", "mcp.deepresearch.se", false), false);
  assert.equal(forbiddenOrigin("https://deepresearch.se", "mcp.deepresearch.se", false), false);
  assert.equal(forbiddenOrigin("https://deepresearch.se", "deepresearch.se", false), false);
  // A server-to-server client sends no Origin at all.
  assert.equal(forbiddenOrigin(null, "mcp.deepresearch.se", false), false);
  assert.equal(forbiddenOrigin("", "mcp.deepresearch.se", false), false);
  // An opaque origin ("null" from a sandboxed frame) is not same-site.
  assert.equal(forbiddenOrigin("null", "mcp.deepresearch.se", false), true);
  // A lookalike host must not pass on a suffix match.
  assert.equal(forbiddenOrigin("https://notdeepresearch.se", "deepresearch.se", false), true);
});
