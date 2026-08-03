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
  return isLoopbackRedirect(uri);
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
    resource_documentation: `${resource}/connect/`,
  };
}

/**
 * RFC 8414 authorization-server metadata — served BY THE APEX at
 * /.well-known/oauth-authorization-server.
 *
 * TWO FIELDS DECIDE HOW A CLIENT REGISTERS, and both must be present or the
 * client silently falls back to Dynamic Client Registration:
 *   - `client_id_metadata_document_supported: true`
 *   - `"none"` in `token_endpoint_auth_methods_supported`
 * CIMD is what we want: the `client_id` is an HTTPS URL we fetch and
 * validate, so there is no client table and nothing accumulates per
 * connection. DCR's documented failure mode is the opposite — a fresh
 * registered client on every connection — which is why no
 * `registration_endpoint` is advertised here.
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
 * @param {string} resource
 * @returns {string}
 */
export function resourceMetadataUrl(resource) {
  return `${resource}/.well-known/oauth-protected-resource`;
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
