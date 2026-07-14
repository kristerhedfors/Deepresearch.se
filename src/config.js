// @ts-check
// Global site configuration: default quotas, Exa pricing, the time-budget
// cap, the site default model, and the approval gate. Stored as one JSON
// row in the D1 `config` table (admin-editable via PUT /api/admin/config),
// cached ~30 s per isolate. Without a DB binding the defaults apply.
//
// Quota semantics (what the numbers mean, enforcement in src/quota.js):
//   - budget_eur: Berget COST cap per window (0 = uncapped)
//   - searches:   Exa search COUNT cap per window (0 = uncapped)

import { getDb } from "./db.js";
import { PERIODS } from "./quota.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./quota.js').QuotaMap} QuotaMap */

/**
 * The effective site configuration `getConfig` resolves (defaults merged
 * with the admin-edited D1 row).
 * @typedef {Object} SiteConfig
 * @property {QuotaMap} quotas default per-window quotas (h5/day/week/month)
 * @property {number} exa_cost_per_search_eur
 * @property {number} max_time_budget_s cap for the UI slider value accepted server-side
 * @property {string} default_model empty = Worker default (BERGET_MODEL var / built-in)
 * @property {boolean} require_approval new sign-ins land as "pending" until approved
 * @property {number} anim_speed intro-animation speed multiplier (1 = the
 *   default pace, which is itself 2.5× the original — see BASE_SPEED in
 *   public/cure/umbrella.js); served publicly via GET /api/anim
 * @property {WebSearchGrantConfig} websearch the temporary web-search grant
 *   defaults + governance (the admin control panel edits these — src/websearch.js)
 */
/**
 * The mintable-web-search-grant defaults + budget governance.
 * @typedef {Object} WebSearchGrantConfig
 * @property {boolean} enabled master switch for the whole grant subsystem
 * @property {number} quota default searches per minted key
 * @property {number} ttl_hours default lifetime of a minted key, in hours
 * @property {number} budget cap on total OUTSTANDING remaining across all live
 *   grants (0 = uncapped) — the "entire set of quota" ceiling the panel governs
 */

/** @type {SiteConfig} */
export const DEFAULT_CONFIG = {
  quotas: {
    h5: { budget_eur: 0.25, searches: 30 },
    day: { budget_eur: 0.5, searches: 100 },
    week: { budget_eur: 2, searches: 400 },
    month: { budget_eur: 6, searches: 1200 },
  },
  exa_cost_per_search_eur: 0.005,
  max_time_budget_s: 600, // cap for the UI slider value accepted server-side
  default_model: "", // empty = Worker default (BERGET_MODEL var / built-in)
  // Approval gate: new Google sign-ins land as status "pending" (waiting
  // page, no API access) until the admin approves them in /admin.
  require_approval: true,
  // The /cure first-visit umbrella intro's speed, relative to its default
  // pace (admin slider in /admin; the slider's center is exactly this 1).
  anim_speed: 1,
  // Temporary web-search grants (src/websearch.js): the admin control panel's
  // default mint values + the global budget ceiling.
  websearch: {
    enabled: true,
    quota: 25,
    ttl_hours: 24,
    budget: 0,
  },
};

/** @type {{ at: number, value: SiteConfig | null }} */
let configCache = { at: 0, value: null };
const CONFIG_TTL_MS = 30_000;

/**
 * The current site config: the cached D1 row merged over the defaults, or a
 * fresh clone of the defaults when no database is configured.
 * @param {Env} env
 * @returns {Promise<SiteConfig>}
 */
export async function getConfig(env) {
  const db = await getDb(env);
  if (!db) return structuredClone(DEFAULT_CONFIG);
  if (configCache.value && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }
  const row = await db.prepare("SELECT value FROM config WHERE key='app'").first();
  let stored = {};
  try {
    stored = row ? JSON.parse(String(row.value)) : {};
  } catch {
    stored = {};
  }
  const merged = mergeConfig(DEFAULT_CONFIG, stored);
  configCache = { at: Date.now(), value: merged };
  return merged;
}

/**
 * Merges a sanitized admin patch into the stored config and refreshes the
 * cache. Throws without a database (the admin API surfaces the error).
 * @param {Env} env
 * @param {any} patch untrusted admin request body
 * @returns {Promise<SiteConfig>} the new effective config
 */
export async function saveConfig(env, patch) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const current = await getConfig(env);
  const next = mergeConfig(current, sanitizeConfigPatch(patch));
  await db
    .prepare("INSERT INTO config (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(next))
    .run();
  configCache = { at: Date.now(), value: next };
  return next;
}

/**
 * Overlays `patch` on `base` field by field, coercing/clamping each value so
 * a malformed or hostile patch can only ever produce a valid config.
 * @param {SiteConfig} base
 * @param {any} patch
 * @returns {SiteConfig}
 */
function mergeConfig(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== "object") return out;
  for (const p of PERIODS) {
    const q = patch.quotas?.[p];
    if (q && typeof q === "object") {
      if (Number.isFinite(q.budget_eur)) out.quotas[p].budget_eur = Math.max(0, q.budget_eur);
      if (Number.isFinite(q.searches)) out.quotas[p].searches = Math.max(0, Math.round(q.searches));
    }
  }
  if (Number.isFinite(patch.exa_cost_per_search_eur)) {
    out.exa_cost_per_search_eur = Math.max(0, patch.exa_cost_per_search_eur);
  }
  if (Number.isFinite(patch.max_time_budget_s)) {
    out.max_time_budget_s = Math.min(600, Math.max(15, Math.round(patch.max_time_budget_s)));
  }
  if (typeof patch.default_model === "string") out.default_model = patch.default_model;
  if (typeof patch.require_approval === "boolean") out.require_approval = patch.require_approval;
  if (Number.isFinite(patch.anim_speed)) {
    // Same clamp as the client's clampAnimMult: a hostile patch can only
    // ever slow to ¼× or hasten to 4× the default.
    out.anim_speed = Math.min(4, Math.max(0.25, patch.anim_speed));
  }
  const w = patch.websearch;
  if (w && typeof w === "object") {
    if (typeof w.enabled === "boolean") out.websearch.enabled = w.enabled;
    // A minted key's quota/TTL and the global budget are counts of searches /
    // hours; clamp to sane, non-hostile ranges (quota 1..10000, ttl 1..720h /
    // 30d, budget ≥0 with 0 = uncapped).
    if (Number.isFinite(w.quota)) out.websearch.quota = Math.min(10000, Math.max(1, Math.round(w.quota)));
    if (Number.isFinite(w.ttl_hours)) out.websearch.ttl_hours = Math.min(720, Math.max(1, Math.round(w.ttl_hours)));
    if (Number.isFinite(w.budget)) out.websearch.budget = Math.max(0, Math.round(w.budget));
  }
  return out;
}

/**
 * Only known keys survive into storage (an admin API caller can't stuff
 * arbitrary JSON into config).
 * @param {any} patch
 */
function sanitizeConfigPatch(patch) {
  return {
    quotas: patch?.quotas,
    exa_cost_per_search_eur: numOr(patch?.exa_cost_per_search_eur),
    max_time_budget_s: numOr(patch?.max_time_budget_s),
    default_model: patch?.default_model,
    require_approval: patch?.require_approval,
    anim_speed: numOr(patch?.anim_speed),
    websearch: patch?.websearch,
  };
}
/** @param {any} v @returns {number | undefined} */
const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);
