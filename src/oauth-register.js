// @ts-check
// DYNAMIC CLIENT REGISTRATION (RFC 7591) — the registration path ChatGPT
// actually takes (docs/MCP-CONNECTOR.md §2a, F-20).
//
// WHY THIS EXISTS, AND WHY IT DID NOT BEFORE. The connector was built CIMD-only
// on the reading that both hosted clients "prefer CIMD and fall back to DCR"
// (src/oauth-metadata.js's header still describes that intent). The fallback
// was never built, and the authorization-server metadata deliberately
// advertised no `registration_endpoint` — so a client that does not implement
// Client ID Metadata Documents had nowhere to register and no way to obtain a
// `client_id` at all. That is the whole of the reported ChatGPT failure: the
// flow died at discovery, before consent, and surfaced to the user as the same
// unhelpful "couldn't connect" every other cause produces.
//
// CIMD IS STILL PREFERRED and is unchanged. This is strictly additive: a client
// that reads `client_id_metadata_document_supported` still uses it and never
// calls this endpoint. DCR is the compatibility path for clients that do not.
//
// NOTHING ACCUMULATES PER CONNECTION — the property CIMD was chosen for is
// kept. The objection to DCR recorded in oauth-metadata.js was a client table
// growing a row per connection, so the `client_id` issued here is a SIGNED
// STATELESS TOKEN (`orc1.`) carrying its own registration: the redirect URIs
// and the display name are IN the identifier, verified by HMAC when it comes
// back. There is no client table, no D1 row, and no cleanup — a registration is
// as durable as the signing key and as revocable as rotating it.
//
// WHAT A REGISTRATION IS NOT ALLOWED TO DECIDE. Registering does not widen
// where a code may be sent: every `redirect_uris` entry is checked against
// REDIRECT_ALLOWLIST here, at registration, and the authorization endpoint
// checks the redirect AGAIN at use. An open registration endpoint that accepted
// arbitrary redirects would be an open redirector with a signature on it, which
// is precisely the thing the allowlist exists to prevent. So an unknown client
// may register, and it may only ever be handed a code at a URL we already
// trusted — the same set CIMD clients are held to.
//
// Near-leaf module: the shared crypto primitives and the pure metadata leaf, so
// the OAuth endpoints stay unit-testable without a handler graph.

import { jsonResponse } from "./http.js";
import { DEFAULT_SCOPE, OAUTH_SCOPES, redirectAllowed } from "./oauth-metadata.js";
import { sealedToken, verifiedClaims } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */

/** Wire prefix of a dynamically registered client identifier. */
export const OAUTH_CLIENT_PREFIX = "orc1";

/**
 * The family's own HMAC namespace — the fence that keeps it unforgeable from
 * every other family under the single SESSION_SECRET (src/token-crypto.js).
 * Distinct from `oauthcode.` / `oauthaccess.` / `oauthrefresh.` and from every
 * family outside this subsystem.
 */
const CLIENT_NS = "oauthclient.";

/** RFC 7591 caps nothing; these bound what a stranger can make us sign. */
const MAX_BODY_BYTES = 16 * 1024;
/** Enough for the handful of callbacks a real client declares. */
const MAX_REDIRECT_URIS = 10;
/** The display name is shown on the consent screen, so it is bounded and plain. */
const MAX_NAME_CHARS = 120;

/**
 * Mint the stateless `client_id` for a registration.
 *
 * The identifier IS the registration: `orc1.<payload>.<sig>`, the same
 * three-segment wire shape as the token families, with the claims deliberately
 * readable — a client_id is public by definition and carries nothing private
 * (a redirect URI already on our allowlist, and the name the client chose for
 * itself).
 * @param {Env} env
 * @param {{ redirectUris: string[], name: string, now?: number }} args
 * @returns {Promise<{ clientId: string, issuedAt: number }>}
 */
export async function mintClientId(env, args) {
  const issuedAt = Math.floor((args.now ?? Date.now()) / 1000);
  const claims = { ru: args.redirectUris, nm: args.name, iat: issuedAt };
  const clientId = await sealedToken(env, CLIENT_NS, OAUTH_CLIENT_PREFIX, claims);
  return { clientId, issuedAt };
}

/**
 * Resolve a `client_id` that was issued by this endpoint.
 *
 * Null for anything that is not one of ours — a CIMD URL, a forged token, a
 * token re-labelled from another family. The caller decides what a null means;
 * for the authorization endpoint it means "not a registered client, try CIMD".
 * @param {Env} env
 * @param {string} clientId
 * @returns {Promise<{ redirectUris: string[], name: string, issuedAt: number } | null>}
 */
export async function resolveRegisteredClient(env, clientId) {
  if (typeof clientId !== "string") return null;
  const parts = clientId.split(".");
  if (parts.length !== 3 || parts[0] !== OAUTH_CLIENT_PREFIX) return null;
  const claims = await verifiedClaims(env, CLIENT_NS, parts[1], parts[2]);
  if (!claims) return null;
  const redirectUris = Array.isArray(claims.ru)
    ? claims.ru.filter((/** @type {unknown} */ u) => typeof u === "string")
    : [];
  if (!redirectUris.length) return null;
  return {
    redirectUris,
    name: typeof claims.nm === "string" ? claims.nm : "",
    issuedAt: typeof claims.iat === "number" ? claims.iat : 0,
  };
}

/**
 * Whether a string looks like a registered client id at all (prefix only).
 *
 * Used by the authorization endpoint to tell "this is a registration that
 * failed to verify" from "this is a CIMD URL", so the two produce different
 * errors. A `orc1.` that does not verify is `invalid_client`, not an
 * invitation to fetch it as a document.
 * @param {string} clientId
 * @returns {boolean}
 */
export function looksRegistered(clientId) {
  return typeof clientId === "string" && clientId.startsWith(`${OAUTH_CLIENT_PREFIX}.`);
}

/**
 * An RFC 7591 §3.2.2 error. Registration errors are a small closed set and are
 * returned at 400 — clients branch on `error`, and `invalid_redirect_uri` is
 * the one that tells an integrator exactly what to fix.
 * @param {string} error
 * @param {string} description
 * @param {number} [status]
 * @returns {Response}
 */
function registrationError(error, description, status = 400) {
  return jsonResponse({ error, error_description: description }, status, CORS_HEADERS);
}

/**
 * Registration is fetched by a browser-based connector dialog on some clients,
 * so the endpoint answers CORS. Everything it returns is public by
 * construction (a signed public identifier and the metadata the caller just
 * sent), and it takes no cookie and no ambient authority — so `*` is the
 * honest origin here, and credentials are never allowed.
 */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * `POST /oauth/register` — RFC 7591 dynamic client registration.
 *
 * Public and unauthenticated, like the discovery documents: a client that must
 * already be authorized to learn how to authorize cannot start. What keeps it
 * safe is not a credential but the allowlist — a registration can only ever
 * name redirect URIs we already trusted.
 * @param {Request} request
 * @param {Env} env
 * @param {{ info: (m: string, d?: any) => void, warn: (m: string, d?: any) => void, error: (m: string, d?: any) => void }} log
 * @returns {Promise<Response>}
 */
export async function handleOAuthRegister(request, env, log) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse(
      { error: "invalid_request", error_description: "The registration endpoint takes POST with a JSON body." },
      405,
      { allow: "POST, OPTIONS", ...CORS_HEADERS },
    );
  }

  /** @type {string} */
  let text;
  try {
    text = (await request.text()).slice(0, MAX_BODY_BYTES);
  } catch {
    return registrationError("invalid_client_metadata", "The request body could not be read.");
  }
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // RFC 7591 sends JSON, unlike the token endpoint's form encoding. Saying so
    // is worth a line: the two endpoints do not share a body parser, and an
    // integrator who form-encodes this one gets a parse failure with no clue.
    return registrationError("invalid_client_metadata", "The body must be JSON (this endpoint does not take a form-encoded body).");
  }
  if (!body || typeof body !== "object") {
    return registrationError("invalid_client_metadata", "The body must be a JSON object.");
  }

  const requested = Array.isArray(body.redirect_uris) ? body.redirect_uris : null;
  if (!requested || !requested.length) {
    return registrationError("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array.");
  }
  if (requested.length > MAX_REDIRECT_URIS) {
    return registrationError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`);
  }

  /** @type {string[]} */
  const redirectUris = [];
  for (const uri of requested) {
    if (typeof uri !== "string" || !redirectAllowed(uri)) {
      // The SAME logging rule the authorization endpoint follows, and for the
      // same reason: an exact-match failure is invisible from the outside and
      // is the commonest reported connector problem, so the refused string is
      // the only diagnostic anyone gets. A vendor that changed its callback
      // shows up here as a line naming the new URL — the fix is an allowlist
      // entry, which is data.
      log.warn("oauth.register_redirect_refused", {
        redirect_uri: typeof uri === "string" ? uri : String(uri),
        client_name: typeof body.client_name === "string" ? body.client_name.slice(0, MAX_NAME_CHARS) : "",
      });
      return registrationError(
        "invalid_redirect_uri",
        "That redirect_uri is not registerable with this server. Connectors are added from a supported client; " +
          "if a vendor has changed its callback URL, it has to be allowlisted here.",
      );
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }

  // A public client is the only shape this server issues. RFC 7591 lets the
  // server return values that differ from what was requested, and both clients
  // accept `none` — so an explicit `client_secret_post` request is normalized
  // rather than refused, which keeps a client that guessed wrong connectable.
  const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, MAX_NAME_CHARS) : "";
  const { clientId, issuedAt } = await mintClientId(env, { redirectUris, name });

  log.info("oauth.client_registered", {
    client_name: name,
    redirect_uris: redirectUris.length,
    redirect_host: safeHost(redirectUris[0]),
  });

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      // No `client_secret` and no `client_secret_expires_at`: a public client
      // has neither, and returning an empty one invites a client to send it.
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name || undefined,
      scope: DEFAULT_SCOPE,
      scopes_supported: [...OAUTH_SCOPES],
    },
    201,
    CORS_HEADERS,
  );
}

/**
 * The hostname of a URL for logging, never the full string with its query.
 * @param {string} u
 * @returns {string}
 */
function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}
