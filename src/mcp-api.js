// @ts-check
// The MCP CONTROL surface: the account-facing half of the MCP server.
//
// Two jobs, both about the seam between an external agent and this account:
//
//   1. KEY RESOLUTION (resolveMcpKeyIdentity) — turn an `Authorization:
//      Bearer mck1.…` header into the identity it acts for. src/index.js
//      calls this for the MCP endpoint ONLY, above the identity gate; nothing
//      else in the router consults it, which is the structural half of the
//      scope argument in src/mcp-key.js (the other half being that
//      src/auth.js's identify() cannot read an `mck1.` bearer at all, so a
//      key can never reach /admin, /api/admin/*, or any data-bearing route).
//   2. THE SETTINGS ENDPOINTS — GET/PUT /api/mcp/config and POST/DELETE
//      /api/mcp/key, behind the ordinary identity gate. These are what
//      Settings → "MCP server" reads and writes: which tools this account
//      exposes, the research defaults, and the one live key.
//
// The config lives in `users.settings_json` under an `mcp` key rather than in
// a table of its own — it is per-account preference of exactly the kind that
// column already holds, and src/settings.js's mergeStoredSettings was built
// for precisely this (knobs replace, everything else in the column survives).
// The key's TOKEN is never stored: mint returns it once and the row keeps only
// the `jti` verification must match, plus a six-character hint for the UI.

import { getUserById } from "./accounts.js";
import { getDb } from "./db.js";
import { jsonResponse, readJsonBody } from "./http.js";
import { mergeStoredSettings } from "./settings.js";
import { MCP_TOOL_CATALOG, applyConfigPatch, isMcpHost, normalizeConfigPatch, parseMcpConfig } from "./mcp-config.js";
import { MCP_KEY_TTL_S, bearerToken, looksLikeMcpKey, mintMcpKey, verifyMcpKey } from "./mcp-key.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
// The ROUTER's identity shape (src/auth.js), not src/settings.js's looser
// mirror of it: resolveMcpKeyIdentity below PRODUCES an identity the router
// hands on, so it has to satisfy exactly what identify() returns.
/** @typedef {import('./auth.js').Identity} Identity */
/** @typedef {import('./mcp-config.js').McpConfig} McpConfig */

// ---------------------------------------------------------------------------
// Key resolution (called from the router, above the identity gate)
// ---------------------------------------------------------------------------

/**
 * Resolve an MCP key bearer into the account it acts for.
 *
 * Three outcomes, deliberately distinct so the router can tell "no key here,
 * carry on to the normal gate" from "a key was presented and it is not
 * usable" — the second must not silently fall through to a 401 login page,
 * because that reads to an MCP client as a transport failure rather than as
 * "your key was revoked".
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<null | { identity: Identity, config: McpConfig } | { error: string }>}
 *   null when no MCP key is presented at all.
 */
export async function resolveMcpKeyIdentity(request, env) {
  const token = bearerToken(request);
  if (!looksLikeMcpKey(token)) return null;

  const claims = await verifyMcpKey(env, token);
  if (!claims) return { error: "The MCP key is invalid or has expired. Mint a new one in Settings → MCP server." };

  const user = await getUserById(env, Number(claims.sub)).catch(() => null);
  if (!user) return { error: "The account this MCP key belongs to no longer exists." };
  // Only ACTIVE accounts: a pending account has not been approved yet and a
  // disabled one has been switched off, and neither should keep a machine
  // credential working. (The interactive gate parks pending users on a waiting
  // page; there is no equivalent for a tool call, so the key simply stops.)
  if (user.status !== "active") {
    return { error: "The account this MCP key belongs to is not active." };
  }

  const config = parseMcpConfig(user.settings_json);
  // The revocation check. The token is self-contained and unforgeable, but the
  // account's record is what says whether THIS issue is still the live one —
  // rotating or revoking rewrites the jti and every outstanding copy dies.
  if (!config.key || config.key.jti !== claims.jti) {
    return { error: "This MCP key has been revoked. Mint a new one in Settings → MCP server." };
  }
  if (!config.enabled) {
    return { error: "The MCP server is switched off for this account (Settings → MCP server)." };
  }

  /** @type {Identity} */
  const identity = {
    id: String(user.id),
    role: user.role === "admin" ? "admin" : "user",
    email: user.email ?? null,
    name: user.name || user.email || "",
    user,
  };
  return { identity, config };
}

// ---------------------------------------------------------------------------
// The endpoint an external client is pointed at
// ---------------------------------------------------------------------------

/**
 * The MCP endpoint URL to show an account (and to paste into `claude mcp
 * add`). Production runs a dedicated `mcp.` host, so that is what gets shown;
 * a deploy without one — a workers.dev preview, a fork on a bare hostname, a
 * local run — shows its own origin instead, so the setup instructions are
 * always something that actually works from where the reader is standing.
 *
 * ON THE DEDICATED HOST THE ADVERTISED URL IS THE BARE ORIGIN — no `/mcp`
 * tail (owner directive, 2026-08-03). Both forms have always answered
 * (isMcpEndpoint accepts either there), so this is a change of what we TELL
 * people, not of what works. Three reasons the bare origin is the better
 * thing to advertise:
 *   - It is the shortest URL that cannot be got wrong. The commonest MCP
 *     setup failure is a client that appends its own path to the configured
 *     URL, or one that doesn't; on this host neither can miss.
 *   - The host exists for exactly one service, so a path adds nothing. Saying
 *     `mcp.deepresearch.se/mcp` states it twice.
 *   - A future claude.ai web connector (docs/MCP-CONNECTOR.md) needs the
 *     protected-resource metadata's `resource` field to match the URL THE
 *     USER TYPED, character for character. Advertising one canonical form —
 *     the one a person types from memory — is what makes that matchable.
 * A preview or local origin keeps the path: there the bare origin is the app,
 * and only `/mcp` is the endpoint. The test is the HOST, not the deploy: a
 * preview that happens to be served on an `mcp.` name gets the bare origin
 * too, which is right — `isMcpEndpoint` accepts it wherever the first label
 * is `mcp`, so the advertised form and the accepted form cannot diverge.
 * @param {URL} url the incoming request URL
 * @returns {string}
 */
export function mcpEndpointUrl(url) {
  const host = url.hostname.toLowerCase();
  if (isMcpHost(host)) return url.origin;
  // A dedicated subdomain only exists for a real custom domain; the preview
  // and local hosts get their own origin. `.workers.dev` previews are the
  // common case and are matched explicitly rather than guessed at.
  const isPlainHost = !host.includes("localhost") && !host.endsWith(".workers.dev") && host.includes(".");
  if (url.protocol === "https:" && isPlainHost) {
    return `https://mcp.${host.replace(/^www\./, "")}`;
  }
  return `${url.origin}/mcp`;
}

// ---------------------------------------------------------------------------
// GET/PUT /api/mcp/config, POST/DELETE /api/mcp/key
// ---------------------------------------------------------------------------

/**
 * The payload the Settings screen renders from: the account's effective
 * config, the catalog it switches (so the client keeps no second copy of the
 * tool list), the endpoint to connect to, and a ready-to-paste Claude Code
 * command. The live key's TOKEN is deliberately absent — it exists in the
 * mint response and nowhere else.
 * @param {URL} url
 * @param {McpConfig} config
 */
function configPayload(url, config) {
  const endpoint = mcpEndpointUrl(url);
  return {
    endpoint,
    catalog: MCP_TOOL_CATALOG,
    config: { ...config, key: config.key },
    // The exact command, minus the secret: the UI splices the token in at
    // mint time and shows a redacted form afterwards.
    connect_command: `claude mcp add --transport http deepresearch ${endpoint} --header "Authorization: Bearer <your-key>"`,
    key_ttl_days: Math.round(MCP_KEY_TTL_S / 86400),
  };
}

/**
 * Persist a config onto the account's settings row. Uses the same merge
 * src/settings.js writes through, so a knob write and an MCP write never
 * clobber each other's half of the column.
 * @param {Env} env
 * @param {Identity} identity
 * @param {McpConfig} config
 */
async function saveMcpConfig(env, identity, config) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const merged = mergeStoredSettings(identity.user?.settings_json, { mcp: config });
  const json = JSON.stringify(merged);
  await db.prepare("UPDATE users SET settings_json = ? WHERE id = ?").bind(json, identity.user?.id).run();
  if (identity.user) identity.user.settings_json = json;
}

/**
 * Guard shared by all four handlers: MCP configuration hangs off a D1 user
 * row, which the break-glass operator identity does not have.
 * @param {Identity} identity
 * @returns {Response | null}
 */
function requireAccount(identity) {
  if (!identity?.user) {
    return jsonResponse({ error: "The MCP server settings need a signed-in account (not break-glass)." }, 403);
  }
  return null;
}

/**
 * GET /api/mcp/config
 * @param {URL} url
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMcpConfigGet(url, identity) {
  const denied = requireAccount(identity);
  if (denied) return denied;
  return jsonResponse(configPayload(url, parseMcpConfig(identity.user?.settings_json)));
}

/**
 * PUT /api/mcp/config — partial update of the exposure config.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMcpConfigPut(request, env, url, log, identity) {
  const denied = requireAccount(identity);
  if (denied) return denied;
  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const normalized = normalizeConfigPatch(body);
  if (!normalized.ok) return jsonResponse({ error: normalized.error }, 400);

  const config = applyConfigPatch(parseMcpConfig(identity.user?.settings_json), normalized.patch);
  await saveMcpConfig(env, identity, config);
  log.info("mcp.config_updated", {
    user_id: identity.id,
    enabled: config.enabled,
    exposed: Object.entries(config.tools)
      .filter(([, on]) => on)
      .map(([id]) => id),
  });
  return jsonResponse(configPayload(url, config));
}

/**
 * POST /api/mcp/key — mint (or rotate) this account's MCP key. There is at
 * most ONE live key per account: minting again replaces the previous issue,
 * which is what makes "I pasted it somewhere I shouldn't have" a one-tap fix.
 * The token comes back exactly once.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMcpKeyMint(request, env, url, log, identity) {
  const denied = requireAccount(identity);
  if (denied) return denied;
  /** @type {any} */
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {
    body = {}; // the label is optional, so an empty or unparseable body is fine
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";

  /** @type {{ token: string, jti: string, exp: number, hint: string }} */
  let minted;
  try {
    minted = await mintMcpKey(env, String(identity.user?.id));
  } catch (err) {
    log.error("mcp.key_mint_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message });
    return jsonResponse({ error: "Could not mint an MCP key on this server." }, 503);
  }

  const config = parseMcpConfig(identity.user?.settings_json);
  const rotated = !!config.key;
  config.key = {
    jti: minted.jti,
    hint: minted.hint,
    label: label || "MCP client",
    created_at: Date.now(),
    exp: minted.exp,
  };
  await saveMcpConfig(env, identity, config);
  log.info("mcp.key_minted", { user_id: identity.id, rotated, label: config.key.label });

  const payload = configPayload(url, config);
  return jsonResponse({
    ...payload,
    rotated,
    // Shown once. Everything else about this key is re-readable; this is not.
    token: minted.token,
    connect_command: payload.connect_command.replace("<your-key>", minted.token),
  });
}

/**
 * DELETE /api/mcp/key — revoke the live key. Immediate: the next call from
 * any copy of it fails the jti check in resolveMcpKeyIdentity.
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMcpKeyRevoke(env, url, log, identity) {
  const denied = requireAccount(identity);
  if (denied) return denied;
  const config = parseMcpConfig(identity.user?.settings_json);
  if (!config.key) return jsonResponse(configPayload(url, config));
  const hint = config.key.hint;
  config.key = null;
  await saveMcpConfig(env, identity, config);
  log.info("mcp.key_revoked", { user_id: identity.id, hint });
  return jsonResponse(configPayload(url, config));
}
