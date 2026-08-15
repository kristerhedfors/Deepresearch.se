// End-to-end tests for the two protocol ERAS on POST /mcp, and for the second
// gate the extension tools sit behind — both driven through the real handleMcp
// rather than through the pure helpers, because what a client sees is the HTTP
// response, not the object a helper returned.
//
// WHY THE STATUS CODES ARE THE POINT. A conforming 2026-07-28 client decides
// what kind of server this is from the FIRST error it gets: a recognized modern
// JSON-RPC error means "modern, correct the request and retry", anything else
// means "legacy, fall back to initialize and stay there". A right code at a
// wrong status, or a right status with a legacy-shaped body, silently downgrades
// every client that ever connects. None of that is visible from a unit test of
// the validator alone, which is why these drive the handler.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { handleMcp } from "./mcp.js";
import { MODERN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp-modern.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = /** @type {any} */ ({ waitUntil() {} });
const user = /** @type {any} */ ({ id: "u1", role: "user", email: "u@example.com", user: null });

/** The modern `_meta` every request of that era must carry. */
function modernMeta(version = MODERN_PROTOCOL_VERSION) {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

/**
 * POST one JSON-RPC message at the real handler.
 * @param {{ method: string, params?: any, id?: any, headers?: Record<string,string>, env?: any, identity?: any }} opts
 */
async function post({ method, params, id = 1, headers = {}, env = {}, identity = user }) {
  const body = { jsonrpc: "2.0", method, ...(id === null ? {} : { id }), ...(params ? { params } : {}) };
  const request = new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await handleMcp(request, env, /** @type {any} */ (silentLog), identity, ctx, "req-1");
  const text = await res.clone().text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* left null */
  }
  return { res, status: res.status, json, text };
}

/** A well-formed modern request: body `_meta` plus the three mirrored headers. */
function modern(method, { params = {}, name = "", version = MODERN_PROTOCOL_VERSION, headers = {} } = {}) {
  const mirrored = { "mcp-protocol-version": version, "mcp-method": method };
  if (name) mirrored["mcp-name"] = name;
  return {
    method,
    params: { ...params, _meta: modernMeta(version) },
    headers: { ...mirrored, ...headers },
  };
}

// ---------------------------------------------------------------------------
// The legacy era keeps working, byte for byte
// ---------------------------------------------------------------------------

describe("the handshake era", () => {
  test("initialize still answers its own revision", async () => {
    const { status, json } = await post({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, "2025-06-18");
    assert.ok(json.result.capabilities.tools);
    // The additive modern fields ride along harmlessly: a legacy client's own
    // rule is that an absent resultType means "complete", so a present one can
    // only agree with it.
    assert.equal(json.result.resultType, "complete");
    assert.ok(json.result._meta["io.modelcontextprotocol/serverInfo"].name);
  });

  test("an initialize carrying modern _meta is STILL legacy", async () => {
    // The dual-era rule: "an initialize request selects legacy semantics". A
    // legacy client has no fall-forward mechanism, so answering it with a modern
    // error would leave it with nowhere to go.
    const { status, json } = await post({
      method: "initialize",
      params: { _meta: modernMeta() },
    });
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, "2025-06-18");
  });

  test("a legacy unknown method keeps its 200", async () => {
    const { status, json } = await post({ method: "no/such/method" });
    assert.equal(status, 200);
    assert.equal(json.error.code, -32601);
  });

  test("notifications/initialized is still a bare 202", async () => {
    const { status, text } = await post({ method: "notifications/initialized", id: null });
    assert.equal(status, 202);
    assert.equal(text, "");
  });
});

// ---------------------------------------------------------------------------
// The modern era
// ---------------------------------------------------------------------------

describe("the stateless era (2026-07-28)", () => {
  test("server/discover answers with everything a client needs to choose a version", async () => {
    const { status, json } = await post(modern("server/discover"));
    assert.equal(status, 200);
    const result = json.result;
    assert.deepEqual(result.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS);
    assert.ok(result.capabilities.tools);
    assert.equal(result.resultType, "complete");
    assert.equal(typeof result.ttlMs, "number");
    assert.equal(result.cacheScope, "public");
    assert.ok(result.instructions, "a client MAY show this to its user");
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "deepresearch.se");
  });

  test("tools/list is cacheable but PRIVATE — it is filtered per account", async () => {
    const { status, json } = await post(modern("tools/list"));
    assert.equal(status, 200);
    assert.equal(json.result.resultType, "complete");
    assert.ok(json.result.ttlMs > 0);
    assert.equal(json.result.cacheScope, "private");
    assert.ok(Array.isArray(json.result.tools) && json.result.tools.length);
  });

  test("a missing required _meta field is -32602 at 400, not the version error", async () => {
    const { status, json } = await post({
      method: "tools/list",
      // The header says modern; the body forgot to.
      headers: { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": "tools/list" },
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, -32602);
  });

  test("a version we do not implement is -32022 carrying the ones we do", async () => {
    const { status, json } = await post(modern("tools/list", { version: "1900-01-01" }));
    assert.equal(status, 400);
    assert.equal(json.error.code, -32022);
    assert.deepEqual(json.error.data, { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "1900-01-01" });
  });

  test("a mirrored header that disagrees with the body is -32020 at 400", async () => {
    const req = modern("tools/list", { headers: { "mcp-method": "tools/call" } });
    const { status, json } = await post(req);
    assert.equal(status, 400);
    assert.equal(json.error.code, -32020);
  });

  test("a modern tools/call runs the tool, mirrored Mcp-Name and all", async () => {
    // The era-detection path most likely to regress, and the only method whose
    // header table demands Mcp-Name. A tool the account exposes but has not
    // switched the extension knob on for answers as a tool RESULT, which is what
    // proves the modern envelope reached the dispatch rather than being refused
    // by the protocol layer.
    const { status, json } = await post(
      modern("tools/call", {
        params: { name: "street_view_look", arguments: { place: "Enköping" } },
        name: "street_view_look",
      }),
    );
    assert.equal(status, 200);
    assert.equal(json.result.resultType, "complete");
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /switched off for this account/);
    // tools/call is NOT a cacheable result — no listing hints on it.
    assert.equal("ttlMs" in json.result, false);
  });

  test("a tools/call whose Mcp-Name disagrees with the body is refused", async () => {
    const { status, json } = await post(
      modern("tools/call", {
        params: { name: "street_view_look", arguments: {} },
        name: "host_intel",
      }),
    );
    assert.equal(status, 400);
    assert.equal(json.error.code, -32020);
  });

  test("a modern unknown method is 404 — the discriminator against a bare 404", async () => {
    // "The JSON-RPC error body distinguishes this case from a 404 returned by a
    // legacy HTTP+SSE server that does not host the modern MCP endpoint."
    const { status, json } = await post(modern("resources/list"));
    assert.equal(status, 404);
    assert.equal(json.error.code, -32601);
    assert.equal(json.jsonrpc, "2.0");
  });

  test("a bare server/discover is malformed, and says so in the modern vocabulary", async () => {
    // The tempting leniency — answer any discover, since a probe is how a client
    // LEARNS what we speak — is not what the spec says: DiscoverRequest requires
    // `_meta`, and a request missing a required field is malformed. It is also
    // not needed: a probe is sent by a modern client, and a modern client sends
    // `_meta`. What matters is that the refusal is a RECOGNIZED modern error, so
    // a dual-era client reads "modern server, fix the request" rather than
    // "legacy server, fall back".
    const { status, json } = await post({ method: "server/discover" });
    assert.equal(status, 400);
    assert.equal(json.error.code, -32602);
    assert.match(json.error.message, /io\.modelcontextprotocol\/protocolVersion/);
  });
});

// ---------------------------------------------------------------------------
// The Origin rule
// ---------------------------------------------------------------------------

describe("cross-site protection", () => {
  test("a cookie-authenticated cross-site POST is refused before the body is read", async () => {
    const { status, json } = await post({ method: "tools/list", headers: { origin: "https://evil.example" } });
    assert.equal(status, 403);
    assert.equal(json.jsonrpc, "2.0");
    assert.ok(json.error);
  });

  test("a bearer-carrying client is never refused on Origin grounds", async () => {
    // It cannot be forged by a page that does not hold the key, which is the
    // whole threat the check exists for.
    const { status } = await post({
      method: "tools/list",
      headers: { origin: "https://claude.ai", authorization: "Bearer mck1.whatever" },
    });
    assert.equal(status, 200);
  });

  test("the site's own pages are same-site", async () => {
    const { status } = await post({ method: "tools/list", headers: { origin: "https://deepresearch.se" } });
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// The extension tools' SECOND gate
// ---------------------------------------------------------------------------

describe("extension tools", () => {
  test("they are listed even when the account's knob is off", async () => {
    // The exposure switch and the extension knob are different gates and only
    // the first one filters the listing: a caller should be able to see that the
    // capability exists and be told why it is unavailable, rather than have it
    // vanish.
    const { json } = await post(modern("tools/list"));
    const names = json.result.tools.map((/** @type {any} */ t) => t.name);
    assert.ok(names.includes("street_view_look"));
    assert.ok(names.includes("place_nearby"));
    assert.ok(names.includes("host_intel"));
  });

  test("calling one with the knob off refuses without reaching the third party", async () => {
    // No GOOGLE_MAPS_API_KEY and no stored setting: the knob is off, and the
    // refusal must be a tool RESULT (a model reads the envelope) that tells the
    // model not to retry.
    const { status, json } = await post({
      method: "tools/call",
      params: { name: "street_view_look", arguments: { place: "Enköping" } },
    });
    assert.equal(status, 200);
    assert.equal(json.result.isError, true);
    const text = json.result.content[0].text;
    assert.match(text, /switched off for this account/);
    assert.match(text, /Retrying will not help/);
    assert.equal(json.result.resultType, "complete");
  });

  test("an unexposed tool does not exist, whatever the knob says", async () => {
    const identity = /** @type {any} */ ({
      id: "u2",
      role: "user",
      user: { settings_json: JSON.stringify({ mcp: { tools: { host_intel: false } } }) },
    });
    const { json } = await post({
      method: "tools/call",
      params: { name: "host_intel", arguments: { hosts: ["8.8.8.8"] } },
      identity,
    });
    assert.equal(json.error.code, -32602);
    assert.match(json.error.message, /Unknown tool/);
  });
});
