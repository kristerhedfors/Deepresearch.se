// @ts-check
// THE OAUTH DISCOVERY DOCUMENTS AND THE REDIRECT ALLOWLIST — the pure half of
// the connector authorization server (docs/MCP-CONNECTOR.md, F-20).
//
// WHY THIS EXISTS. An MCP key (src/mcp-key.js) is pasted into a terminal by a
// person, which is why it reaches Claude Code and never reaches a phone. Both
// hosted chat clients — Claude and ChatGPT — add a server by URL and run
// OAuth instead, so a connector cannot be handed a bearer key at all. This
// module is what lets those clients DISCOVER how to authenticate: the two
// well-known documents they fetch, and the allowlist their redirect has to
// match.
//
// ONE AUTHORIZATION SERVER, TWO CLIENTS. Claude and ChatGPT want the same
// OAuth 2.1: the same discovery documents, PKCE S256, a public client, CIMD
// registration with DCR as the fallback. What differs is one entry in the
// redirect allowlist each — which is why this is a LIST and not a constant,
// and why adding a third client is data rather than code.
//
// THE FALLBACK IS NOW BUILT (src/oauth-register.js). It was described here from
// the start and never implemented, which is what made this server unusable from
// any client that does not speak CIMD — see authorizationServerMetadata below.
//
// THE SPLIT OF HOSTS is deliberate and is the thing to preserve:
//   - the RESOURCE server is the MCP host (mcp.deepresearch.se) — it serves
//     the protected-resource metadata and the 401 that points at it;
//   - the AUTHORIZATION server is the APEX (deepresearch.se) — where the
//     account, Google sign-in and the session cookie already live, and where
//     a consent screen reads as this site rather than as a machine endpoint.
// Both clients resolve a cross-host authorization server with nothing special
// required; `authorization_servers` in the resource metadata is what points
// them at it.
//
// Pure leaf module: imports nothing, so src/mcp.js and the route table can
// use it without dragging a handler graph into anyone's tests.

/**
 * The scopes this resource offers. `research` is the one that means anything
 * (it is the whole MCP tool surface, narrowed further by the account's own
 * exposure config); `offline_access` exists because both clients append it to
 * obtain a refresh token when the authorization server advertises it.
 */
export const OAUTH_SCOPES = /** @type {const} */ (["research", "offline_access"]);

/** The scope a connection gets when the client asks for nothing in particular. */
export const DEFAULT_SCOPE = "research offline_access";

/**
 * Every redirect URI we will hand an authorization code to, as DATA.
 *
 * Exact strings for the hosted clients; a port-agnostic pattern for the
 * native one. RFC 8252 §7.3 requires the port to be ignored for the
 * `127.0.0.1` literal, and Claude Code declares `http://localhost/callback`
 * as well, so both forms are matched the same way.
 *
 * The ChatGPT entries are the reason this is a list. The second one is a
 * `backend-api` callback reported by integrators rather than stated in
 * OpenAI's own reference — kept because an exact-match failure is the
 * commonest reported ChatGPT connector problem and the cost of carrying a
 * spare entry is nothing.
 *
 * BOTH ChatGPT ENTRIES ARE LEGACY. OpenAI now issues a per-connector callback
 * that no exact string can cover — see `isChatgptConnectorRedirect`, which is
 * where a ChatGPT connector added today is actually matched. These stay for
 * connectors published before the change.
 * @type {string[]}
 */
export const REDIRECT_ALLOWLIST = [
  // Anthropic — claude.ai web, Claude Desktop, Claude mobile, Cowork all use
  // this one callback.
  "https://claude.ai/api/mcp/auth_callback",
  // OpenAI — ChatGPT's connector platform.
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback",
];

/**
 * Whether a redirect URI may receive an authorization code.
 *
 * Exact match against the allowlist, plus the loopback carve-out. Everything
 * else is refused — and the CALLER must log the value it refused (the reason
 * is in docs/MCP-CONNECTOR.md §4: a redirect mismatch surfaces to the user as
 * a generic "couldn't connect", so the refused string is the only diagnostic
 * anyone gets).
 * @param {string | null | undefined} uri
 * @returns {boolean}
 */
export function redirectAllowed(uri) {
  if (typeof uri !== "string" || !uri) return false;
  if (REDIRECT_ALLOWLIST.includes(uri)) return true;
  if (isChatgptConnectorRedirect(uri)) return true;
  return isLoopbackRedirect(uri);
}

/**
 * ChatGPT's CURRENT callback, which is PER CONNECTOR and so cannot be an exact
 * string: `https://chatgpt.com/connector/oauth/<callback_id>`.
 *
 * This is what the reported failure was. The allowlist held only
 * `…/connector_platform_oauth_redirect`, which OpenAI's own documentation now
 * describes as the LEGACY form kept working for apps that are already
 * published. A connector added today is issued a fresh `callback_id` and sends
 * a URL no entry could match, so `redirectAllowed` refused it, the
 * authorization endpoint rendered a refusal instead of redirecting, and the
 * user saw an unexplained "couldn't connect". The legacy entries stay — an
 * already-published connector keeps using them.
 *
 * Matched by SHAPE, and narrowly. A pattern arm is a bigger promise than an
 * exact string, so it is bounded the same way `isLoopbackRedirect` is: the
 * origin must be exactly `https://chatgpt.com` (parsed, so no
 * `chatgpt.com.evil.test` and no userinfo trick), the path must be
 * `/connector/oauth/` plus EXACTLY ONE more segment, that segment is restricted
 * to an id-shaped charset, and any query or fragment disqualifies it. `URL`
 * normalizes `..` before we look, so a traversal cannot smuggle a second
 * segment past the count.
 * @param {string} uri
 * @returns {boolean}
 */
export function isChatgptConnectorRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.origin !== "https://chatgpt.com") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  const rest = url.pathname.startsWith("/connector/oauth/")
    ? url.pathname.slice("/connector/oauth/".length)
    : null;
  if (!rest) return false;
  return /^[A-Za-z0-9_-]{1,128}$/.test(rest);
}

/**
 * The RFC 8252 loopback form, matched with the port ignored. Native clients
 * bind an ephemeral port per session, so the port cannot be part of the
 * comparison; the host and path still are.
 * @param {string} uri
 * @returns {boolean}
 */
export function isLoopbackRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return false;
  if (url.search || url.hash) return false;
  return url.pathname === "/callback";
}

/**
 * RFC 9728 protected-resource metadata — served BY THE MCP HOST at
 * /.well-known/oauth-protected-resource.
 *
 * `resource` must equal the URL the user typed into the client's dialog,
 * character for character. That is the whole reason the advertised endpoint
 * is one canonical form (the bare origin — src/mcp-api.js `mcpEndpointUrl`):
 * a second advertised spelling would be a second `resource` value, and the
 * client would reject the one it did not type.
 *
 * `authorization_servers` may list several; both clients take the FIRST and
 * do not fall back, so this returns exactly one.
 * @param {string} resource the MCP endpoint URL (an origin, no trailing slash)
 * @param {string} issuer the authorization server's issuer URL
 */
export function protectedResourceMetadata(resource, issuer) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    // Origin-relative for the same reason as the metadata URL above: on a
    // preview or local origin the resource carries a path, and appending to
    // it points at a page that does not exist.
    resource_documentation: `${originOf(resource)}/connect/`,
  };
}

/**
 * RFC 8414 authorization-server metadata — served BY THE APEX at
 * /.well-known/oauth-authorization-server.
 *
 * TWO FIELDS MAKE A CLIENT PREFER CIMD, and both must be present or it falls
 * back to Dynamic Client Registration:
 *   - `client_id_metadata_document_supported: true`
 *   - `"none"` in `token_endpoint_auth_methods_supported`
 * CIMD is still what we want: the `client_id` is an HTTPS URL we fetch and
 * validate, so there is no client table.
 *
 * BOTH ARE ADVERTISED NOW, and the reason is a reported failure. This document
 * offered CIMD *only* — no `registration_endpoint` — on the reading that both
 * hosted clients fall back to it. A client that does not implement CIMD
 * therefore had nowhere to register and could not obtain a `client_id` at all;
 * the flow died at discovery, before any consent screen, and reached the user
 * as the same generic "couldn't connect" every other cause produces. That was
 * the ChatGPT connector failure.
 *
 * The objection to DCR recorded here — a client row per connection — is
 * answered by src/oauth-register.js issuing a SIGNED STATELESS `client_id`
 * instead of storing one, so nothing accumulates and the property CIMD was
 * chosen for survives. A CIMD-capable client still never calls `/oauth/register`.
 *
 * `code_challenge_methods_supported` is required to advertise S256 by the MCP
 * authorization spec so a client can verify support before starting.
 * @param {string} issuer the authorization server's origin (no trailing slash)
 */
export function authorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: [...OAUTH_SCOPES],
    service_documentation: "https://mcp.deepresearch.se/connect/",
  };
}

/**
 * The `WWW-Authenticate` value that starts the whole flow.
 *
 * It MUST ride on a 401 — a client ignores the header on a 200 — and the
 * `resource_metadata` pointer is what saves the client from probing
 * well-known paths it may not find. Without either, the client never learns
 * where the authorization server is and reports "couldn't reach the MCP
 * server", which sends its user hunting for a network problem that isn't
 * there.
 * @param {string} resourceMetadataUrl absolute URL of the protected-resource document
 * @param {string} [scope] scopes to request; omitted means "whatever the metadata says"
 * @returns {string}
 */
export function wwwAuthenticateValue(resourceMetadataUrl, scope) {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (scope) parts.push(`scope="${scope}"`);
  return parts.join(", ");
}

/**
 * Where the protected-resource document lives for a given MCP endpoint.
 *
 * Built from the resource's ORIGIN, not by appending to the resource string.
 * On the dedicated host the two are the same thing (the resource IS an
 * origin), which is why appending looked right — but anywhere else the
 * resource carries a `/mcp` path, and appending produced
 * `…/mcp/.well-known/oauth-protected-resource`, a 404. A well-known URI is
 * defined by RFC 8615 as origin-relative; a client that follows the pointer
 * finds nothing, and the connection fails at the first step with no clue why.
 *
 * Found by probing a local Worker, not by a unit test: both were written from
 * the same wrong assumption, so they agreed with each other.
 * @param {string} resource
 * @returns {string}
 */
export function resourceMetadataUrl(resource) {
  return `${originOf(resource)}/.well-known/oauth-protected-resource${pathOf(resource)}`;
}

/**
 * The resource's path, INSERTED after the well-known segment rather than
 * appended to the resource — RFC 9728 §3.1's form, and the fix for the second
 * URL a user can legitimately type.
 *
 * OpenAI's setup instructions tell people to enter the endpoint WITH its `/mcp`
 * path (which is why src/mcp-api.js hands ChatGPT that spelling), while
 * Claude and everything else get the bare origin. Both are real, and `resource`
 * has to match the one that was typed character for character. So the two
 * spellings are two documents: the origin form keeps its old URL exactly, and
 * a resource carrying a path gets `…/oauth-protected-resource/mcp`.
 *
 * The empty string for a bare origin is what keeps the common case byte-for-byte
 * unchanged. A trailing slash is not a path worth inserting either — it would
 * produce a second URL for the same resource.
 * @param {string} u
 * @returns {string}
 */
function pathOf(u) {
  try {
    const p = new URL(u).pathname;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

/**
 * The origin of a URL string, falling back to the input when it will not
 * parse — a malformed resource is a bug worth seeing in the document rather
 * than a thrown request.
 * @param {string} u
 * @returns {string}
 */
function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
}

/**
 * The issuer to advertise, derived from where the request arrived.
 *
 * Production: the MCP host's parent (mcp.deepresearch.se → deepresearch.se),
 * because the authorization server is the apex. A preview or local run has no
 * such split, so it issues from its own origin and the whole flow stays on
 * one host — which is what makes this testable without a second deployment.
 * @param {URL} url the incoming request URL
 * @returns {string}
 */
export function issuerFor(url) {
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (labels[0] === "mcp" && labels.length > 2) {
    return `${url.protocol}//${labels.slice(1).join(".")}`;
  }
  return url.origin;
}
