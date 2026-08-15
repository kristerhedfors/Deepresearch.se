// @ts-check
// HOSTED model access for a published Agent Studio app — the grant half of
// capture #CAP-22's feedback (2026-08-12).
//
// WHAT WAS WRONG. Every app Agent Studio built asked its visitor for an API
// key, because that is the only way a page in an opaque origin could reach a
// model: bring your own credential. The owner opened one of these apps and got
// "Error: you didn't provide an api key" — an agent that only its builder could
// use, which is the opposite of "describe it, get a link you can hand to
// someone". Their correction, verbatim in substance: produce agents that use
// the API key the site already has, pinned to a model, so the interface is only
// what the agent itself needs.
//
// WHAT THIS DOES. At publish time, a build that asks for hosted access gets its
// OWN Se/rver token (src/server-token.js — one HS256 JWT, `perms: ["api"]`)
// minted for the publishing user and metered by the same D1 `server_tokens`
// rows as every other grant. The token and the pinned model are written into
// one generated file, `js/dr-app-config.js`, which the app kit reads
// (DRKit.hosted). No new crypto, no new meter, no new endpoint: the app calls
// the existing /api/server-token/llm/chat/completions.
//
// WHY THAT IS SAFE TO PUT IN A PUBLIC PAGE. The published file is world
// readable — anyone with the app's URL can read its token out. That exposure is
// bounded by construction, and bounded is the whole design:
//   - THE SERVER-TOKEN GUARANTEE (src/server-token.js) — the token reaches
//     upstream services ONLY (here: Berget completions on the server's key). It
//     reads nothing Se/rver stores — no project, chat, history or account
//     contents — and it is never a login; the admin surface rejects it
//     everywhere, test-pinned.
//   - It is QUOTA-METERED. The exposure is a fixed number of completions, not
//     an account: when they are spent the endpoint 429s. The global
//     `server_token.budget` ceiling governs the sum of every live grant.
//   - It EXPIRES, and it is revocable and adjustable from the admin surface
//     like any other Se/rver token.
//   - It is OPT-IN per build: nothing is minted unless the build references
//     hosted mode (`buildNeedsHostedLlm`).
// This is the Se/rver tier, where the server is inside the trust boundary
// (owner directive, 2026-07-24) — it is not a new hole in Se/cure's posture,
// whose enumerated bounded exceptions (invariant 4) this adds nothing to.
//
// Fail-soft, per invariant 2: if tokens are disabled, D1 is absent, or the
// budget is spent, the config file is still written — carrying no token — so
// the app can say "hosted access is unavailable" instead of throwing at a
// visitor. A build never fails to publish because a grant could not be minted.

import { DEFAULT_MODEL } from "./berget.js";
import { getConfig } from "./config.js";
import { mintServerTokenGrant } from "./server-grants.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/** Where a hosted app sends its completions (a path — resolved per page). */
export const HOSTED_LLM_BASE = "/api/server-token/llm";

/** Berget is the only upstream the LLM proxy forwards to (src/llm-proxy.js). */
const HOSTED_COUNTRY = "Sweden";
const HOSTED_FLAG = "🇸🇪";

// A published app is a thing people keep and share, so its grant outlives the
// 24 h a browsing session's token gets: 30 days is the config layer's ceiling
// for a TTL, and republishing (an iteration in the chat, an edit at /apps/)
// renews a grant that is close to running out.
const APP_TTL_HOURS = 720;
const APP_QUOTA = 200;
// Renew rather than reuse once less than this remains — so an app someone is
// actively iterating on never hands a visitor a token about to expire.
const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

/**
 * @typedef {Object} HostedGrant
 * @property {string | null} token the JWT, or null when none could be minted
 * @property {string} model the pinned model id
 * @property {string} base the LLM endpoint prefix
 * @property {string} country where the conversation is processed
 * @property {string} flag that country's flag
 * @property {number} [quota] completions the grant was minted with
 * @property {number} [expiresAt] epoch ms
 * @property {string} [jti] the grant id (kept in the build's meta, not served)
 * @property {string} [reason] why there is no token, when there is none
 */

/**
 * The hosted defaults, with the same config knobs as every other grant family.
 * @param {Env} env
 */
async function hostedDefaults(env) {
  const c = /** @type {any} */ ((await getConfig(env)).server_token) || {};
  const posInt = (/** @type {unknown} */ v, /** @type {number} */ d) =>
    Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d;
  return {
    enabled: c.enabled !== false,
    quota: posInt(c.app_quota, APP_QUOTA),
    ttlHours: posInt(c.app_ttl_hours, APP_TTL_HOURS),
    model: typeof c.app_model === "string" && c.app_model ? c.app_model : DEFAULT_MODEL,
  };
}

/**
 * The grant a published build should ship with: the previous one when it is
 * still comfortably alive, a freshly minted one otherwise, or a token-less
 * record when minting is unavailable. Never throws.
 * @param {Env} env
 * @param {Logger} log
 * @param {{ slug: string, owner: string, prev?: any, now?: number }} opts
 * @returns {Promise<HostedGrant>}
 */
export async function ensureAppGrant(env, log, { slug, owner, prev, now = Date.now() }) {
  const defaults = await hostedDefaults(env).catch(() => null);
  const model = defaults?.model || DEFAULT_MODEL;
  /** @param {Partial<HostedGrant>} extra @returns {HostedGrant} */
  const shape = (extra) => ({
    token: null,
    model,
    base: HOSTED_LLM_BASE,
    country: HOSTED_COUNTRY,
    flag: HOSTED_FLAG,
    ...extra,
  });

  // Reuse the app's existing grant while it has real life left in it: the app's
  // URL is stable across iterations, and so should its allowance be — a fresh
  // grant per republish would multiply outstanding quota for one app.
  const prevExp = Number(prev?.expiresAt) || 0;
  if (prev?.token && prevExp - now > RENEW_BEFORE_MS) {
    return shape({
      token: String(prev.token),
      model: typeof prev.model === "string" && prev.model ? prev.model : model,
      quota: Number(prev.quota) || undefined,
      expiresAt: prevExp,
      jti: prev.jti ? String(prev.jti) : undefined,
    });
  }

  if (!defaults?.enabled) return shape({ reason: "disabled" });
  if (!env.BERGET_API_TOKEN) return shape({ reason: "unconfigured" });

  const minted = await mintServerTokenGrant(env, log, {
    userId: String(owner),
    source: "app",
    label: `app:${slug}`.slice(0, 80),
    services: ["api"],
    quotas: { api: defaults.quota },
    ttlHours: defaults.ttlHours,
  }).catch((/** @type {any} */ err) => {
    log.warn("appgrant.mint_failed", { slug, error: err?.message || String(err) });
    return null;
  });

  if (!minted) return shape({ reason: "unavailable" });
  if (/** @type {any} */ (minted).error) {
    log.warn("appgrant.budget_exceeded", { slug });
    return shape({ reason: String(/** @type {any} */ (minted).error) });
  }

  const view = /** @type {any} */ (minted);
  log.info("appgrant.minted", { slug, jti: view.jti, quota: defaults.quota, user_id: String(owner) });
  return shape({
    token: String(view.token),
    quota: defaults.quota,
    expiresAt: Number(view.expiresAt) || now + defaults.ttlHours * 3600 * 1000,
    jti: String(view.jti),
  });
}

/**
 * The generated `js/dr-app-config.js`: one classic script defining one global,
 * exactly like the kit it feeds. Classic and not a module because a published
 * app runs in an opaque origin, where a module script never loads at all.
 *
 * `jti` is deliberately NOT serialised — it is the grant's admin handle and
 * lives in the build's meta; the page needs only the bearer it is going to
 * send anyway.
 * @param {HostedGrant} grant
 * @returns {string}
 */
export function renderAppConfig(grant) {
  const payload = {
    token: grant?.token || null,
    model: grant?.model || DEFAULT_MODEL,
    base: grant?.base || HOSTED_LLM_BASE,
    country: grant?.country || HOSTED_COUNTRY,
    flag: grant?.flag || HOSTED_FLAG,
    ...(grant?.quota ? { quota: grant.quota } : {}),
    ...(grant?.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    ...(grant?.reason ? { reason: grant.reason } : {}),
  };
  return (
    "// Generated by DeepResearch.se Agent Studio when this app was published.\n" +
    "// It carries this app's own hosted model access: a quota-metered grant over\n" +
    "// the site's model provider, and the model it was pinned to. Read by the app\n" +
    "// kit (DRKit.hosted). Regenerated on every publish — editing it does nothing.\n" +
    "window.DR_APP_CONFIG = " +
    // </script> inside a string would end the tag that loads this file.
    JSON.stringify(payload).replace(/</g, "\\u003c") +
    ";\n"
  );
}

/**
 * What to keep in the build's meta so the next publish can reuse this grant.
 * @param {HostedGrant} grant
 */
export function hostedMetaRecord(grant) {
  if (!grant?.token) return null;
  return {
    token: grant.token,
    model: grant.model,
    jti: grant.jti || null,
    quota: grant.quota || null,
    expiresAt: grant.expiresAt || null,
  };
}
