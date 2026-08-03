// The authorization endpoint's security-critical half (src/oauth-authorize.js).
//
// Four claims the module's header makes, pinned here:
//
//   1. AN UNALLOWED redirect_uri IS RENDERED, NEVER REDIRECTED. That branch is
//      the difference between a consent screen and an open redirector, and it
//      is the one error whose value gets logged (docs/MCP-CONNECTOR.md §4).
//   2. PKCE S256 OR NOTHING. `plain`, a missing method and a missing challenge
//      are all refused at the start of the flow rather than at the exchange.
//   3. THE CIMD DOCUMENT MAY NARROW, NEVER WIDEN. A fetch that fails costs the
//      friendly name only; a document that answers "I do not own that
//      redirect" is a hard refusal.
//   4. THE POST TRUSTS ONLY THE SIGNATURE. The request that gets approved is
//      the one that was rendered — the form carries no client_id, no
//      redirect_uri and no challenge of its own — and the token is bound to
//      the account it was shown to.
//
// `fetch` is stubbed throughout: a unit test that reaches the network tests
// Anthropic's uptime, not this file.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSENT_PREFIX,
  CONSENT_TTL_S,
  clientDisplayName,
  consentPage,
  errorPage,
  fetchClientMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  mintConsentToken,
  parseAuthorizeParams,
  redirectHost,
  signInPage,
  verifyConsentToken,
} from "./oauth-authorize.js";

const SECRET = "3f1a9c0d7b25e846af03cd91b7e254a6083fd12c9b7a4e6d5c3f2a1b0e9d8c7b";
const env = /** @type {any} */ ({ SESSION_SECRET: SECRET });

const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** A logger that keeps what it was told, so the log assertions are real. */
function recordingLog() {
  /** @type {Array<{ level: string, event: string, fields: any }>} */
  const lines = [];
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ event, /** @type {any} */ fields) =>
    lines.push({ level, event, fields: fields || {} });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** @param {Record<string, string>} [over] */
function query(over = {}) {
  const params = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "opaque-state-123",
    scope: "research offline_access",
    ...over,
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "") sp.set(k, v);
  return sp;
}

/** @param {Record<string, string>} [over] */
function getUrl(over) {
  return new URL(`https://deepresearch.se/oauth/authorize?${query(over)}`);
}

const identity = /** @type {any} */ ({
  id: "42",
  role: "user",
  email: "someone@example.com",
  name: "Someone",
  user: { id: 42, email: "someone@example.com", status: "active", settings_json: "{}" },
});

/**
 * Replace global fetch for one test. Returns a restore function.
 * @param {(input: any) => Promise<any> | any} impl
 */
function stubFetch(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ input) => impl(input));
  return () => {
    globalThis.fetch = real;
  };
}

/** A CIMD response body. @param {any} doc */
function jsonRes(doc, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(doc) };
}

const CLAUDE_CIMD = { client_id: CLIENT_ID, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT] };

// ---------------------------------------------------------------------------
// parseAuthorizeParams — the error matrix, pure
// ---------------------------------------------------------------------------

test("a valid request parses, with the scope and state carried through", () => {
  const res = parseAuthorizeParams(query());
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.req.clientId, CLIENT_ID);
  assert.equal(res.req.redirectUri, CLAUDE_REDIRECT);
  assert.equal(res.req.codeChallenge, CHALLENGE);
  assert.equal(res.req.scope, "research offline_access");
  assert.equal(res.req.state, "opaque-state-123");
  assert.equal(res.req.resource, "");
});

test("the RFC 8707 resource parameter is accepted and carried", () => {
  const res = parseAuthorizeParams(query({ resource: "https://mcp.deepresearch.se" }));
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.req.resource, "https://mcp.deepresearch.se");
});

test("an unallowed redirect_uri RENDERS — it is never bounced back to", () => {
  const res = parseAuthorizeParams(query({ redirect_uri: "https://evil.example/callback" }));
  assert.equal(res.kind, "render");
  if (res.kind !== "render") return;
  assert.equal(res.refusedRedirect, "https://evil.example/callback");
});

test("a missing redirect_uri renders too — there is nowhere to bounce to", () => {
  const res = parseAuthorizeParams(query({ redirect_uri: "" }));
  assert.equal(res.kind, "render");
});

test("a lookalike host is refused: exact match is the whole point", () => {
  for (const uri of [
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/",
    "http://claude.ai/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
  ]) {
    assert.equal(parseAuthorizeParams(query({ redirect_uri: uri })).kind, "render", uri);
  }
});

test("the port-agnostic loopback redirect is allowed (Claude Code, RFC 8252)", () => {
  const res = parseAuthorizeParams(query({ redirect_uri: "http://127.0.0.1:53219/callback" }));
  assert.equal(res.kind, "ok");
});

test("only response_type=code, and the error bounces with the state intact", () => {
  const res = parseAuthorizeParams(query({ response_type: "token" }));
  assert.equal(res.kind, "redirect");
  if (res.kind !== "redirect") return;
  assert.equal(res.error, "unsupported_response_type");
  assert.equal(res.state, "opaque-state-123");
  assert.equal(res.redirectUri, CLAUDE_REDIRECT);
});

test("code_challenge_method must be S256 — plain and absent are both refused", () => {
  for (const method of ["plain", "S384", ""]) {
    const res = parseAuthorizeParams(query({ code_challenge_method: method }));
    assert.equal(res.kind, "redirect", method);
    if (res.kind !== "redirect") continue;
    assert.equal(res.error, "invalid_request");
    assert.match(res.description, /S256/);
  }
});

test("a missing code_challenge is refused (PKCE is not optional)", () => {
  const res = parseAuthorizeParams(query({ code_challenge: "" }));
  assert.equal(res.kind, "redirect");
  if (res.kind !== "redirect") return;
  assert.match(res.description, /PKCE/);
});

test("client_id must be present and must be an https URL", () => {
  for (const clientId of ["", "not-a-url", "http://claude.ai/client", "urn:example:client"]) {
    const res = parseAuthorizeParams(query({ client_id: clientId }));
    assert.equal(res.kind, "redirect", clientId);
    if (res.kind !== "redirect") continue;
    assert.equal(res.error, "invalid_request");
  }
});

test("an absent scope becomes the default; unknown scopes are dropped, not fatal", () => {
  const empty = parseAuthorizeParams(query({ scope: "" }));
  assert.equal(empty.kind, "ok");
  if (empty.kind === "ok") assert.equal(empty.req.scope, "research offline_access");

  const noisy = parseAuthorizeParams(query({ scope: "research profile email" }));
  assert.equal(noisy.kind, "ok");
  if (noisy.kind === "ok") assert.equal(noisy.req.scope, "research");
});

test("a scope with nothing recognisable in it is invalid_scope", () => {
  const res = parseAuthorizeParams(query({ scope: "profile email" }));
  assert.equal(res.kind, "redirect");
  if (res.kind !== "redirect") return;
  assert.equal(res.error, "invalid_scope");
});

// ---------------------------------------------------------------------------
// The consent token
// ---------------------------------------------------------------------------

const sampleReq = {
  clientId: CLIENT_ID,
  redirectUri: CLAUDE_REDIRECT,
  codeChallenge: CHALLENGE,
  scope: "research offline_access",
  state: "opaque-state-123",
  resource: "",
};

test("consent token: mint → verify round-trip keeps the whole request", async () => {
  const token = await mintConsentToken(env, sampleReq, "42");
  assert.ok(token.startsWith(`${CONSENT_PREFIX}.`));
  const claims = await verifyConsentToken(env, token, "42");
  assert.ok(claims);
  assert.equal(claims.cid, CLIENT_ID);
  assert.equal(claims.ru, CLAUDE_REDIRECT);
  assert.equal(claims.cc, CHALLENGE);
  assert.equal(claims.sc, "research offline_access");
  assert.equal(claims.st, "opaque-state-123");
});

test("consent token: bound to the account it was shown to (the CSRF property)", async () => {
  const token = await mintConsentToken(env, sampleReq, "42");
  assert.equal(await verifyConsentToken(env, token, "43"), null);
});

test("consent token: expires, and a tampered payload does not verify", async () => {
  const now = Date.now();
  const token = await mintConsentToken(env, sampleReq, "42", now);
  assert.ok(await verifyConsentToken(env, token, "42", now + (CONSENT_TTL_S - 1) * 1000));
  assert.equal(await verifyConsentToken(env, token, "42", now + (CONSENT_TTL_S + 1) * 1000), null);

  const [prefix, payload, sig] = token.split(".");
  const evil = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), ru: "https://evil.example/callback" };
  const forged = `${prefix}.${Buffer.from(JSON.stringify(evil)).toString("base64url")}.${sig}`;
  assert.equal(await verifyConsentToken(env, forged, "42"), null);
});

test("consent token: another family's wire shape is not this family's", async () => {
  const token = await mintConsentToken(env, sampleReq, "42");
  const [, payload, sig] = token.split(".");
  assert.equal(await verifyConsentToken(env, `mck1.${payload}.${sig}`, "42"), null);
});

// ---------------------------------------------------------------------------
// The CIMD document
// ---------------------------------------------------------------------------

test("CIMD: a well-formed document yields the name and the redirect list", async () => {
  const restore = stubFetch(() => jsonRes(CLAUDE_CIMD));
  try {
    const meta = await fetchClientMetadata(CLIENT_ID);
    assert.equal(meta.fetched, true);
    assert.equal(meta.name, "Claude");
    assert.deepEqual(meta.redirectUris, [CLAUDE_REDIRECT]);
  } finally {
    restore();
  }
});

test("CIMD: a failed fetch degrades the DISPLAY only", async () => {
  for (const impl of [
    () => {
      throw new Error("network down");
    },
    () => jsonRes({}, 503),
    () => ({ ok: true, status: 200, text: async () => "<html>not json</html>" }),
  ]) {
    const restore = stubFetch(impl);
    try {
      const meta = await fetchClientMetadata(CLIENT_ID);
      assert.equal(meta.fetched, false);
      assert.equal(meta.name, null);
      assert.equal(meta.redirectUris, null);
      // The fallback name is the client_id's host — still the party being
      // authorized, just spelled as a machine.
      assert.equal(clientDisplayName(CLIENT_ID, meta), "claude.ai");
    } finally {
      restore();
    }
  }
});

test("CIMD: a document naming a different client_id is discarded, not believed", async () => {
  const restore = stubFetch(() => jsonRes({ ...CLAUDE_CIMD, client_id: "https://elsewhere.example/client" }));
  try {
    const meta = await fetchClientMetadata(CLIENT_ID);
    assert.equal(meta.fetched, false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

/** @param {URL} url @param {any} log @param {any} [who] */
function getReq(url, log, who = identity) {
  return handleAuthorizeGet(new Request(url.toString()), env, url, log, who);
}

test("GET: a valid request renders the consent screen", async () => {
  const restore = stubFetch(() => jsonRes(CLAUDE_CIMD));
  const log = recordingLog();
  try {
    const res = await getReq(getUrl(), log);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Who is asking, and — the MCP spec's requirement — the redirect HOSTNAME.
    assert.match(html, /Claude/);
    assert.match(html, /claude\.ai/);
    // The three things the design says the copy must state.
    assert.match(html, /Settings → MCP server/);
    assert.match(html, /quota/i);
    assert.match(html, /interaction log/i);
    // Both tiers named, Se/cure first (the branding rule).
    assert.ok(html.indexOf("Se<span class=\"sl\">/</span>cure") < html.lastIndexOf("Se<span class=\"sl\">/</span>rver"));
    // A consent token, and no bare copy of the request in the form.
    assert.match(html, new RegExp(`name="consent" value="${CONSENT_PREFIX}\\.`));
    assert.ok(!/name="redirect_uri"/.test(html));
    assert.ok(!/name="client_id"/.test(html));
    // Not framable, not cached.
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(log.lines.some((l) => l.event === "oauth.consent_shown"));
  } finally {
    restore();
  }
});

test("GET: a refused redirect_uri renders AND logs the value it refused", async () => {
  const log = recordingLog();
  const res = await getReq(getUrl({ redirect_uri: "https://evil.example/callback" }), log);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Location"), null);
  const html = await res.text();
  assert.match(html, /https:\/\/evil\.example\/callback/);

  const line = log.lines.find((l) => l.event === "oauth.redirect_refused");
  assert.ok(line, "the refused value is the only diagnostic anyone gets");
  assert.equal(line.fields.redirect_uri, "https://evil.example/callback");
  assert.equal(line.fields.reason, "not_allowlisted");
});

test("GET: every other error bounces back with error + state", async () => {
  const log = recordingLog();
  const res = await getReq(getUrl({ code_challenge_method: "plain" }), log);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.origin + loc.pathname, CLAUDE_REDIRECT);
  assert.equal(loc.searchParams.get("error"), "invalid_request");
  assert.equal(loc.searchParams.get("state"), "opaque-state-123");
  assert.match(loc.searchParams.get("error_description") || "", /S256/);
});

test("GET: a CIMD document that does not list the redirect is a hard refusal", async () => {
  const restore = stubFetch(() =>
    jsonRes({ ...CLAUDE_CIMD, redirect_uris: ["https://claude.ai/some/other/callback"] }),
  );
  const log = recordingLog();
  try {
    const res = await getReq(getUrl(), log);
    // Rendered, not bounced: the client_id just disclaimed the callback.
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("Location"), null);
    assert.match(await res.text(), /metadata document does not list/);
    const line = log.lines.find((l) => l.event === "oauth.redirect_refused");
    assert.ok(line);
    assert.equal(line.fields.reason, "not_in_client_metadata");
  } finally {
    restore();
  }
});

test("GET: an unreachable CIMD document still renders consent, with the host as the name", async () => {
  const restore = stubFetch(() => {
    throw new Error("timeout");
  });
  const log = recordingLog();
  try {
    const res = await getReq(getUrl(), log);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /claude\.ai/);
    assert.match(html, /could not be read just now/);
    assert.ok(log.lines.some((l) => l.event === "oauth.cimd_unavailable"));
  } finally {
    restore();
  }
});

test("GET: an unauthenticated arrival gets a sign-in page, not an OAuth error", async () => {
  const log = recordingLog();
  const res = await getReq(getUrl(), log, null);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Continue with Google/);
  assert.match(html, /\/auth\/google/);
});

test("GET: break-glass and pending identities cannot authorize a client", async () => {
  const restore = stubFetch(() => jsonRes(CLAUDE_CIMD));
  try {
    const breakGlass = /** @type {any} */ ({ id: "admin", role: "admin", email: null, name: "Admin", isSecretAdmin: true });
    const res = await getReq(getUrl(), recordingLog(), breakGlass);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /break-glass/i);

    const pending = /** @type {any} */ ({ ...identity, pending: true });
    const res2 = await getReq(getUrl(), recordingLog(), pending);
    assert.equal(res2.status, 403);
    assert.match(await res2.text(), /approval/i);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/authorize
// ---------------------------------------------------------------------------

const POST_URL = new URL("https://deepresearch.se/oauth/authorize");

/**
 * @param {Record<string, string>} fields
 * @param {Record<string, string>} [headers]
 */
function postReq(fields, headers = { Origin: "https://deepresearch.se" }) {
  return new Request(POST_URL.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A mint that records what it was asked for. */
function fakeMint() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    /** @type {any} */
    mintAuthCode: async (/** @type {any} */ _env, /** @type {any} */ args) => {
      calls.push(args);
      return { code: "oac1.thecode.sig", jti: "jti-1", exp: Math.floor(Date.now() / 1000) + 60 };
    },
  };
}

test("POST approve: mints against the SIGNED request and 302s with code + state", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const log = recordingLog();

  const res = await handleAuthorizePost(
    postReq({ consent, decision: "approve" }),
    env,
    POST_URL,
    log,
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );

  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.origin + loc.pathname, CLAUDE_REDIRECT);
  assert.equal(loc.searchParams.get("code"), "oac1.thecode.sig");
  assert.equal(loc.searchParams.get("state"), "opaque-state-123");
  assert.equal(res.headers.get("cache-control"), "no-store");

  assert.equal(mint.calls.length, 1);
  assert.deepEqual(mint.calls[0], {
    userId: "42",
    clientId: CLIENT_ID,
    redirectUri: CLAUDE_REDIRECT,
    codeChallenge: CHALLENGE,
    scope: "research offline_access",
  });
  assert.ok(log.lines.some((l) => l.event === "oauth.code_issued"));
});

test("POST deny: 302s with access_denied and the state, and mints nothing", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(
    postReq({ consent, decision: "deny" }),
    env,
    POST_URL,
    recordingLog(),
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "opaque-state-123");
  assert.equal(loc.searchParams.get("code"), null);
  assert.equal(mint.calls.length, 0);
});

test("POST: a missing or absent decision is a denial, never an approval", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(postReq({ consent }), env, POST_URL, recordingLog(), identity, {
    mintAuthCode: mint.mintAuthCode,
  });
  assert.equal(new URL(res.headers.get("Location") || "").searchParams.get("error"), "access_denied");
  assert.equal(mint.calls.length, 0);
});

test("POST: form-supplied parameters are ignored — only the signature decides", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(
    postReq({
      consent,
      decision: "approve",
      redirect_uri: "https://evil.example/callback",
      client_id: "https://evil.example/client",
      code_challenge: "attacker-challenge",
    }),
    env,
    POST_URL,
    recordingLog(),
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.origin + loc.pathname, CLAUDE_REDIRECT);
  assert.equal(mint.calls[0].redirectUri, CLAUDE_REDIRECT);
  assert.equal(mint.calls[0].codeChallenge, CHALLENGE);
});

test("POST: a consent token minted for another account is refused", async () => {
  const consent = await mintConsentToken(env, sampleReq, "999");
  const mint = fakeMint();
  const log = recordingLog();
  const res = await handleAuthorizePost(
    postReq({ consent, decision: "approve" }),
    env,
    POST_URL,
    log,
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Location"), null);
  assert.equal(mint.calls.length, 0);
  assert.ok(log.lines.some((l) => l.event === "oauth.consent_token_rejected"));
});

test("POST: a cross-origin submission is refused before anything is read", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(
    postReq({ consent, decision: "approve" }, { Origin: "https://evil.example" }),
    env,
    POST_URL,
    recordingLog(),
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );
  assert.equal(res.status, 403);
  assert.equal(mint.calls.length, 0);
});

test("POST: an unauthenticated submission gets the sign-in page, not a code", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(postReq({ consent, decision: "approve" }), env, POST_URL, recordingLog(), null, {
    mintAuthCode: mint.mintAuthCode,
  });
  assert.equal(res.status, 401);
  assert.equal(mint.calls.length, 0);
});

test("POST: a mint failure is reported as server_error over the redirect", async () => {
  const consent = await mintConsentToken(env, sampleReq, "42");
  const log = recordingLog();
  const res = await handleAuthorizePost(
    postReq({ consent, decision: "approve" }),
    env,
    POST_URL,
    log,
    identity,
    {
      mintAuthCode: async () => {
        throw new Error("D1 unavailable");
      },
    },
  );
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.searchParams.get("error"), "server_error");
  assert.equal(loc.searchParams.get("state"), "opaque-state-123");
  assert.ok(log.lines.some((l) => l.event === "oauth.code_mint_failed"));
});

test("POST: a state-less client gets a redirect with no state parameter", async () => {
  const consent = await mintConsentToken(env, { ...sampleReq, state: "" }, "42");
  const mint = fakeMint();
  const res = await handleAuthorizePost(
    postReq({ consent, decision: "approve" }),
    env,
    POST_URL,
    recordingLog(),
    identity,
    { mintAuthCode: mint.mintAuthCode },
  );
  const loc = new URL(res.headers.get("Location") || "");
  assert.equal(loc.searchParams.get("state"), null);
  assert.equal(loc.searchParams.get("code"), "oac1.thecode.sig");
});

// ---------------------------------------------------------------------------
// The pages themselves
// ---------------------------------------------------------------------------

test("every rendered page escapes what arrived on the query string", () => {
  const injected = 'https://evil.example/"><script>alert(1)</script>';
  const html = errorPage("invalid_request", "nope", injected);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;/);

  const consent = consentPage({
    req: { ...sampleReq, clientId: injected },
    identity,
    consent: "oct1.a.b",
    name: '<img src=x onerror=alert(1)>',
    meta: { fetched: true, name: null, redirectUris: null },
  });
  assert.ok(!consent.includes("<img src=x"));
});

test("the sign-in page names the host the request came from", () => {
  const html = signInPage(getUrl());
  assert.match(html, /claude\.ai/);
});

test("redirectHost keeps the port, because a loopback client is identified by one", () => {
  assert.equal(redirectHost("http://127.0.0.1:53219/callback"), "127.0.0.1:53219");
  assert.equal(redirectHost(CLAUDE_REDIRECT), "claude.ai");
});
