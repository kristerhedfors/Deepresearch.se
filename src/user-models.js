// @ts-check
// THE PER-ACCOUNT MODEL RECORD — what this account enabled, and what is known
// about every model it has verified.
//
// Two things live here, and they are deliberately independent:
//
//   ENABLED (`hf_models` on the wire — see the key note below): models this
//   account turned on out of an open provider's catalog. This is the promotion
//   pipeline: enabling is what moves a model from somebody else's marketplace
//   into this account's dropdown, in every chat mode. Models from curated
//   providers never appear here — they are available by construction and there
//   is nothing to enable.
//
//   CHECKS (`model_checks`): verification results, keyed by model id, for ANY
//   model — enabled, available, whatever provider. A Berget model can carry a
//   full checklist without ever being "enabled", because it never needed to be.
//   This is why the two are separate maps rather than one list of objects: the
//   lifecycle and the evidence are orthogonal (src/model-catalog.js).
//
// Storage: `users.settings_json`, the additive D1 column the feature knobs
// already use, so no migration. src/settings.js `mergeStoredSettings` is what
// stops a knob write from wiping either map.
//
// A stored enabled-entry is a PRICE SNAPSHOT taken at enable time rather than a
// pointer into a live catalog. Two reasons, both load-bearing:
//   1. Billing must not depend on a third-party fetch. src/billing.js prices a
//      finished request off the catalog entry; if that entry only existed while
//      the marketplace answered, an outage would silently bill at zero.
//   2. The price the user agreed to is the price they keep until they say
//      otherwise. A provider raising its rate does not silently raise this
//      account's bill — the agent re-checks and offers the new price instead.
// The staleness that buys is real and deliberate; `refreshNotes` surfaces it.
//
// WIRE-KEY NOTE. The enabled list is stored under `hf_models` and the entries
// carry an `hfId`. Both names predate the generalisation from a Hugging Face
// agent to a Models agent, and both are kept: they are storage keys in a live
// D1 column, and renaming them would strand every account that had already
// enabled something for the sake of tidier spelling. Same internal/display
// split the project already applies to `/api/projects*` versus "workspace"
// (CLAUDE.md's branding rule). Nothing user-facing says "hf".

import { getDb } from "./db.js";
import { hfModelId, parseHfModelId } from "./hf-inference.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./settings.js').Identity} Identity */

/** The settings_json key holding the enabled list. WIRE NAME — see the header. */
export const ACCEPTED_KEY = "hf_models";
/** The settings_json key holding verification results, keyed by model id. */
export const CHECKS_KEY = "model_checks";

/** A hard structural cap on the enabled list, above any product allowance: a
 * settings_json row is not a database table, and an unbounded list would bloat
 * every identity load on every request. */
export const MAX_STORED = 24;
/** The same for verification records. Checks are cheap to store but they ride
 * on the identity of every request, so the map is bounded and oldest-first
 * evicted. */
export const MAX_CHECKED = 40;

/**
 * One enabled model, as stored and as served to the client.
 * @typedef {{
 *   id: string,
 *   hfId: string,
 *   name: string,
 *   provider: string | null,
 *   price_in: number,
 *   price_out: number,
 *   usd_in: number | null,
 *   usd_out: number | null,
 *   context: number | null,
 *   vision: boolean,
 *   accepted_at: number,
 * }} AcceptedModel
 */

/** @param {unknown} v @param {number} [fallback] */
const posNum = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

/**
 * Tolerant parse of one stored entry — the same discipline as settings.js
 * parseSettings: a malformed row is dropped, never thrown over. Returns null
 * when the entry can't be trusted to price a request.
 * @param {any} raw
 * @returns {AcceptedModel | null}
 */
export function normalizeAccepted(raw) {
  if (!raw || typeof raw !== "object") return null;
  const parsed = parseHfModelId(raw.id);
  if (!parsed) return null;
  return {
    id: String(raw.id),
    hfId: parsed.hfId,
    name: typeof raw.name === "string" && raw.name ? raw.name.slice(0, 120) : parsed.hfId,
    provider: parsed.provider,
    price_in: posNum(raw.price_in),
    price_out: posNum(raw.price_out),
    usd_in: typeof raw.usd_in === "number" ? raw.usd_in : null,
    usd_out: typeof raw.usd_out === "number" ? raw.usd_out : null,
    context: Number.isInteger(raw.context) ? raw.context : null,
    vision: raw.vision === true,
    accepted_at: Number.isInteger(raw.accepted_at) ? raw.accepted_at : 0,
  };
}

/**
 * The enabled list out of a stored settings_json value. Always an array.
 * @param {unknown} json the stored settings_json string (or a pre-parsed object)
 * @returns {AcceptedModel[]}
 */
export function parseAcceptedModels(json) {
  const raw = parseColumn(json);
  const list = Array.isArray(raw[ACCEPTED_KEY]) ? raw[ACCEPTED_KEY] : [];
  /** @type {AcceptedModel[]} */
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const m = normalizeAccepted(entry);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= MAX_STORED) break;
  }
  return out;
}

/** @param {unknown} json @returns {Record<string, any>} */
function parseColumn(json) {
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* unreadable column — defaults */
  }
  return {};
}

/**
 * The identity's enabled models ([] for the break-glass operator, which has no
 * D1 row to hang a per-account decision on).
 * @param {Identity | null | undefined} identity
 * @returns {AcceptedModel[]}
 */
export function acceptedModels(identity) {
  if (!identity?.user) return [];
  return parseAcceptedModels(identity.user.settings_json);
}

/** The lifecycle-facing name for the same list. `acceptedModels` is kept
 * because src/providers.js and the tests already speak it.
 * @param {Identity | null | undefined} identity
 * @returns {AcceptedModel[]} */
export function enabledModels(identity) {
  return acceptedModels(identity);
}

/**
 * Everything the catalog needs to know about ONE account, resolved once. The
 * Models agent's enrichment runs inside the pipeline, where deliberately no
 * identity is on the request state (it would ride into chat_logs); the request
 * handler resolves this instead and hands it over.
 * @param {Identity | null | undefined} identity
 * @returns {{ enabled: AcceptedModel[], checks: Record<string, Record<string, any>> }}
 */
export function accountModels(identity) {
  return { enabled: enabledModels(identity), checks: storedChecks(identity) };
}

// ---- verification records ----------------------------------------------------

/**
 * Stored check results, `{ [modelId]: { [checkId]: CheckResult } }`. Tolerant:
 * anything that isn't a plausible result is dropped, so a hand-edited column
 * yields fewer checkmarks rather than a broken sidebar.
 * @param {Identity | null | undefined} identity
 * @returns {Record<string, Record<string, any>>}
 */
export function storedChecks(identity) {
  if (!identity?.user) return {};
  const raw = parseColumn(identity.user.settings_json)[CHECKS_KEY];
  if (!raw || typeof raw !== "object") return {};
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const [modelId, results] of Object.entries(raw)) {
    if (typeof modelId !== "string" || !results || typeof results !== "object") continue;
    /** @type {Record<string, any>} */
    const kept = {};
    for (const [checkId, r] of Object.entries(/** @type {any} */ (results))) {
      const v = /** @type {any} */ (r);
      if (!v || typeof v !== "object" || typeof v.pass !== "boolean") continue;
      kept[checkId] = {
        id: checkId,
        pass: v.pass,
        note: typeof v.note === "string" ? v.note.slice(0, 200) : "",
        ms: posNum(v.ms),
        at: posNum(v.at),
      };
    }
    if (Object.keys(kept).length) out[modelId] = kept;
  }
  return out;
}

/**
 * Merge a verification run's results into the stored map and persist. Results
 * merge per CHECK rather than replacing a model's whole record, so re-running a
 * single check updates that checkbox and leaves the others' evidence intact.
 * @param {Env} env
 * @param {Identity} identity
 * @param {string} modelId
 * @param {Array<{ id: string, pass: boolean, note: string, ms: number, at: number }>} results
 * @returns {Promise<Record<string, Record<string, any>>>} the stored map
 */
export async function recordChecks(env, identity, modelId, results) {
  const all = storedChecks(identity);
  const merged = { ...(all[modelId] || {}) };
  for (const r of results) merged[r.id] = { id: r.id, pass: !!r.pass, note: String(r.note || "").slice(0, 200), ms: r.ms, at: r.at };
  all[modelId] = merged;
  // Bounded, oldest-run-first: a record's age is the newest check in it.
  const entries = Object.entries(all);
  if (entries.length > MAX_CHECKED) {
    entries.sort((a, b) => newest(b[1]) - newest(a[1]));
    for (const [id] of entries.slice(MAX_CHECKED)) delete all[id];
  }
  await writeSettings(env, identity, { [CHECKS_KEY]: all });
  return all;
}

/** @param {Record<string, any>} rec */
function newest(rec) {
  return Math.max(0, ...Object.values(rec).map((r) => /** @type {any} */ (r)?.at || 0));
}

/**
 * Forget a model's verification record — the "re-verify from scratch" action.
 * @param {Env} env
 * @param {Identity} identity
 * @param {string} modelId
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
export async function clearChecks(env, identity, modelId) {
  const all = storedChecks(identity);
  delete all[modelId];
  await writeSettings(env, identity, { [CHECKS_KEY]: all });
  return all;
}

// ---- enabling ----------------------------------------------------------------

/**
 * Build a storable entry from a catalog row. Returns null when the row can't be
 * priced — an entry with no rate would bill every request at zero, which is the
 * one failure mode this store must not have.
 * @param {any} item
 * @param {number} now
 * @returns {AcceptedModel | null}
 */
export function acceptedFromBrowseItem(item, now) {
  const id = hfModelId(item?.hfId, item?.provider || undefined);
  if (!id) return null;
  if (!(item.price_out > 0) && !(item.price_in > 0)) return null;
  return normalizeAccepted({
    id,
    name: item.name || item.hfId,
    price_in: item.price_in,
    price_out: item.price_out,
    usd_in: item.usd_in,
    usd_out: item.usd_out,
    context: item.context,
    vision: item.vision,
    accepted_at: now,
  });
}

/**
 * Write a patch into settings_json, preserving everything else in the column.
 * Goes through src/settings.js so ONE module knows how the column is laid out.
 * @param {Env} env
 * @param {Identity} identity
 * @param {Record<string, any>} patch
 */
async function writeSettings(env, identity, patch) {
  const db = await getDb(env);
  if (!db || !identity.user) throw new Error("Database not configured.");
  const { mergeStoredSettings } = await import("./settings.js");
  const merged = mergeStoredSettings(identity.user.settings_json, patch);
  await db
    .prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(merged), identity.user.id)
    .run();
  // Keep the in-request identity consistent with what was just written, so a
  // handler that answers with the fresh state doesn't re-read D1.
  identity.user.settings_json = JSON.stringify(merged);
  return merged;
}

/**
 * Persist a whole enabled list.
 * @param {Env} env
 * @param {Identity} identity
 * @param {AcceptedModel[]} list
 * @returns {Promise<AcceptedModel[]>} the stored list
 */
export async function saveAcceptedModels(env, identity, list) {
  const trimmed = list.slice(0, MAX_STORED);
  await writeSettings(env, identity, { [ACCEPTED_KEY]: trimmed });
  return trimmed;
}

/**
 * Enable a model (idempotent: re-enabling refreshes the snapshot in place, so
 * "the price changed, take the new one" is the same call as "turn it on").
 * @param {Env} env
 * @param {Identity} identity
 * @param {AcceptedModel} model
 * @returns {Promise<AcceptedModel[]>}
 */
export async function acceptModel(env, identity, model) {
  const list = acceptedModels(identity).filter((m) => m.id !== model.id && m.hfId !== model.hfId);
  return saveAcceptedModels(env, identity, [...list, model]);
}

/**
 * Disable a model. Matches on the full catalog id OR the bare repo id, so
 * "remove Qwen3.6-27B" works without the caller reconstructing the pinned
 * provider suffix. Its verification record is deliberately KEPT: what was
 * learned about a model stays learned, so re-enabling it later shows the
 * checklist it already earned rather than starting blank.
 * @param {Env} env
 * @param {Identity} identity
 * @param {string} id
 * @returns {Promise<AcceptedModel[]>}
 */
export async function removeAcceptedModel(env, identity, id) {
  const parsed = parseHfModelId(id);
  const hfId = parsed?.hfId || id;
  return saveAcceptedModels(env, identity, acceptedModels(identity).filter((m) => m.id !== id && m.hfId !== hfId));
}

/**
 * Which enabled models the live catalog now prices differently (or no longer
 * serves) — the cost of snapshotting, surfaced instead of hidden. Pure; the
 * caller supplies whatever catalog it already fetched.
 * @param {AcceptedModel[]} accepted
 * @param {import('./hf-inference.js').HfModelInfo[]} catalog
 * @returns {Array<{ id: string, hfId: string, gone: boolean, usd_out: number | null, was_usd_out: number | null }>}
 */
export function hfRefreshNotes(accepted, catalog) {
  /** @type {Array<{ id: string, hfId: string, gone: boolean, usd_out: number | null, was_usd_out: number | null }>} */
  const notes = [];
  for (const m of accepted) {
    const live = catalog.find((c) => c.hfId === m.hfId);
    const nowOut = live?.best?.usdOut ?? null;
    const gone = !live || !live.best;
    if (gone || (m.usd_out !== null && nowOut !== null && Math.abs(nowOut - m.usd_out) > 1e-9)) {
      notes.push({ id: m.id, hfId: m.hfId, gone, usd_out: nowOut, was_usd_out: m.usd_out });
    }
  }
  return notes;
}
