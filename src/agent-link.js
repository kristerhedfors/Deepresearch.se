// @ts-check
// Agent SHARE-LINK minting — the thin adapter between an AgentSpec and the
// EXISTING Se/rver-token subsystem. Creating an agent "as a link" mints a
// standard Se/rver token (src/server-token.js — one HS256 JWT), carrying the
// agent's upstream permissions + quota, metered by the same D1 `server_tokens`
// rows as every other Se/rver token (src/server-grants.js).
//
// This module writes NO new crypto and NO new meter, deliberately: it loads the
// agent spec from the committed source snapshot, maps it with
// `agentTokenGrantParams`, and calls `mintServerTokenGrant`. THE SERVER-TOKEN
// GUARANTEE therefore holds unchanged — the minted token grants access to the
// site's UPSTREAM APIs ONLY (web search / LLM completions on the server's keys),
// never any of Se/rver's own data, and it is never a login. It is admin-gated,
// exactly like the other shareable mint (POST /api/admin/server-token): tokens
// are administered FROM the admin interface, never opened by one.

import { agentTokenGrantParams, agentsFromSnapshot, findAgent } from "./agent-spec.js";
import { mintServerTokenGrant } from "./server-grants.js";
import { budgetExceeded409 } from "./grant-http.js";
import { jsonResponse } from "./http.js";
import { SNAPSHOT_PATH } from "../public/js/introspect-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * Load the agent registry (sdk/AGENTS.json) out of the committed source
 * snapshot, read back through the ASSETS binding — by construction the exact
 * definition this deploy runs, the same way introspection loads its snapshot.
 * Null (never a throw) when the binding or the artifact is unavailable.
 * @param {Env} env
 * @returns {Promise<any | null>}
 */
export async function loadAgentRegistry(env) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + SNAPSHOT_PATH));
    if (!res.ok) return null;
    return agentsFromSnapshot(await res.json());
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/agent-link — ADMIN. Body: { agent, ttlHours?, quotas? }.
 * Mints a shareable Se/rver token for the named agent: the agent's spec sets
 * the upstream services + default quota; optional `ttlHours` / `quotas`
 * override them at mint time ("go by default OR choose the credits"). Returns
 * the Se/rver-token view (incl. the JWT) plus a `link` that opens the Se/cure
 * tier carrying the token — the same `/cure?st=` mechanism the admin
 * server-token mint uses.
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log
 * @param {{ id: string | number }} identity the admin identity (only `id` is read)
 */
export async function handleAgentLink(request, env, url, log, identity) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const agentId = typeof body?.agent === "string" ? body.agent.trim() : "";
  if (!agentId) return jsonResponse({ error: "An `agent` id is required." }, 400);

  const reg = await loadAgentRegistry(env);
  if (!reg) return jsonResponse({ error: "Agent registry is unavailable in this deployment." }, 503);
  const agent = findAgent(reg, agentId);
  if (!agent) return jsonResponse({ error: `Unknown agent: ${agentId}` }, 404);

  const params = agentTokenGrantParams(agent);
  // Optional admin overrides — mint by the spec's defaults, or choose the
  // credits/TTL for this link. Overrides for unknown services are ignored by
  // mintServerTokenGrant (it filters to the closed vocabulary).
  const ttlHours =
    Number.isFinite(Number(body?.ttlHours)) && Number(body.ttlHours) > 0 ? Number(body.ttlHours) : params.ttlHours;
  const quotas =
    body?.quotas && typeof body.quotas === "object" ? { ...params.quotas, ...body.quotas } : params.quotas;

  const minted = await mintServerTokenGrant(env, log, {
    userId: String(identity.id),
    source: "agent",
    label: params.label,
    services: params.services,
    quotas,
    ttlHours,
  });
  if (!minted) return jsonResponse({ error: "Minting is unavailable (no database, or the insert failed)." }, 503);
  if (minted.error === "budget_exceeded") return budgetExceeded409(minted);

  const grant = /** @type {any} */ (minted);
  const link = url.origin + "/cure?st=" + encodeURIComponent(String(grant.token));
  log.info("agentlink.minted", { agent: agentId, jti: grant.jti, perms: grant.perms, by: String(identity.id) });
  return jsonResponse({ agent: agentId, ...grant, link });
}
