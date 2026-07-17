// @ts-check
// The grant subsystems' SHARED pure presentation helpers — the HTTP-facing
// fragments that were byte-identical between the two bounded server-touching
// exceptions: src/websearch.js (the temporary web-search grant) and
// src/proxy.js (the secure-research-space bundle, which was born by
// generalizing it). A leaf next to token-crypto.js: imports only the
// jsonResponse helper — no D1, config, or provider code — so importing it
// pulls neither subsystem into the other. Each subsystem deliberately keeps
// its OWN mint/meter/adjust logic (different tables, different claims — see
// token-crypto.js's namespace note); only the pure response/clamp layer that
// must stay in lockstep lives here.

import { jsonResponse } from "./http.js";

export const QUERY_MAX = 400; // bound the web-search query the server will run
export const GRANTS_LIST_MAX = 200; // admin list cap
// Modest, fixed server-side depth for a granted search — the DRC session has no
// time-budget slider, and this shares the server's Exa budget across all users.
export const GRANT_DEPTH = { numResults: 6, type: "auto" };

/**
 * Positive-integer clamp for config-sourced quota/TTL values — the defaults
 * resolvers of the grant subsystems all read admin config the same way: a
 * finite positive number floors to an int, anything else takes the default.
 * @param {number} v @param {number} d @returns {number}
 */
export const posInt = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

/**
 * The 409 a mint or quota increase gets when it would push the global
 * outstanding-remaining total past the admin-configured budget ceiling.
 * @param {Record<string, any> & { outstanding?: number, budget?: number }} result the budget_exceeded error result
 * @returns {Response}
 */
export function budgetExceeded409(result) {
  return jsonResponse(
    { error: `Global budget of ${result.budget} would be exceeded (${result.outstanding} already outstanding).` },
    409,
  );
}

/**
 * The adjust-result → Response ladder shared by the self-service and admin
 * PATCH quota-adjust endpoints of both subsystems. The only wording that
 * differs between callers is the not_found message ("No such grant of yours."
 * for the owner-scoped self-service path, "No such grant." for the admin).
 * @param {(Record<string, any> & { error?: string }) | null} adjusted the adjust function's result
 * @param {string} notFoundMsg
 * @returns {Response}
 */
export function adjustResultResponse(adjusted, notFoundMsg) {
  if (!adjusted) return jsonResponse({ error: "Quota adjustment unavailable." }, 503);
  if (adjusted.error === "not_found") return jsonResponse({ error: notFoundMsg }, 404);
  if (adjusted.error === "bad_request") return jsonResponse({ error: "quota or delta must be a number." }, 400);
  if (adjusted.error === "budget_exceeded") return budgetExceeded409(adjusted);
  return jsonResponse(adjusted);
}

/**
 * The quota-patch clamp arithmetic — the set (`quota`) / relative (`delta`) /
 * pause (clamp at 0) semantics both adjust functions share. Pure: the caller
 * owns the row read, the budget check, and the UPDATE.
 * @param {number} current the row's current quota
 * @param {{ quota?: number|null, delta?: number|null } | null | undefined} patch
 * @returns {{ clamped: number, error?: undefined } | { error: "bad_request", clamped?: undefined }}
 */
export function resolveQuotaPatch(current, patch) {
  if (!patch || (patch.quota == null && patch.delta == null)) return { error: "bad_request" };
  const next = patch.quota != null ? Math.floor(Number(patch.quota)) : current + Math.floor(Number(patch.delta));
  if (!Number.isFinite(next)) return { error: "bad_request" };
  return { clamped: Math.max(0, next) };
}

/**
 * The empty/failed granted-web-search response — sent after the refund, so a
 * search that returned nothing usable never burns quota.
 * @param {{ content?: string } | null} result
 * @returns {Response}
 */
export function emptyWebResultResponse(result) {
  return jsonResponse({ content: result?.content || "", items: [], sources: [], resultCount: 0, remaining: null });
}

/**
 * The successful granted-web-search response: the Exa result projected to the
 * fields the Se/cure client consumes, plus the grant's remaining quota.
 * @param {{ content: string, items: any[], sources: any[], resultCount: number }} result
 * @param {number|null} remaining
 * @returns {Response}
 */
export function webResultResponse(result, remaining) {
  return jsonResponse({
    content: result.content,
    items: result.items,
    sources: result.sources,
    resultCount: result.resultCount,
    remaining,
  });
}

/**
 * Reads the `token` field of a JSON POST body — the shape every public
 * token-bearing endpoint (status, exchange) accepts. Returns "" for a missing
 * or malformed body; the caller owns the 400.
 * @param {Request} request
 * @returns {Promise<string>}
 */
export async function readTokenBody(request) {
  const body = await request.json().catch(() => ({}));
  return typeof (/** @type {any} */ (body)?.token) === "string" ? (/** @type {any} */ (body).token) : "";
}
