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
import { SEARCH_BACKENDS } from "./websearch-backends.js";

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
 * @property {SearchBackendConfig} search the web-search BACKEND selection —
 *   which provider actually runs the pipeline's searches (Exa or a self-hosted
 *   alternative). Edited on the admin's "Web search service" panel; the
 *   pluggable backends live in src/websearch-backends.js
 * @property {ProxyGrantConfig} proxy the secure-research-space proxy BUNDLE
 *   defaults + governance (per-service quota/TTL + shared budget — src/proxy.js)
 * @property {SandboxImageConfig} sandbox the self-hosted Linux sandbox image
 *   selection + registry (admin-selectable small image — src/sandbox-image.js)
 */
/**
 * The self-hosted Linux sandbox image selection (see docs/SANDBOX-LOCAL-IMAGE.md).
 * @typedef {Object} SandboxImageConfig
 * @property {string} image the SELECTED default image id (must match an
 *   images[].id, else it degrades to "" = the built-in streamed default, so the
 *   feature is inert until an operator uploads AND selects an image)
 * @property {SandboxImage[]} images the registry of self-hosted images the admin
 *   picker offers (each uploaded to R2 out of band as sandbox-images/<id>.ext2)
 * @property {boolean} prefetch fully prefetch the (small) selected image into the
 *   browser block cache on first boot so later boots issue zero disk fetches
 */
/**
 * One registered sandbox image row.
 * @typedef {Object} SandboxImage
 * @property {string} id stable slug ([a-z0-9-]+); the R2 basename + served path
 * @property {string} label human label for the picker
 * @property {string} arch guest ISA — MUST be "i386" (CheerpX is 32-bit x86 only)
 * @property {number} size_mb approximate on-disk size, for the UI
 * @property {boolean} verified live-verified on real devices — only verified
 *   images should be set as the fleet default
 */
/**
 * The web-search BACKEND selection (which provider runs the pipeline's
 * searches). The auth secret + an optional base-URL override come from the
 * `SEARCH_BACKEND_KEY` / `SEARCH_BACKEND_URL` env, never stored here.
 * @typedef {Object} SearchBackendConfig
 * @property {string} backend one of src/websearch-backends.js SEARCH_BACKENDS
 *   ("exa" | "searxng" | "exa_compatible"); anything else falls back to Exa
 * @property {string} base_url the self-hosted service's base URL (ignored for
 *   the "exa" backend; a `SEARCH_BACKEND_URL` env var overrides it)
 * @property {number} results default results per search for a self-hosted
 *   backend (1..20)
 * @property {boolean} fallback_exa on a self-hosted-backend failure, fall back
 *   to Exa when the EXA_API_KEY is present (default true)
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
/**
 * The secure-research-space proxy-bundle defaults + budget governance.
 * @typedef {Object} ProxyGrantConfig
 * @property {boolean} enabled master switch for the whole bundle subsystem
 * @property {number} web_quota default Exa searches per bundled web grant
 * @property {number} web_ttl_hours default lifetime of a web grant, in hours
 * @property {number} api_quota default LLM completions per bundled api grant
 * @property {number} api_ttl_hours default lifetime of an api grant, in hours
 * @property {number} budget cap on total OUTSTANDING remaining across all live
 *   proxy grants (0 = uncapped)
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
  // Web-search BACKEND (src/websearch-backends.js): which provider actually
  // runs the pipeline's searches. Defaults to Exa (the built-in), so an
  // unconfigured site behaves exactly as before. Point it at a self-hosted
  // SearXNG or Exa-compatible service to keep search queries off a third
  // party — see the local-web-search skill.
  search: {
    backend: "exa",
    base_url: "",
    results: 6,
    fallback_exa: true,
  },
  // The SECURE-RESEARCH-SPACE proxy bundle (src/proxy.js): the admin defaults +
  // governance for the account-connected grants a ghost crossover (or a
  // shareable link) hands a Se/cure session — a bundled web-search grant AND an
  // LLM API grant. Per-service quota/TTL + a shared global outstanding-remaining
  // budget ceiling across ALL live proxy grants.
  proxy: {
    enabled: true,
    web_quota: 25, // Exa searches per bundled web grant
    web_ttl_hours: 24,
    api_quota: 40, // LLM completions per bundled api grant
    api_ttl_hours: 24,
    budget: 0, // 0 = uncapped; else caps SUM(quota-used) across live proxy_grants
  },
  // Self-hosted Linux sandbox image (src/sandbox-image.js). Empty `image` = the
  // built-in streamed default (today's webvm.io Debian), so this is INERT until
  // an operator uploads an ext2 image to R2 and selects it. CheerpX is 32-bit
  // x86 ONLY, so every registered image must be i386 (mainline Arch is x86_64
  // and cannot boot — use Alpine i386 / Debian i386-slim / archlinux32).
  sandbox: {
    image: "",
    images: [],
    prefetch: false,
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
export function mergeConfig(base, patch) {
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
  const s = patch.search;
  if (s && typeof s === "object") {
    // Only a known backend id survives; anything else pins to Exa so a
    // malformed patch can never route searches to an unvalidated target.
    if (typeof s.backend === "string") {
      out.search.backend = SEARCH_BACKENDS.includes(s.backend) ? s.backend : "exa";
    }
    if (typeof s.base_url === "string") {
      // Store only a plausible http(s) URL (or empty); a hostile value can't
      // become an outbound target. Trailing slashes trimmed at use.
      const u = s.base_url.trim();
      out.search.base_url = u === "" || /^https?:\/\/[^\s]+$/i.test(u) ? u : out.search.base_url;
    }
    if (Number.isFinite(s.results)) out.search.results = Math.min(20, Math.max(1, Math.round(s.results)));
    if (typeof s.fallback_exa === "boolean") out.search.fallback_exa = s.fallback_exa;
  }
  const px = patch.proxy;
  if (px && typeof px === "object") {
    if (typeof px.enabled === "boolean") out.proxy.enabled = px.enabled;
    // Same non-hostile clamps as websearch: per-service quota 1..10000, ttl
    // 1..720h (30d), budget ≥0 with 0 = uncapped.
    if (Number.isFinite(px.web_quota)) out.proxy.web_quota = Math.min(10000, Math.max(1, Math.round(px.web_quota)));
    if (Number.isFinite(px.web_ttl_hours)) out.proxy.web_ttl_hours = Math.min(720, Math.max(1, Math.round(px.web_ttl_hours)));
    if (Number.isFinite(px.api_quota)) out.proxy.api_quota = Math.min(10000, Math.max(1, Math.round(px.api_quota)));
    if (Number.isFinite(px.api_ttl_hours)) out.proxy.api_ttl_hours = Math.min(720, Math.max(1, Math.round(px.api_ttl_hours)));
    if (Number.isFinite(px.budget)) out.proxy.budget = Math.max(0, Math.round(px.budget));
  }
  const sb = patch.sandbox;
  if (sb && typeof sb === "object") {
    // The image registry: keep only well-formed rows (a hostile/malformed patch
    // can only ever produce a valid, bounded list). Replace wholesale when an
    // `images` array is provided so an admin can remove a row.
    if (Array.isArray(sb.images)) {
      out.sandbox.images = sb.images.map(sanitizeSandboxImage).filter(Boolean).slice(0, 50);
    }
    // The selected default MUST match a registered id — else fall back to ""
    // (the built-in default), so the fleet can never point at a missing image.
    if (typeof sb.image === "string") {
      out.sandbox.image = out.sandbox.images.some((im) => im.id === sb.image) ? sb.image : "";
    }
    if (typeof sb.prefetch === "boolean") out.sandbox.prefetch = sb.prefetch;
  }
  return out;
}

/**
 * Coerce one untrusted sandbox-image row into a valid {@link SandboxImage}, or
 * null if it has no usable id. Every field is clamped so a hostile patch can't
 * inject anything but a bounded, well-shaped row.
 * @param {any} im
 * @returns {import('./config.js').SandboxImage | null}
 */
function sanitizeSandboxImage(im) {
  if (!im || typeof im !== "object") return null;
  const id = String(im.id || "").toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return null;
  return {
    id,
    label: String(im.label || id).slice(0, 80),
    arch: String(im.arch || "i386").slice(0, 16),
    size_mb: Number.isFinite(Number(im.size_mb)) ? Math.max(0, Math.round(Number(im.size_mb))) : 0,
    verified: im.verified === true,
  };
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
    search: patch?.search,
    proxy: patch?.proxy,
    sandbox: patch?.sandbox,
  };
}
/** @param {any} v @returns {number | undefined} */
const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);
