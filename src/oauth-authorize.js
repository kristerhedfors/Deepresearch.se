// @ts-check
// THE AUTHORIZATION ENDPOINT — the one page a human sees in the whole
// connector flow (docs/MCP-CONNECTOR.md §4, F-20).
//
// GET /oauth/authorize validates what the client asked for and renders a
// consent screen; POST /oauth/authorize turns a click on "Connect" into an
// authorization code and hands it back over the redirect. Both hosted clients
// — Claude and ChatGPT — drive exactly this pair, which is why it lives on the
// APEX rather than on the MCP host: the account, Google sign-in and the
// session cookie are already here, and a consent screen has to read as THIS
// SITE to the person approving it.
//
// ── WHY THE VALIDATION ORDER IS WHAT IT IS ────────────────────────────────
// `redirect_uri` is checked FIRST and its failure is the only one that does
// not redirect. Everything else in RFC 6749 §4.1.2.1 is reported by sending
// the browser back to the client with `error=` and the original `state`; but
// an unvalidated redirect target is exactly the thing an open redirector is
// made of, so a refused URI gets a rendered page and never a `Location`.
// That branch also LOGS the value it refused (`oauth.redirect_refused`). An
// exact-match failure surfaces to the user as a generic "couldn't connect" and
// is the commonest reported ChatGPT connector problem — the refused string is
// the only diagnostic anyone gets, and it is unobtainable from outside.
//
// ── CIMD, AND WHAT IT IS AND IS NOT ALLOWED TO DECIDE ─────────────────────
// `client_id` is an HTTPS URL to a Client ID Metadata Document. Fetching it is
// what buys a friendly name on the consent screen and a second, independent
// statement of which redirects the client owns — with no client table and
// nothing accumulating per connection (the whole reason CIMD is advertised
// over DCR).
//
// The fetch degrades the DISPLAY and nothing else. A timeout, a 500, or
// unparseable JSON costs the friendly name — the screen falls back to the
// `client_id`'s hostname — and the flow continues, because the security
// boundary is `redirectAllowed()` (src/oauth-metadata.js), not the document.
// A code can only ever be delivered to an allowlisted URI, so a network blip
// at Anthropic's end must not break every connection attempt.
//
// What the document is allowed to do is NARROW. If it is fetched and it does
// carry a `redirect_uris` array that does not contain the requested URI, that
// is a hard refusal and a rendered page — the client_id has just told us it
// does not own the callback, so sending it an error with the user's `state`
// is not a thing to do politely. Fail-soft applies to the fetch; it never
// applies to a check the document actually answered.
//
// ── CSRF, AND WHY THE FORM CARRIES ITS OWN REQUEST ────────────────────────
// The POST does not read `client_id` / `redirect_uri` / `code_challenge` from
// the form at all. The GET mints a SIGNED CONSENT TOKEN (`oct1.` — its own
// namespace under the single SESSION_SECRET, like every other family here)
// holding the request it just validated plus the uid it was shown to, and the
// form carries only that token and the decision. Three properties fall out:
//
//   1. The POST cannot be pointed at a different redirect than the one the
//      user read on the screen — the parameters are inside the signature.
//   2. It is bound to `sub`, so a token minted for one account is useless in
//      another account's browser.
//   3. It expires (CONSENT_TTL_S), so a consent screen left open for a day
//      does not stay clickable.
//
// Underneath that sit two structural defences: `dr_session` is `SameSite=Lax`,
// so a cross-site POST arrives with no cookie and never reaches a handler at
// all; and the consent page is served `frame-ancestors 'none'`, because a
// consent screen that can be framed is a consent screen that can be clicked
// by someone else.
//
// ── THE FILE-LAYOUT RULE ──────────────────────────────────────────────────
// Everything here is pure except the mint, which touches D1 — so `mintAuthCode`
// arrives through a dynamic `import()` inside the POST handler. The optional
// `deps.mintAuthCode` override is the seam that lets the redirect construction
// be unit-tested without standing up a D1 fake; the store's own suite owns
// whether a code is minted correctly.

import { htmlResponse } from "./http.js";
import { DEFAULT_SCOPE, OAUTH_SCOPES, redirectAllowed } from "./oauth-metadata.js";
import { looksRegistered, resolveRegisteredClient } from "./oauth-register.js";
import { safeEqual, sealedToken, verifiedClaims } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/** Wire prefix of the consent token (its own family, its own namespace). */
export const CONSENT_PREFIX = "oct1";
const CONSENT_NS = "oauthconsent.";

/**
 * How long a rendered consent screen stays clickable. Ten minutes is long
 * enough to read the page and short enough that a tab left open overnight is
 * not a live approval.
 */
export const CONSENT_TTL_S = 600;

/**
 * The CIMD fetch's slice of the flow's budget. Claude allows 10 s for the
 * whole of discovery, registration and token (docs/MCP-CONNECTOR.md §2), and
 * this fetch sits inside a page render a person is waiting on — so it gets a
 * few seconds and then the screen renders without a friendly name.
 */
export const CIMD_TIMEOUT_MS = 4000;

/** Refuse to parse a "metadata document" larger than this. */
const CIMD_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Request validation (pure)
// ---------------------------------------------------------------------------

/**
 * The validated authorization request the consent screen is rendered from.
 * @typedef {Object} AuthorizeRequest
 * @property {string} clientId the CIMD URL
 * @property {string} redirectUri
 * @property {string} codeChallenge
 * @property {string} scope space-delimited, already narrowed to known scopes
 * @property {string} state "" when the client sent none (both hosted clients do)
 * @property {string} resource RFC 8707 target, "" when absent
 */

/**
 * The outcome of validating a `GET /oauth/authorize` query string.
 *
 * `render` is the branch that must NOT redirect (see the header): a missing or
 * unallowed `redirect_uri`. `redirect` is every other RFC 6749 error, which
 * goes back to the client with `state` intact.
 * @typedef {{ kind: "ok", req: AuthorizeRequest }
 *   | { kind: "render", error: string, description: string, refusedRedirect?: string }
 *   | { kind: "redirect", redirectUri: string, error: string, description: string, state: string }
 * } AuthorizeParseResult
 */

/**
 * Validate the authorization request. Pure — no fetch, no bindings — so the
 * whole error matrix is unit-testable without a network or a database.
 *
 * ORDER IS SECURITY, not tidiness: the redirect target is settled before any
 * error can be routed to it.
 * @param {URLSearchParams} params
 * @returns {AuthorizeParseResult}
 */
export function parseAuthorizeParams(params) {
  const redirectUri = (params.get("redirect_uri") || "").trim();
  const state = params.get("state") || "";

  if (!redirectUri) {
    return {
      kind: "render",
      error: "invalid_request",
      description: "No redirect_uri was supplied, so there is nowhere to send you back to.",
    };
  }
  if (!redirectAllowed(redirectUri)) {
    return {
      kind: "render",
      error: "invalid_request",
      description: "That redirect_uri is not one this server will hand an authorization code to.",
      refusedRedirect: redirectUri,
    };
  }

  /** @param {string} error @param {string} description @returns {AuthorizeParseResult} */
  const bounce = (error, description) => ({ kind: "redirect", redirectUri, error, description, state });

  const responseType = (params.get("response_type") || "").trim();
  if (responseType !== "code") {
    return bounce(
      "unsupported_response_type",
      `Only response_type=code is supported${responseType ? ` (got "${responseType}")` : ""}.`,
    );
  }

  const clientId = (params.get("client_id") || "").trim();
  if (!clientId) return bounce("invalid_request", "client_id is required.");
  // TWO SHAPES ARE VALID, and the prefix tells them apart before anything is
  // fetched or verified:
  //   - a DCR registration issued by src/oauth-register.js (`orc1.…`), whose
  //     signature is checked in the GET handler — this parse is synchronous and
  //     verification is not;
  //   - a CIMD client_id, which IS the metadata document's URL, so anything
  //     that is not an https URL cannot be one. http is refused rather than
  //     upgraded: a metadata document fetched over plaintext states nothing.
  if (!looksRegistered(clientId)) {
    let clientUrl;
    try {
      clientUrl = new URL(clientId);
    } catch {
      clientUrl = null;
    }
    if (!clientUrl || clientUrl.protocol !== "https:") {
      return bounce(
        "invalid_request",
        "client_id must be the https URL of a Client ID Metadata Document, or an identifier issued by this server's " +
          "dynamic registration endpoint (/oauth/register).",
      );
    }
  }

  const codeChallenge = (params.get("code_challenge") || "").trim();
  if (!codeChallenge) {
    return bounce("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  // The SHAPE is checked here, not left to the code mint. An S256 challenge is
  // 43 base64url characters, always; anything else is a client bug. Without
  // this the value travels all the way to mintAuthCode, which throws on it —
  // and the user gets a `server_error` redirect for what is squarely an
  // `invalid_request`, sending whoever debugs it to the wrong side.
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return bounce(
      "invalid_request",
      "code_challenge must be the base64url-encoded SHA-256 of the verifier (43 characters).",
    );
  }
  // `plain` is not a downgrade we accept: the metadata advertises S256 only,
  // and a client that ignored that has a bug worth surfacing at the start of
  // the flow rather than at the token exchange.
  const method = (params.get("code_challenge_method") || "").trim();
  if (method !== "S256") {
    return bounce(
      "invalid_request",
      `code_challenge_method must be S256${method ? ` (got "${method}")` : " (none was sent)"}.`,
    );
  }

  const scope = normalizeScope(params.get("scope"));
  if (!scope) {
    return bounce("invalid_scope", `Supported scopes are: ${OAUTH_SCOPES.join(", ")}.`);
  }

  return {
    kind: "ok",
    req: { clientId, redirectUri, codeChallenge, scope, state, resource: (params.get("resource") || "").trim() },
  };
}

/**
 * Narrow a requested scope to what this resource actually offers.
 *
 * Unknown entries are DROPPED rather than refused — clients append scopes they
 * assume (`profile`, `email`) and refusing the whole request over one of them
 * turns a working connection into an unexplained failure. Refusal is reserved
 * for a request that asked for nothing we recognise at all, which is a real
 * mismatch rather than noise.
 * @param {string | null} raw
 * @returns {string | null} the granted scope, or null when nothing survived
 */
function normalizeScope(raw) {
  const asked = String(raw || "").trim();
  if (!asked) return DEFAULT_SCOPE;
  /** @type {string[]} */
  const known = [...OAUTH_SCOPES];
  const kept = asked.split(/\s+/).filter((s) => known.includes(s));
  return kept.length ? kept.join(" ") : null;
}

// ---------------------------------------------------------------------------
// The Client ID Metadata Document
// ---------------------------------------------------------------------------

/**
 * What a CIMD fetch produced.
 * @typedef {Object} ClientMetadata
 * @property {boolean} fetched true only when a usable document came back
 * @property {string | null} name the document's `client_name`, when it has one
 * @property {string[] | null} redirectUris the document's `redirect_uris`, when
 *   it carries the array — null means the document answered no such question
 *   and the check below cannot bind
 */

/**
 * Fetch and sanity-check a Client ID Metadata Document.
 *
 * Never throws and never rejects the flow on its own: every failure path
 * returns `fetched: false`, which costs the friendly name and nothing else
 * (the header explains why that is the safe direction). The one substantive
 * check is `client_id` — CIMD requires the document to name the URL it was
 * served from, and a document that names a different one is not describing
 * this client, so it is discarded rather than believed.
 * @param {string} clientId
 * @param {number} [timeoutMs]
 * @returns {Promise<ClientMetadata>}
 */
export async function fetchClientMetadata(clientId, timeoutMs = CIMD_TIMEOUT_MS) {
  /** @type {ClientMetadata} */
  const miss = { fetched: false, name: null, redirectUris: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {any} */
  let doc;
  try {
    const res = await fetch(clientId, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return miss;
    const text = (await res.text()).slice(0, CIMD_MAX_BYTES);
    doc = JSON.parse(text);
  } catch {
    return miss;
  } finally {
    clearTimeout(timer);
  }

  if (!doc || typeof doc !== "object") return miss;
  if (typeof doc.client_id === "string" && doc.client_id !== clientId) return miss;

  const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 120) : null;
  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((/** @type {unknown} */ u) => typeof u === "string")
    : null;
  return { fetched: true, name, redirectUris };
}

/**
 * The name to put on the consent screen. A document's `client_name` when there
 * is one; otherwise the `client_id`'s hostname, which is the honest fallback —
 * it is still the party the user is authorizing, just spelled as a machine
 * rather than as a brand.
 * @param {string} clientId
 * @param {ClientMetadata} meta
 * @returns {string}
 */
export function clientDisplayName(clientId, meta) {
  if (meta.name) return meta.name;
  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId;
  }
}

/** @param {string} uri @returns {string} the hostname the MCP spec requires be shown */
export function redirectHost(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// ---------------------------------------------------------------------------
// The consent token (CSRF + the validated request, in one signed blob)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ConsentClaims
 * @property {number} v
 * @property {string} sub the uid the screen was rendered for
 * @property {string} cid client_id
 * @property {string} ru redirect_uri
 * @property {string} cc code_challenge
 * @property {string} sc granted scope
 * @property {string} st state
 * @property {string} res RFC 8707 resource ("" when absent)
 * @property {number} exp seconds since epoch
 */

/**
 * Mint the hidden form field. Same wire shape as the other non-JWT families
 * here (`mck1.`, `wsk1.`): one base64url payload segment and a hex tag, signed
 * under this family's own namespace so it cannot be swapped with any other.
 * @param {Env} env
 * @param {AuthorizeRequest} req
 * @param {string} uid
 * @param {number} [nowMs]
 * @returns {Promise<string>}
 */
export async function mintConsentToken(env, req, uid, nowMs = Date.now()) {
  /** @type {ConsentClaims} */
  const claims = {
    v: 1,
    sub: uid,
    cid: req.clientId,
    ru: req.redirectUri,
    cc: req.codeChallenge,
    sc: req.scope,
    st: req.state,
    res: req.resource,
    exp: Math.floor(nowMs / 1000) + CONSENT_TTL_S,
  };
  return sealedToken(env, CONSENT_NS, CONSENT_PREFIX, claims);
}

/**
 * Verify a consent token and bind it to the caller.
 *
 * Null on every failure — bad shape, wrong family, bad tag, expired, or minted
 * for a different account. The `uid` comparison is what makes this a CSRF
 * defence rather than a replay convenience: a token lifted from someone else's
 * screen does not verify in this browser.
 * @param {Env} env
 * @param {string} token
 * @param {string} uid
 * @param {number} [nowMs]
 * @returns {Promise<ConsentClaims | null>}
 */
export async function verifyConsentToken(env, token, uid, nowMs = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== CONSENT_PREFIX) return null;
  const claims = await verifiedClaims(env, CONSENT_NS, parts[1], parts[2]);
  if (!claims || claims.v !== 1) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  if (typeof claims.sub !== "string" || !safeEqual(claims.sub, uid)) return null;
  if (typeof claims.ru !== "string" || typeof claims.cid !== "string" || typeof claims.cc !== "string") return null;
  return /** @type {ConsentClaims} */ (claims);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Every page this module serves. `no-store` because a consent screen carries a
 * one-shot signed token; `frame-ancestors 'none'` (plus the legacy header,
 * which some clients still honour and no client is harmed by) because a
 * framed consent screen is a clickjacking target.
 *
 * ── WHY `same-origin` AND NOT `no-referrer` ───────────────────────────────
 * This header was `no-referrer` and it broke the flow at the last click.
 * `Referrer-Policy` does not only govern `Referer`: Fetch's "append a request
 * `Origin` header" step reads the *referrer policy* for a non-CORS request
 * whose method is not GET or HEAD, and under `no-referrer` it serializes the
 * origin as the literal string `null`. So the consent form's own same-origin
 * POST arrived carrying `Origin: null`, the cross-origin guard below read that
 * as another site, and every connection attempt died on a 403 that said the
 * form had been submitted from somewhere else. Observed in production on the
 * first live connector run (2026-08-04, `oauth.consent_cross_origin`,
 * `origin: "null"`, ~23 s after `oauth.consent_shown`) and reproduced in
 * Chromium against a two-line server: `no-referrer` → `Origin: null`,
 * `same-origin` → the real origin.
 *
 * `same-origin` keeps the property the old header was chosen for — the query
 * string, which holds the code challenge and the state, still never leaves
 * this origin, because a cross-origin navigation gets no referrer at all — and
 * it leaves the POST's `Origin` intact so the guard can do its job. The 302
 * back to the client keeps `no-referrer` (see `bounceTo`); that one is a
 * redirect, not a form, so no `Origin` depends on it.
 * @param {string} html
 * @param {number} [status]
 * @returns {Response}
 */
function page(html, status = 200) {
  const res = htmlResponse(html, status);
  res.headers.set("cache-control", "no-store");
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("referrer-policy", "same-origin");
  return res;
}

/**
 * A 302 back to the client. Built through `URL` rather than string
 * concatenation so a redirect that already carries a query cannot be corrupted
 * — and `no-store` so the browser does not keep a URL with a code in it.
 * @param {string} redirectUri
 * @param {Record<string, string>} params
 * @returns {Response}
 */
function bounceTo(redirectUri, params) {
  const target = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v) target.searchParams.set(k, v);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

/**
 * Render the consent screen for a validated request.
 *
 * `identity` may be null: an unauthenticated arrival gets a sign-in page (401)
 * that explains what it was in the middle of, rather than an OAuth error the
 * client would report as a broken server. When the route is wired BELOW the
 * identity gate the null branch simply never fires, and the site's own
 * sign-in/terms/approval pages do the work — either wiring is correct.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity | null} identity
 * @returns {Promise<Response>}
 */
export async function handleAuthorizeGet(request, env, url, log, identity) {
  const parsed = parseAuthorizeParams(url.searchParams);

  if (parsed.kind === "render") {
    // The refused-redirect log line. It is the only diagnostic anyone gets
    // for the commonest connector failure, and it cannot be obtained from
    // outside — docs/MCP-CONNECTOR.md §4.
    if (parsed.refusedRedirect) {
      log.warn("oauth.redirect_refused", {
        redirect_uri: parsed.refusedRedirect,
        client_id: url.searchParams.get("client_id") || "",
        reason: "not_allowlisted",
      });
    } else {
      log.warn("oauth.authorize_rejected", { error: parsed.error, reason: "no_redirect_uri" });
    }
    return page(errorPage(parsed.error, parsed.description, parsed.refusedRedirect), 400);
  }
  if (parsed.kind === "redirect") {
    log.warn("oauth.authorize_rejected", {
      error: parsed.error,
      client_id: url.searchParams.get("client_id") || "",
      redirect_host: redirectHost(parsed.redirectUri),
    });
    return bounceTo(parsed.redirectUri, {
      error: parsed.error,
      error_description: parsed.description,
      state: parsed.state,
    });
  }

  const req = parsed.req;

  if (!identity) return page(signInPage(url), 401);
  if (identity.pending) {
    return page(
      errorPage(
        "access_denied",
        "This account is still waiting for the site owner's approval, so it cannot authorize a client yet.",
      ),
      403,
    );
  }
  // Consent needs an account row: the code is minted against a user id, and
  // the break-glass operator identity (and the `test:` personas) have none.
  if (!identity.user) {
    return page(
      errorPage(
        "access_denied",
        "Connecting a client needs a signed-in account. The break-glass operator identity cannot authorize one.",
      ),
      403,
    );
  }

  // A DYNAMICALLY REGISTERED CLIENT carries its own metadata in its identifier,
  // so there is nothing to fetch: the signature is the check, and the redirect
  // URIs it registered play exactly the role a CIMD document's do below. A
  // `orc1.` that does not verify is a hard refusal — it is either forged or
  // signed under a rotated key, and neither is something to fall through to a
  // network fetch of a string that is not a URL.
  let registered = null;
  if (looksRegistered(req.clientId)) {
    registered = await resolveRegisteredClient(env, req.clientId);
    if (!registered) {
      log.warn("oauth.client_unverified", { client_id: req.clientId.slice(0, 24) });
      return page(
        errorPage(
          "invalid_client",
          "That client_id was not issued by this server, or is no longer valid. Remove the connector and add it again " +
            "so it registers afresh.",
        ),
        400,
      );
    }
  }

  // A registration that named itself gets that name on the consent screen; one
  // that did not falls back to its callback's hostname, which is the same
  // honest answer clientDisplayName gives a CIMD client (and is what stops a
  // 200-character signed identifier being rendered as the client's "name").
  const meta = registered
    ? {
        fetched: true,
        name: registered.name || redirectHost(req.redirectUri),
        redirectUris: registered.redirectUris,
      }
    : await fetchClientMetadata(req.clientId);

  // The document is allowed to NARROW, never to widen — and when it answered
  // this question and the answer is no, that is a refusal we render rather
  // than hand back over a callback the client just disclaimed.
  if (meta.fetched && meta.redirectUris && !meta.redirectUris.includes(req.redirectUri)) {
    log.warn("oauth.redirect_refused", {
      redirect_uri: req.redirectUri,
      client_id: req.clientId,
      reason: "not_in_client_metadata",
    });
    return page(
      errorPage(
        "invalid_request",
        "The client's own metadata document does not list this redirect_uri, so this server will not send a code to it.",
        req.redirectUri,
      ),
      400,
    );
  }
  if (!meta.fetched) {
    log.info("oauth.cimd_unavailable", { client_id: req.clientId });
  }

  const consent = await mintConsentToken(env, req, identity.id);
  log.info("oauth.consent_shown", {
    user_id: identity.id,
    client_id: req.clientId,
    client_name: meta.name || "",
    redirect_host: redirectHost(req.redirectUri),
    scope: req.scope,
  });
  return page(consentPage({ req, identity, consent, name: clientDisplayName(req.clientId, meta), meta }));
}

// ---------------------------------------------------------------------------
// POST /oauth/authorize
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AuthorizeDeps
 * @property {(env: Env, args: { userId: string, clientId: string, redirectUri: string, codeChallenge: string, scope: string, now?: number }) => Promise<{ code: string, jti: string, exp: number }>} [mintAuthCode]
 *   Test seam and the file-layout rule's dynamic boundary in one: the real
 *   implementation touches D1 and is imported on demand.
 */

/**
 * The user decided. Approve mints a code and 302s back with it; anything else
 * 302s back with `access_denied`. Both carry the original `state`.
 *
 * Nothing in the form is trusted except the signed consent token — the request
 * being approved is the one that was rendered, byte for byte.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity | null} identity
 * @param {AuthorizeDeps} [deps]
 * @returns {Promise<Response>}
 */
export async function handleAuthorizePost(request, env, url, log, identity, deps) {
  if (!identity) return page(signInPage(url), 401);

  // Belt to `SameSite=Lax`'s braces. A same-origin form POST carries an
  // `Origin` header in every current browser; a cross-origin one carries a
  // different value and is refused here even in the world where the cookie
  // somehow arrived. A missing header is tolerated (older clients, and the
  // header is not universally sent) because the signed token below is the
  // check that actually binds.
  //
  // `null` is tolerated for the same reason, and the reason is worth writing
  // down because reading it as hostile is what took the whole flow down once
  // (see `page()`): an OPAQUE origin is not a foreign origin. A browser
  // serializes it for a same-origin POST under several policies we do not
  // control — a referrer policy on the page, a sandboxed context, an embedded
  // webview's own rules — so refusing it refuses honest submissions, while
  // refusing nothing an attacker has. What stops a cross-site POST is
  // structural and unaffected: `dr_session` is `SameSite=Lax`, so the cookie
  // is not sent at all, and the consent token is signed, expiring and bound to
  // this uid, so it cannot be minted, read or replayed from another origin.
  // It is logged rather than silently accepted — if this line starts firing,
  // the page's own headers are the first thing to look at.
  const origin = request.headers.get("Origin");
  if (origin === "null") {
    log.info("oauth.consent_opaque_origin", { user_id: identity.id });
  } else if (origin && origin !== url.origin) {
    log.warn("oauth.consent_cross_origin", { user_id: identity.id, origin });
    return page(errorPage("invalid_request", "This form was submitted from another site."), 403);
  }

  const form = new URLSearchParams(await request.text().catch(() => ""));
  const claims = await verifyConsentToken(env, form.get("consent") || "", identity.id);
  if (!claims) {
    log.warn("oauth.consent_token_rejected", { user_id: identity.id });
    return page(
      errorPage(
        "invalid_request",
        "This consent form is no longer valid — it expired, or it belongs to a different sign-in. Start the connection again from your client.",
      ),
      400,
    );
  }

  // Re-checked after the signature, not instead of it. The allowlist can have
  // been narrowed since the screen was rendered, and a token minted before
  // that change must not outlive it.
  if (!redirectAllowed(claims.ru)) {
    log.warn("oauth.redirect_refused", {
      redirect_uri: claims.ru,
      client_id: claims.cid,
      reason: "not_allowlisted_at_post",
    });
    return page(
      errorPage("invalid_request", "That redirect_uri is not one this server will hand an authorization code to.", claims.ru),
      400,
    );
  }

  if ((form.get("decision") || "") !== "approve") {
    log.info("oauth.consent_denied", { user_id: identity.id, client_id: claims.cid });
    return bounceTo(claims.ru, {
      error: "access_denied",
      error_description: "The account holder declined to connect this client.",
      state: claims.st,
    });
  }

  const mintAuthCode = deps?.mintAuthCode || (await import("./oauth-store.js")).mintAuthCode;
  /** @type {{ code: string, jti: string, exp: number }} */
  let minted;
  try {
    minted = await mintAuthCode(env, {
      userId: claims.sub,
      clientId: claims.cid,
      redirectUri: claims.ru,
      codeChallenge: claims.cc,
      scope: claims.sc,
    });
  } catch (err) {
    log.error("oauth.code_mint_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message });
    // A server-side failure is reported over the redirect, not as a page: the
    // client is waiting on the callback and an RFC 6749 `server_error` is
    // something it can say out loud, whereas a rendered page reads to it as
    // an abandoned flow.
    return bounceTo(claims.ru, {
      error: "server_error",
      error_description: "Could not issue an authorization code on this server.",
      state: claims.st,
    });
  }

  log.info("oauth.code_issued", {
    user_id: identity.id,
    client_id: claims.cid,
    redirect_host: redirectHost(claims.ru),
    scope: claims.sc,
    jti: minted.jti,
  });
  return bounceTo(claims.ru, { code: minted.code, state: claims.st });
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** @param {unknown} s @returns {string} */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// The dark palette of public/connect/ — a reader who arrives here came from a
// connector dialog and is on their way back to one, and this is the SERVER
// tier. `.sl` is the measured slash spacing carried over from that page
// (scripts/slash-gap.mjs — the slash-spacing skill), not eyeballed.
const PAGE_CSS = `
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --border: #2b3140;
    --text: #e6e8ee; --muted: #98a0b3; --accent: #7aa2f7; --warn: #f2b25c;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--text); margin: 0; padding: 1.25rem 1rem 3rem; line-height: 1.55;
  }
  main { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: .9rem; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 1rem 1.15rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .3rem; }
  h2 { font-size: .95rem; margin: 0 0 .5rem; }
  p, li { font-size: .92rem; margin: .45rem 0; }
  ul { padding-left: 1.15rem; margin: .45rem 0; }
  .muted { color: var(--muted); }
  .small { font-size: .82rem; }
  a { color: var(--accent); }
  code { background: var(--panel-2); border-radius: 4px; padding: 0 .3rem; font-size: .85em; overflow-wrap: anywhere; }
  .sl { margin: 0 -.04em; }
  .wm { white-space: nowrap; }
  .who { font-size: 1.25rem; font-weight: 600; margin: 0 0 .1rem; overflow-wrap: anywhere; }
  .host {
    display: inline-block; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; padding: .2rem .55rem; font-weight: 600; letter-spacing: .01em;
  }
  .uri { display: block; margin-top: .4rem; word-break: break-all; font-size: .78rem; color: var(--muted); }
  .actions { display: flex; gap: .7rem; flex-wrap: wrap; margin: 0; }
  button {
    font: inherit; font-weight: 600; font-size: .95rem; border-radius: 10px;
    padding: .6rem 1.3rem; cursor: pointer; border: 1px solid var(--border);
  }
  button.primary { background: var(--accent); color: #0b0d11; border-color: var(--accent); }
  button.primary:hover { background: #93b5f9; }
  button.plain { background: var(--panel-2); color: var(--text); }
  button.plain:hover { background: #262c38; }
  .err { color: var(--warn); font-weight: 600; }
  .gbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: .55rem;
    background: #fff; color: #1f1f1f; text-decoration: none; border-radius: 24px;
    padding: .55rem 1.1rem; font-weight: 600; font-size: .92rem;
  }
`;

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="icon" href="/favicon.ico?v=4" sizes="48x48">
  <meta name="theme-color" content="#0f1115">
  <meta name="robots" content="noindex">
  <style>${PAGE_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/** The wordmark, with the measured slash. @param {"cure"|"rver"} tail */
function wm(tail) {
  return `<span class="wm">DeepResearch.<b>Se<span class="sl">/</span>${tail === "cure" ? "cure" : "rver"}</b></span>`;
}

/**
 * The consent screen.
 *
 * It has to say four things plainly, and they are the four the design called
 * out (docs/MCP-CONNECTOR.md §4): who is asking, WHERE the code is being sent
 * (the MCP spec requires the redirect host on screen so a user can see they
 * are authorizing claude.ai and not something that merely says so), what the
 * connection can reach, and what it costs. It is not a placeholder and it is
 * not marketing: this is the one moment where an account learns what a
 * connected agent may do before it does it.
 * @param {{ req: AuthorizeRequest, identity: Identity, consent: string, name: string, meta: ClientMetadata }} args
 * @returns {string}
 */
export function consentPage({ req, identity, consent, name, meta }) {
  const host = redirectHost(req.redirectUri);
  const scopes = req.scope.split(/\s+/).filter(Boolean);
  const offline = scopes.includes("offline_access");
  const who = esc(identity.email || identity.name || "your account");

  return shell(
    `Connect ${name} — DeepResearch.Se/rver`,
    `  <section>
    <h1>Connect a client</h1>
    <p class="who">${esc(name)}</p>
    <p class="muted small">is asking to connect to ${wm("rver")} as <b>${who}</b>.</p>
    ${
      meta.fetched && meta.name
        ? ""
        : `<p class="small muted">This name is the address the request came from — the client's own
    metadata document ${meta.fetched ? "did not give one" : "could not be read just now"}. Check it against
    the app you started this in.</p>`
    }
  </section>

  <section>
    <h2>Where the code goes</h2>
    <p>Approving sends an authorization code to <span class="host">${esc(host)}</span>.
    That host is who you are authorizing — not the name above it. If it is not the
    app you are connecting from, close this page.</p>
    <code class="uri">${esc(req.redirectUri)}</code>
  </section>

  <section>
    <h2>What connecting grants</h2>
    <ul>
      <li><b>The tools you have left switched on.</b> A connected client sees exactly the
      MCP tools your account exposes in <b>Settings → MCP server</b>, and nothing else.
      Switch one off later and this connection is narrowed on its next call, with nothing
      to re-issue.</li>
      <li><b>Your research quota.</b> Calls made through this connection spend the same
      quota the chat spends. <code>deep_research</code> is the one that costs; the
      literature tools are far cheaper.</li>
      <li><b>A row in the interaction log.</b> Every question that arrives this way is
      recorded in the same full-visibility interaction log every chat is — the question,
      the answer, and the research steps in between.</li>
      ${
        offline
          ? `<li><b>Staying connected.</b> The client asked for <code>offline_access</code>, so it
      can renew its own access without sending you back here — until you revoke it.</li>`
          : ""
      }
    </ul>
    <p class="small muted">Scopes requested: ${scopes.map((s) => `<code>${esc(s)}</code>`).join(" ")}</p>
  </section>

  <section>
    <h2>What it does not grant</h2>
    <p>This is <b>not a sign-in</b>. The connection reaches the MCP tool surface and
    nothing else: it cannot read your chats, projects, files, history or account, it
    cannot reach the admin interface, and it cannot change the settings above — those
    are edited here, signed in, which is somewhere it can never be.</p>
  </section>

  <section>
    <h2>Be clear-eyed about the tier</h2>
    <p>${wm("cure")} is the tier where the server is in no data path at all. This
    connection is ${wm("rver")}: the question reaches this server, goes upstream to the
    model and the search provider, and is recorded. If a research question must never
    rest on a server, it does not belong on this connection.
    <a href="/connect/">What crosses the wire</a>.</p>
  </section>

  <section>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="consent" value="${esc(consent)}">
      <div class="actions">
        <button class="primary" type="submit" name="decision" value="approve">Connect</button>
        <button class="plain" type="submit" name="decision" value="deny">Cancel</button>
      </div>
    </form>
    <p class="small muted">This page stays valid for ${Math.round(CONSENT_TTL_S / 60)} minutes. Cancelling
    sends the client an <code>access_denied</code> and nothing else.</p>
  </section>`,
  );
}

/**
 * The sign-in page for an unauthenticated arrival.
 *
 * Deliberately not a bare 401: the person is mid-flow in another app and needs
 * to know why a sign-in appeared. There is no automatic return trip today —
 * Google sign-in lands on the app — so the page says the one honest thing,
 * which is to start the connection again once signed in.
 * @param {URL} url
 * @returns {string}
 */
export function signInPage(url) {
  const host = redirectHost(url.searchParams.get("redirect_uri") || "");
  return shell(
    "Sign in to connect — DeepResearch.Se/rver",
    `  <section>
    <h1>Sign in to connect</h1>
    <p>A client${host ? ` at <span class="host">${esc(host)}</span>` : ""} is asking to connect to
    ${wm("rver")}, and this browser is not signed in — so there is no account to connect it to.</p>
    <p><a class="gbtn" href="/auth/google">Continue with Google</a></p>
    <p class="small muted">Signing in takes you to the app. Once you are there, start the
    connection again from the client that sent you here and this page will show the
    consent screen instead.</p>
  </section>`,
  );
}

/**
 * The rendered error. Used only where a redirect would be wrong (see the
 * header) — so it is also the page that shows the refused value, which is the
 * user's half of the diagnostic the log line is the operator's half of.
 * @param {string} error RFC 6749 code
 * @param {string} description
 * @param {string} [refused] the redirect_uri that was refused, when that is why
 * @returns {string}
 */
export function errorPage(error, description, refused) {
  return shell(
    "Could not connect — DeepResearch.Se/rver",
    `  <section>
    <h1>This connection request was refused</h1>
    <p class="err">${esc(error)}</p>
    <p>${esc(description)}</p>
    ${
      refused
        ? `<p class="small muted">The redirect address that was refused, exactly as it arrived:</p>
    <code class="uri">${esc(refused)}</code>
    <p class="small muted">If you are the client's author, this is the string to compare against
    your registered callback — a single character's difference is the commonest cause.</p>`
        : ""
    }
    <p class="small muted">Nothing was granted and no code was issued. Setting the server up
    from scratch: <a href="/connect/">connect an MCP client</a>.</p>
  </section>`,
  );
}
