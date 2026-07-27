// @ts-check
// The MCP KEY — the credential an external MCP client (Claude Code, Cursor,
// any agent SDK) presents to reach POST /mcp.
//
// WHY A FOURTH TOKEN FAMILY. `/mcp` has always sat behind the identity gate
// (src/index.js routes it after `identify`), which means a session cookie or
// the break-glass Basic secrets. Neither is something an MCP client can carry:
// Claude Code speaks Streamable HTTP with a static `Authorization` header and
// has no cookie jar, and handing an operator the break-glass password to wire
// up a laptop would be a strictly worse trade. So an account mints one bearer
// key, pastes it into `claude mcp add --header`, and revokes it from the same
// screen when the laptop is gone.
//
// ══════════════════════════════════════════════════════════════════════════
// SCOPE — the property that makes this safe (and the reason it is NOT the
// Se/rver token):
//
//   1. AN MCP KEY IS NOT A LOGIN. It is verified in exactly one place —
//      src/mcp-api.js's resolveMcpKeyIdentity — which src/index.js consults
//      ONLY for the MCP endpoint, above the identity gate and below nothing
//      else. src/auth.js's identify() cannot be satisfied by one in any
//      position: it reads a `Basic ` header and the `dr_session` cookie, and
//      an `mck1.` bearer is neither. So /admin, /api/admin/*, and every
//      data-bearing /api/* route are out of reach by construction — the same
//      structural argument the Se/rver token makes, pinned the same way by a
//      unit test (src/mcp-key.test.js, src/mcp-api.test.js).
//   2. WHAT IT REACHES IS THE ACCOUNT'S OWN CHOICE. The key authorizes the
//      MCP tool surface, and WHICH tools that surface exposes is per-account
//      configuration (src/mcp-config.js) the holder of the key cannot change
//      — the config is edited from the signed-in Settings screen, which a key
//      can never reach (property 1). Narrowing the exposure narrows every
//      live key at once, with no re-issue.
//   3. IT IS REVOCABLE WITHOUT A SCHEMA. The account stores the live key's
//      `jti` in its settings row; verification requires the token's jti to
//      match. Rotate or revoke rewrites/clears that one field, which kills
//      the outstanding token immediately — the same "token fixed, the record
//      governs" split the grant families use.
//
// This is deliberately NOT the Se/rver token (src/server-token.js). That
// family carries THE SERVER-TOKEN GUARANTEE — upstream services only, never
// anything Se/rver stores — because it exists to protect Se/cure, whose
// posture is pass-through. An MCP key is the opposite situation: it acts for
// a signed-in Se/rver account, inside the trust boundary (CLAUDE.md
// invariant 4, 2026-07-24 owner directive), running that account's research
// on that account's quota. Reusing the Se/rver token here would have meant
// widening its closed permission vocabulary to name a data surface, which is
// exactly what that guarantee forbids. Separate credential, separate module.
// ══════════════════════════════════════════════════════════════════════════
//
// Wire format: `mck1.<payload>.<sig>` — the shape the non-JWT families in this
// codebase share (`wsk1`, `prg1`/`prx1`): one dot-free base64url payload
// segment, a hex HMAC-SHA-256 tag, signed under this family's own namespace
// (`mcpkey.`) with the site's sole HMAC key, SESSION_SECRET. Family separation
// under that one key is structural and pinned by tests: the namespace differs
// from every other family's, and the Se/rver token's JWT signing input always
// contains a dot (a canonical header segment) which this family's never can.
//
// Leaf module: imports only the shared crypto primitives (src/token-crypto.js),
// so importing it pulls in no handler graph — which is what lets src/mcp.js
// stay unit-testable without the pipeline (the file-layout rule).

import { b64url, b64urlDecode, safeEqual, sign } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */

/** The wire prefix — the first dot-separated segment of every MCP key. */
export const MCP_KEY_PREFIX = "mck1";
/** This family's HMAC namespace (see the family-separation note above). */
const NS = "mcpkey.";
/** Default lifetime: one year, matching the session cookie's own TTL. */
export const MCP_KEY_TTL_S = 365 * 24 * 3600;

/**
 * The claims an MCP key carries. Deliberately minimal: WHO it acts for
 * (`sub`), WHICH issue it is (`jti` — the revocation handle stored on the
 * account), and WHEN it dies (`exp`). Everything else — which tools it may
 * call, what the research defaults are — is per-account configuration read at
 * call time (src/mcp-config.js), never baked into the token, so narrowing the
 * exposure takes effect on the next call rather than on the next re-issue.
 * @typedef {Object} McpKeyClaims
 * @property {number} v format version (1)
 * @property {string} sub the owning user-row id, as a string
 * @property {string} jti this issue's id — must match the account's stored one
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/**
 * A fresh, unguessable issue id (the revocation handle). 16 random bytes,
 * base64url — the same generator shape the other token families use.
 * @returns {string}
 */
export function newJti() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Mint an MCP key for one account.
 * @param {Env} env
 * @param {string | number} userId the owning user-row id
 * @param {{ jti?: string, ttlS?: number, now?: number }} [opts]
 * @returns {Promise<{ token: string, jti: string, exp: number, hint: string }>}
 */
export async function mintMcpKey(env, userId, opts = {}) {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const jti = opts.jti || newJti();
  const ttl = Number.isFinite(opts.ttlS) ? Math.max(60, Number(opts.ttlS)) : MCP_KEY_TTL_S;
  /** @type {McpKeyClaims} */
  const claims = { v: 1, sub: String(userId), jti, iat: now, exp: now + ttl };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await sign(env, NS, payload);
  const token = `${MCP_KEY_PREFIX}.${payload}.${sig}`;
  return { token, jti, exp: claims.exp, hint: keyHint(token) };
}

/**
 * Verify an MCP key's signature, format and expiry. Returns the claims, or
 * null for anything that does not verify — a caller can't tell WHY, on
 * purpose. Note this checks the TOKEN only: whether the issue is still the
 * account's live one (the revocation check) is the caller's job, because it
 * needs the account row (src/mcp-api.js resolveMcpKeyIdentity).
 * @param {Env} env
 * @param {string | null | undefined} token
 * @param {number} [nowMs]
 * @returns {Promise<McpKeyClaims | null>}
 */
export async function verifyMcpKey(env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payload, sig] = parts;
  if (prefix !== MCP_KEY_PREFIX || !payload || !sig) return null;
  /** @type {string} */
  let expected;
  try {
    expected = await sign(env, NS, payload);
  } catch {
    return null; // no SESSION_SECRET — fail closed, like every other family
  }
  if (!safeEqual(sig, expected)) return null;
  /** @type {any} */
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  if (claims.v !== 1) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.jti !== "string" || !claims.jti) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  return /** @type {McpKeyClaims} */ (claims);
}

/**
 * The bearer token on a request, or null. Accepts only `Authorization:
 * Bearer <token>` — the one form every MCP client's `--header` flag can
 * produce. Deliberately NOT a query parameter: an MCP endpoint URL gets
 * pasted into configs, screen-shared and logged, and a key in the path
 * would ride along.
 * @param {Request} request
 * @returns {string | null}
 */
export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Whether a string even LOOKS like an MCP key — a cheap prefix test so the
 * router can tell "this caller is presenting an MCP key" from "this caller
 * presented some other bearer" without a crypto round-trip.
 * @param {string | null | undefined} token
 * @returns {boolean}
 */
export function looksLikeMcpKey(token) {
  return typeof token === "string" && token.startsWith(MCP_KEY_PREFIX + ".");
}

/**
 * A short, non-secret tail used to LABEL a key in the UI ("…4f2a9c") so an
 * account can tell which of its pasted copies is live. Six characters of an
 * HMAC-signed value are not enough to reconstruct anything, and the value is
 * only ever shown to the account that minted it.
 * @param {string} token
 * @returns {string}
 */
export function keyHint(token) {
  return typeof token === "string" ? token.slice(-6) : "";
}
