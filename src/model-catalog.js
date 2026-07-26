// @ts-check
// THE MODEL CATALOG — one list of every model this deployment can reach, from
// whichever provider, in whatever lifecycle state, with whatever is known about
// it. The layer the Models agent reasons over.
//
// The point of this module is that it names no provider. Berget, Anthropic,
// OpenAI and Hugging Face all arrive through the registry in src/providers.js
// as descriptors; adding a fifth is a registry entry, and nothing here changes.
// That matters more than it sounds: the previous version of this feature WAS a
// Hugging Face agent, and every one of its concepts — "accept a model", "the
// allowance", "the shelf" — quietly assumed exactly one open marketplace. This
// is the same feature with that assumption removed.
//
// ---- The lifecycle -----------------------------------------------------------
//
//   discovered → an open provider's catalog lists it. Nothing is enabled about
//                it; it is a thing that exists, with a price. (Only providers
//                that declare `explore` can produce this state — today Hugging
//                Face's router.)
//   available  → the provider ships it and this deployment holds the key. It is
//                already selectable everywhere. Most models are born here; they
//                never pass through `discovered` because a curated catalog has
//                nothing to discover.
//   enabled    → this account deliberately turned it on (src/user-models.js).
//                Only reachable from `discovered`: enabling is how a model
//                crosses from somebody else's marketplace into this account's
//                dropdown.
//
// VERIFICATION IS ORTHOGONAL to all three (src/model-checks.js). A model can be
// available and unverified, enabled and failing four checks, discovered and
// never probed. The checks say what is KNOWN, the lifecycle says what is
// REACHABLE, and neither gates the other. That separation is the whole design:
// a checklist that blocked selection would be a quality gate wearing a
// checklist's clothes, and this project ships models with known quirks on
// purpose (src/model-profiles.js).

import {
  exploreProvider,
  listChatModelsWith,
  providerConfigured,
  providerDescriptors,
  providerIdFor,
} from "./providers.js";
import { checklistFor, checkSummary } from "./model-checks.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * One row of the catalog, as the API serves it and the sidebar renders it.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   provider: string,
 *   providerLabel: string,
 *   state: "discovered" | "available" | "enabled",
 *   usable: boolean,
 *   vision: boolean,
 *   tools: boolean,
 *   context: number | null,
 *   price_in: number,
 *   price_out: number,
 *   usd_in: number | null,
 *   usd_out: number | null,
 *   pricing: string | null,
 *   turn_eur: number | null,
 *   url: string | null,
 *   servedBy: string | null,
 *   up: boolean,
 *   checks: ReturnType<typeof checklistFor>,
 *   verification: ReturnType<typeof checkSummary>,
 *   enableable: boolean,
 *   reason: string | null,
 * }} CatalogRow
 */

/** The illustrative turn every price is expressed against, so two models from
 * two providers are compared on one number rather than on two pricing pages.
 * Re-exported from the provider that first needed it, to keep ONE definition. */
export { TYPICAL_TURN, turnCostEur } from "./hf-inference.js";

import { turnCostEur as turnCost } from "./hf-inference.js";
import { formatPricing } from "./berget.js";

// ---- the model allowance -----------------------------------------------------
//
// Opening a marketplace to a signed-in account is a spend surface, so ENABLING
// is bounded rather than free: a ceiling on what a model may cost, and a cap on
// how many one account may hold. Both are admin-tunable (`config.models`),
// which is exactly how the allowance gets extended for an account that has
// earned it — a config edit, not a code change.
//
// It applies ONLY to the `discovered → enabled` transition. A curated
// provider's models are available by construction; the allowance has nothing to
// say about them, because nobody is choosing to spend by selecting one that was
// always on the menu.

/**
 * @typedef {{ maxOutputUsd: number, maxEnabled: number }} ModelAllowance
 */

/** The built-in starting allowance, absent any admin config. */
export const DEFAULT_ALLOWANCE = { maxOutputUsd: 3, maxEnabled: 6 };

/**
 * Read the allowance out of the site config, falling back to the starting one.
 * Junk falls back rather than uncapping by accident.
 * @param {any} config the getConfig(env) object
 * @returns {ModelAllowance}
 */
export function modelAllowance(config) {
  const m = config?.models || {};
  const maxOutputUsd = typeof m.max_output_usd === "number" && m.max_output_usd >= 0
    ? m.max_output_usd
    : DEFAULT_ALLOWANCE.maxOutputUsd;
  const maxEnabled = Number.isInteger(m.max_enabled) && m.max_enabled >= 0
    ? m.max_enabled
    : DEFAULT_ALLOWANCE.maxEnabled;
  return { maxOutputUsd, maxEnabled };
}

/**
 * Whether a row may be enabled right now, and why not when it may not. A
 * blocked card must always be able to explain itself — a greyed-out button with
 * no reason is the thing this avoids.
 * @param {CatalogRow} r
 * @param {ModelAllowance} allowance
 * @param {number} enabledCount
 * @returns {{ enableable: boolean, reason: string | null }}
 */
export function enableVerdict(r, allowance, enabledCount) {
  if (r.state !== "discovered") {
    return { enableable: false, reason: null }; // nothing to enable — already usable
  }
  if (!(r.price_out > 0) && !(r.price_in > 0)) {
    return {
      enableable: false,
      reason: "No provider publishes a price for this model — it can't be budgeted, so it can't be enabled.",
    };
  }
  if (allowance.maxOutputUsd > 0 && (r.usd_out || 0) > allowance.maxOutputUsd) {
    return {
      enableable: false,
      reason: `Above your model allowance ($${allowance.maxOutputUsd.toFixed(2)} per 1M output tokens). Ask an admin to raise it.`,
    };
  }
  if (allowance.maxEnabled > 0 && enabledCount >= allowance.maxEnabled) {
    return {
      enableable: false,
      reason: `Your allowance holds ${allowance.maxEnabled} enabled models. Remove one to enable another.`,
    };
  }
  return { enableable: true, reason: null };
}

/**
 * Merge everything reachable into one list.
 *
 * Three sources, in precedence order — a model present in more than one is
 * reported once, in its strongest state:
 *   1. the merged provider catalog (`listChatModels` with the identity), which
 *      is what /api/models serves and therefore what is genuinely selectable;
 *   2. the account's enabled list, which marks which of those it enabled;
 *   3. every open provider's `explore`, for models nobody has enabled yet.
 *
 * Fail-soft throughout (invariant 2): an unreachable provider contributes
 * nothing and the rest of the list still renders. The catalog fetch failing
 * entirely is the one case that yields an empty list plus a `note`, which the
 * caller surfaces rather than erroring.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {{ enabled: import('./user-models.js').AcceptedModel[], checks: Record<string, Record<string, any>> }} account
 *   the account's resolved lifecycle state (src/user-models.js accountModels).
 *   Passed rather than an identity so this module — and the pipeline enrichment
 *   that calls it — never holds one.
 * @returns {Promise<{ rows: CatalogRow[], providers: Array<{ id: string, label: string, open: boolean, configured: boolean, count: number }>, note: string | null }>}
 */
export async function buildCatalog(env, log, account) {
  const enabled = account?.enabled || [];
  const enabledIds = new Set(enabled.map((m) => m.id));
  const checks = account?.checks || {};

  /** @type {any[]} */
  let usable = [];
  /** @type {string | null} */
  let note = null;
  try {
    usable = (await listChatModelsWith(env, enabled)) || [];
  } catch (err) {
    log?.warn?.("model_catalog.providers_unavailable", { error: String(/** @type {any} */ (err)?.message || err) });
    note = "The provider catalog is unreachable right now. Models you already enabled still work.";
  }

  /** @type {Map<string, CatalogRow>} */
  const byId = new Map();
  for (const m of usable) {
    const providerId = m.provider ? String(m.provider) : providerIdFor(m.id);
    byId.set(m.id, row({
      id: m.id,
      name: m.name || m.id,
      provider: providerId,
      state: enabledIds.has(m.id) ? "enabled" : "available",
      vision: !!m.vision,
      tools: !!m.tools,
      context: m.context ?? null,
      price_in: m.price_in || 0,
      price_out: m.price_out || 0,
      usd_in: m.usd_in ?? null,
      usd_out: m.usd_out ?? null,
      url: m.url || null,
      servedBy: m.servedBy || null,
      up: m.up !== false,
    }, checks));
  }

  // The open marketplaces. Everything they list that is not already usable is
  // `discovered` — a model that exists at a price, and nothing more.
  for (const p of providerDescriptors()) {
    if (!p.open || !providerConfigured(env, p.id)) continue;
    const found = await exploreProvider(env, log, p.id);
    for (const m of found) {
      if (byId.has(m.id)) continue;
      byId.set(m.id, row({ ...m, state: "discovered", up: true }, checks));
    }
  }

  const rows = [...byId.values()];
  const providers = providerDescriptors().map((p) => {
    const count = rows.filter((r) => r.provider === p.id).length;
    // A provider that CONTRIBUTED models is working, whatever the secret check
    // thinks: some catalogs are readable without a key. Reporting "not
    // configured" next to eight of its models would be the kind of
    // self-contradiction that makes a status line worth ignoring.
    return { ...p, configured: providerConfigured(env, p.id) || count > 0, count };
  });
  return { rows, providers, note };
}

/** Build one row, attaching its verification state. Kept separate and pure so
 * the shape is defined in exactly one place.
 * @param {any} m
 * @param {Record<string, any>} checks
 * @returns {CatalogRow} */
function row(m, checks) {
  const label = providerDescriptors().find((p) => p.id === m.provider)?.label || m.provider;
  const list = checklistFor(m, checks[m.id] || null);
  const priced = m.price_in > 0 || m.price_out > 0;
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerLabel: label,
    state: m.state,
    // What the answer-model dropdown will actually accept. `discovered` is the
    // one state that is not usable — everything else already is.
    usable: m.state !== "discovered",
    vision: !!m.vision,
    tools: !!m.tools,
    context: m.context ?? null,
    price_in: m.price_in || 0,
    price_out: m.price_out || 0,
    usd_in: m.usd_in ?? null,
    usd_out: m.usd_out ?? null,
    pricing: priced ? formatPricing({ input: m.price_in, output: m.price_out, currency: "EUR" }) : null,
    turn_eur: priced ? turnCost(m.price_in, m.price_out) : null,
    url: m.url || null,
    servedBy: m.servedBy || null,
    up: m.up !== false,
    checks: list,
    verification: checkSummary(list),
    // Filled by applyAllowance once the whole list exists — the cap depends on
    // how many are already enabled, which is not knowable per row.
    enableable: false,
    reason: null,
  };
}

/**
 * Stamp every row with its enable verdict. Separate from `row` because the
 * count-based half of the allowance is a property of the SET, not of a row.
 * @param {CatalogRow[]} rows
 * @param {ModelAllowance} allowance
 * @returns {CatalogRow[]} the same rows, mutated
 */
export function applyAllowance(rows, allowance) {
  const enabledCount = rows.filter((r) => r.state === "enabled").length;
  for (const r of rows) {
    const v = enableVerdict(r, allowance, enabledCount);
    r.enableable = v.enableable;
    r.reason = v.reason;
  }
  return rows;
}

/**
 * Rank the catalog against a free-text query. Deterministic and pure — a
 * lexical scan, no model call, and the query never leaves the isolate
 * (invariants 1 and 4). An empty query orders by lifecycle first (what you can
 * use, then what you enabled, then the marketplace) and price second, which is
 * the order the sidebar wants anyway.
 * @param {CatalogRow[]} rows
 * @param {string} query
 * @returns {CatalogRow[]}
 */
export function rankCatalog(rows, query) {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9.+-]+/).filter((t) => t.length > 1);
  const byDefault = (/** @type {CatalogRow} */ a, /** @type {CatalogRow} */ b) =>
    stateRank(a.state) - stateRank(b.state) || (a.price_out || Infinity) - (b.price_out || Infinity);
  if (!terms.length) return [...rows].sort(byDefault);
  const scored = rows
    .map((r) => {
      const hay = `${r.id} ${r.name} ${r.providerLabel} ${r.servedBy || ""}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      if (score && terms.every((t) => hay.includes(t))) score += 3;
      return { r, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || byDefault(a.r, b.r));
  return scored.map((s) => s.r);
}

/** @param {string} state */
function stateRank(state) {
  return state === "enabled" ? 0 : state === "available" ? 1 : 2;
}

/**
 * The catalog block the Models agent folds into a turn, so an answer about
 * models quotes real current prices and real verification state rather than
 * remembered ones. Pure.
 * @param {CatalogRow[]} rows
 * @param {number} limit
 * @returns {string}
 */
export function catalogBlock(rows, limit = 8) {
  if (!rows.length) return "";
  const lines = rows.slice(0, limit).map((r) => {
    const price = r.usd_out !== null
      ? `$${r.usd_in ?? "?"} in / $${r.usd_out} out per 1M tokens`
      : r.pricing || "no published price";
    const turn = r.turn_eur !== null ? ` (≈ €${r.turn_eur.toFixed(4)} per research turn)` : "";
    const ctx = r.context ? `, ${Math.round(r.context / 1000)}k context` : "";
    const flags = [r.vision ? "vision" : "", r.tools ? "tools" : ""].filter(Boolean).join(", ");
    const failing = r.checks.filter((c) => c.state === "fail").map((c) => c.label);
    const verdict = failing.length
      ? `${r.verification.label} — failing: ${failing.join(", ")}`
      : r.verification.label;
    return `- ${r.id} — ${r.providerLabel}${r.servedBy ? ` via ${r.servedBy}` : ""}${ctx} — ${price}${turn}` +
      `${flags ? ` [${flags}]` : ""} — ${r.state.toUpperCase()}, ${verdict}`;
  });
  return [
    "MODEL CATALOG (live, this turn, across every provider this deployment can reach):",
    ...lines,
    "",
    "STATE means: DISCOVERED = listed by an open provider, not enabled here yet; AVAILABLE = already selectable in every mode; ENABLED = this account turned it on.",
    "Verification counts are the checks in the Models sidebar. They are NOT blockers — a failing check is a known limitation, not a ban, and an untried one is a question nobody has asked yet.",
    "Use these numbers verbatim when discussing cost or capability. Enabling and verifying are the USER's actions: point them at the model's card in the left sidebar, and say plainly that enabling a model makes it selectable in every chat mode, not just this one.",
  ].join("\n");
}
