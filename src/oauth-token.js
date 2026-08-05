// @ts-check
// POST /oauth/token — the OAuth 2.1 token endpoint of the connector
// authorization server (docs/MCP-CONNECTOR.md §2 items 6–9, §2a; F-20).
//
// This is the one endpoint in the flow that BOTH hosted clients call on their
// own, unattended, forever: Claude refreshes reactively on a 401 and
// proactively five minutes before expiry, and ChatGPT does the same. The
// authorize endpoint is a person clicking a button once; this is a machine
// loop, so every wire detail below is a thing a connector breaks on rather
// than a preference.
//
// THE FOUR REQUIREMENTS THAT DECIDE WHETHER A CONNECTOR WORKS, all verified
// 2026-08-03 against Anthropic's and OpenAI's connector documentation:
//
//   1. THE BODY IS `application/x-www-form-urlencoded` — for the initial
//      exchange AND for refreshes. RFC 6749 §4.1.3 has always said so and both
//      vendors restate it. A JSON-only parser here answers 415 to every client
//      that exists, which is why the form path is the primary one and the JSON
//      reading below is a fallback, never the other way round. (A DCR
//      /register endpoint, if one is ever served, takes JSON instead — the two
//      do not share a parser, and that is the documented trap.)
//   2. THE ERROR SHAPE IS RFC 6749 §5.2 AND THE VALUE MATTERS. Clients BRANCH
//      on `error`: `invalid_grant` is the one that means "your grant is dead,
//      start a new authorization", and it is the only thing that gets a user
//      out of a broken connector without deleting and re-adding it. A custom
//      code, a bare string, or a 500 all read as "the server is sick, retry
//      later" — so the connector retries the same dead token until the user
//      gives up. Every failure path here therefore lands on one of the
//      registered codes with HTTP 400.
//   3. REFRESH TOKENS ROTATE. Both clients register as PUBLIC clients (CIMD,
//      DCR fallback), and a public client's refresh token has to rotate: the
//      new one comes back in the SAME response that invalidated the old one.
//      That is `rotateRefreshToken`'s contract, not something composed here —
//      this handler must never mint a replacement separately, or a crash
//      between the two calls strands the connection.
//   4. `client_credentials` IS REFUSED. Anthropic states it is not supported;
//      every connection goes through user consent. Refusing it explicitly with
//      `unsupported_grant_type` is better than a generic error because it says
//      so in the one place an integrator looks.
//
// PUBLIC CLIENT: no client secret, no `Authorization` header, no client table.
// The `client_id` is a CIMD URL we do not authenticate — the security comes
// from PKCE (the code is useless without the verifier) and from the redirect
// allowlist (src/oauth-metadata.js), not from a shared secret. Do not add an
// auth check here; it would break both vendors, whose registered token-endpoint
// auth method is `none`.
//
// LATENCY: 10 s for the initial exchange, 30 s for a refresh, past which the
// flow fails even if the request eventually completes. So the work is bounded
// to what the grant needs — one store call per grant plus the mints — and
// there is no lookup, no account read, and no enrichment on this path.
//
// FILE-LAYOUT RULE: src/oauth-store.js touches D1 and is loaded through a
// dynamic import inside the handler, so importing this module pulls in no
// database graph. The same import point is the seam the tests inject a fake
// store through.

import { jsonResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * The slice of src/oauth-store.js this endpoint uses. Declared structurally so
 * the handler can be exercised against a fake in unit tests without a D1 fake
 * underneath it — the store's own suite owns the storage semantics; this one
 * owns the wire.
 * @typedef {Object} TokenStore
 * @property {number} [ACCESS_TOKEN_TTL_S]
 * @property {(env: Env, code: string, opts: { clientId: string, redirectUri: string, codeVerifier: string }) => Promise<{ userId: string, scope: string } | { error: string }>} redeemAuthCode
 * @property {(env: Env, args: { userId: string, scope: string }) => Promise<{ token: string, exp: number }>} mintAccessToken
 * @property {(env: Env, args: { userId: string, clientId: string, scope: string }) => Promise<{ token: string, jti: string }>} mintRefreshToken
 * @property {(env: Env, token: string, opts: { clientId: string }) => Promise<{ userId: string, scope: string, refresh: { token: string, jti: string } } | { error: string }>} rotateRefreshToken
 */

/** Fallback lifetime advertised as `expires_in` when the store reports no usable `exp`. */
const FALLBACK_EXPIRES_IN = 3600;

/**
 * The scope value that makes a refresh token appear. Both clients append it
 * when the authorization-server metadata lists it (it does —
 * src/oauth-metadata.js OAUTH_SCOPES), and a connection that gets no refresh
 * token silently degrades into one that re-prompts for consent every hour.
 */
const OFFLINE_SCOPE = "offline_access";

/**
 * Every response this endpoint makes, error or success.
 *
 * `Cache-Control: no-store` + `Pragma: no-cache` are REQUIRED by RFC 6749
 * §5.1, and not decoratively: the body is a bearer credential, and the path
 * between a hosted client and here runs through infrastructure neither end
 * controls. A cached token response is a token handed to the next caller.
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function tokenResponse(body, status, extra = {}) {
  return jsonResponse(body, status, {
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extra,
  });
}

/**
 * An RFC 6749 §5.2 error. The `error` field is the contract; the description
 * is for whoever is reading a network log and is never load-bearing, so it
 * carries no token, no code and no account identifier.
 *
 * ALWAYS HTTP 400 (§5.2 reserves 401 for client authentication failures, which
 * a public-client endpoint cannot have). A 500 here would be read as transient
 * and retried against a grant that will never work again.
 * @param {string} error one of the registered codes
 * @param {string} description
 * @returns {Response}
 */
function tokenError(error, description) {
  return tokenResponse({ error, error_description: description }, 400);
}

/**
 * Parse a token-endpoint body without deciding in advance which encoding the
 * client used.
 *
 * THE FORM ENCODING IS THE SPECIFIED ONE and the one both vendors send, so it
 * is what an unlabelled body is read as. JSON is accepted as well, for two
 * reasons: some SDKs and gateways rewrite the body on the way out, and a 415
 * on this endpoint surfaces to the user as an unexplained "couldn't connect"
 * with no way to tell it from a network fault. Accepting the second encoding
 * costs nothing in posture — the endpoint is a public client's, so there is no
 * cookie, no ambient authority, and therefore nothing a content-type check
 * would be protecting.
 *
 * The body is read as text ONCE and parsed from that text, because a Request
 * body cannot be read twice and a fallback has to be able to re-parse.
 * Content-type steers; a body with no usable content-type is sniffed (`{`
 * means JSON) rather than refused.
 * @param {string} contentType the raw `content-type` header, or ""
 * @param {string} text the raw body
 * @returns {Record<string, string>} every value coerced to a string; missing keys absent
 */
export function parseTokenBody(contentType, text) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  const looksJson = text.trimStart().startsWith("{");
  const asJson = type === "application/json" || type === "text/json" || (!type && looksJson) || (type === "text/plain" && looksJson);
  if (asJson) {
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
      /** @type {Record<string, string>} */
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue;
        if (typeof v === "object") continue; // no nested shapes on this wire
        out[k] = String(v);
      }
      return out;
    } catch {
      return {};
    }
  }
  /** @type {Record<string, string>} */
  const out = {};
  // URLSearchParams is the exact x-www-form-urlencoded reader (including `+`
  // for space, which decodeURIComponent alone gets wrong). First value wins on
  // a repeated key, which is what RFC 6749 §3.2's "MUST NOT be included more
  // than once" makes moot for a well-behaved client and harmless otherwise.
  for (const [k, v] of new URLSearchParams(text)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Trimmed non-empty string, or "". Both clients send clean values; a stray
 * space around a `code` pasted through a proxy is the kind of thing that turns
 * into an `invalid_grant` nobody can explain.
 * @param {Record<string, string>} params
 * @param {string} key
 * @returns {string}
 */
function field(params, key) {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Whether a granted scope entitles the connection to a refresh token.
 * @param {string} scope space-delimited
 * @returns {boolean}
 */
export function scopeHasOffline(scope) {
  return typeof scope === "string" && scope.split(/\s+/).includes(OFFLINE_SCOPE);
}

/**
 * The success body (RFC 6749 §5.1). `token_type` is capital-B `Bearer` because
 * that is the registered value; clients compare it case-insensitively but not
 * all of them, and there is no upside to finding out which.
 * @param {{ token: string, exp: number }} access
 * @param {string} scope
 * @param {string | null} refreshToken
 * @param {number} nowS
 * @param {number} [ttlFallback]
 * @returns {Record<string, unknown>}
 */
export function successBody(access, scope, refreshToken, nowS, ttlFallback) {
  const remaining = Number.isFinite(access?.exp) ? Math.floor(access.exp - nowS) : NaN;
  const ceiling = ttlFallback || FALLBACK_EXPIRES_IN;
  // CLAMPED to the TTL, and the off-by-one is real rather than theoretical.
  // `nowS` is read once when the request arrives; `access.exp` is computed from
  // the mint's OWN later clock read. If the wall clock crosses a second between
  // the two — which under a loaded test runner it does, and on a cold isolate it
  // can — then `exp - nowS` is TTL+1, and the endpoint advertises a lifetime
  // longer than the token actually has. Harmless to a client, but it is the
  // server contradicting itself, and it was surfacing as an intermittent
  // failure of the "expires_in <= 3600" assertion that nobody could reproduce
  // in isolation. Clamping states the invariant here instead of hoping the two
  // clock reads land in the same second.
  const expiresIn = Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, ceiling) : ceiling;
  /** @type {Record<string, unknown>} */
  const body = {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope,
  };
  // Only present when one was actually issued. An absent field means "you have
  // no refresh token"; an empty string would be stored and then presented.
  if (refreshToken) body.refresh_token = refreshToken;
  return body;
}

/**
 * POST /oauth/token.
 *
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {TokenStore} [store] injected by the tests; production loads
 *   src/oauth-store.js lazily so this module stays free of the D1 graph.
 * @returns {Promise<Response>}
 */
export async function handleOAuthToken(request, env, log, store) {
  if (request.method !== "POST") {
    // Defensive: the router only sends POST here. A GET is nearly always a
    // person or a probe opening the URL in a browser, and it should read as a
    // method problem rather than as a malformed grant.
    return tokenResponse(
      { error: "invalid_request", error_description: "The token endpoint takes POST with a form-encoded body." },
      405,
      { allow: "POST" },
    );
  }

  /** @type {string} */
  let text;
  try {
    text = await request.text();
  } catch {
    return tokenError("invalid_request", "The request body could not be read.");
  }
  const params = parseTokenBody(request.headers.get("content-type") || "", text);
  const grantType = field(params, "grant_type");
  const clientId = field(params, "client_id");

  if (!grantType) {
    return tokenError("invalid_request", "grant_type is required.");
  }
  if (grantType === "client_credentials") {
    // Named explicitly rather than falling into the default branch: an
    // integrator reaching for a machine-to-machine grant is the one case where
    // the reason belongs in the response. Every connection here needs a user's
    // consent, which is a property of the product and not a gap to fill in.
    return tokenError(
      "unsupported_grant_type",
      "client_credentials is not supported: every connection is authorized by a signed-in account.",
    );
  }
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return tokenError("unsupported_grant_type", `The grant type ${JSON.stringify(grantType)} is not supported.`);
  }
  // Required for a public client by RFC 6749 §3.2.1 / §6, and sent by both
  // vendors. Demanded up front because the alternative — passing an empty
  // client_id into the store — surfaces as `invalid_grant`, which tells the
  // client to throw the grant away and re-authorize into the identical
  // failure. `invalid_request` at least names the missing parameter.
  if (!clientId) {
    return tokenError("invalid_request", "client_id is required.");
  }

  /** @type {TokenStore} */
  let s;
  try {
    s = store || /** @type {TokenStore} */ (/** @type {unknown} */ (await import("./oauth-store.js")));
  } catch (err) {
    log.error("oauth.token_store_unavailable", { error: (/** @type {any} */ (err))?.message });
    // The one non-400 failure that is honest: nothing about the request is
    // wrong, so `invalid_grant` would be a lie that costs the user their
    // connection. RFC 6749 §5.2 leaves 5xx to the server's discretion.
    return tokenResponse({ error: "temporarily_unavailable", error_description: "The token service is unavailable." }, 503);
  }

  const nowS = Math.floor(Date.now() / 1000);

  if (grantType === "authorization_code") {
    const code = field(params, "code");
    const redirectUri = field(params, "redirect_uri");
    const codeVerifier = field(params, "code_verifier");
    // All four are required. PKCE is not optional here whatever the client
    // says: both vendors send S256 on every authorization request, and the
    // metadata advertises S256 as the only method, so a token request without
    // a verifier is either a bug or an attempt to redeem an intercepted code.
    const missing = [
      !code && "code",
      !redirectUri && "redirect_uri",
      !codeVerifier && "code_verifier",
    ].filter(Boolean);
    if (missing.length) {
      return tokenError("invalid_request", `Missing required parameter(s): ${missing.join(", ")}.`);
    }

    /** @type {any} */
    let redeemed;
    try {
      redeemed = await s.redeemAuthCode(env, code, { clientId, redirectUri, codeVerifier });
    } catch (err) {
      log.error("oauth.token_redeem_failed", { client_id: clientId, error: (/** @type {any} */ (err))?.message });
      return tokenResponse({ error: "temporarily_unavailable", error_description: "The authorization code could not be redeemed." }, 503);
    }
    if (!redeemed || redeemed.error) {
      // The store distinguishes a malformed request from a dead grant; both are
      // 400 and both are registered codes, so it is passed through as-is with
      // `invalid_grant` as the safe default for anything unrecognized.
      const code6749 = redeemed?.error === "invalid_request" ? "invalid_request" : "invalid_grant";
      log.warn("oauth.token_denied", { grant_type: grantType, client_id: clientId, error: code6749 });
      return tokenError(code6749, "The authorization code is invalid, expired, or already used.");
    }

    const scope = typeof redeemed.scope === "string" ? redeemed.scope : "";
    const access = await s.mintAccessToken(env, { userId: redeemed.userId, scope });
    /** @type {string | null} */
    let refreshToken = null;
    if (scopeHasOffline(scope)) {
      const refresh = await s.mintRefreshToken(env, { userId: redeemed.userId, clientId, scope });
      refreshToken = refresh.token;
    }
    log.info("oauth.token_issued", {
      grant_type: grantType,
      client_id: clientId,
      user_id: redeemed.userId,
      scope,
      refresh: !!refreshToken,
    });
    return tokenResponse(successBody(access, scope, refreshToken, nowS, s.ACCESS_TOKEN_TTL_S), 200);
  }

  // ---- refresh_token -------------------------------------------------------
  const presented = field(params, "refresh_token");
  if (!presented) {
    return tokenError("invalid_request", "refresh_token is required.");
  }

  /** @type {any} */
  let rotated;
  try {
    // ROTATION HAPPENS INSIDE THIS ONE CALL: the old jti dies and the
    // replacement is minted together, and the replacement is returned in this
    // same response. Splitting it — verify here, mint there — is what produces
    // a connection holding a refresh token the server has already killed.
    rotated = await s.rotateRefreshToken(env, presented, { clientId });
  } catch (err) {
    log.error("oauth.token_rotate_failed", { client_id: clientId, error: (/** @type {any} */ (err))?.message });
    return tokenResponse({ error: "temporarily_unavailable", error_description: "The refresh token could not be rotated." }, 503);
  }
  if (!rotated || rotated.error) {
    // THE BRANCH THAT MATTERS. A reused, unknown, revoked or expired refresh
    // token is `invalid_grant` and nothing else — that exact value is what
    // tells Claude and ChatGPT to drop the connection's tokens and run the
    // authorization flow again. Anything else leaves the user with a connector
    // that fails every call and offers no way to fix it.
    const code6749 = rotated?.error === "invalid_request" ? "invalid_request" : "invalid_grant";
    log.warn("oauth.token_denied", { grant_type: grantType, client_id: clientId, error: code6749 });
    return tokenError(code6749, "The refresh token is invalid, expired, or has already been used.");
  }

  const scope = typeof rotated.scope === "string" ? rotated.scope : "";
  const access = await s.mintAccessToken(env, { userId: rotated.userId, scope });
  log.info("oauth.token_refreshed", {
    grant_type: grantType,
    client_id: clientId,
    user_id: rotated.userId,
    scope,
  });
  return tokenResponse(successBody(access, scope, rotated.refresh?.token || null, nowS, s.ACCESS_TOKEN_TTL_S), 200);
}
