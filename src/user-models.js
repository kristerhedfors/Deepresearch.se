// @ts-check
// The ACCEPTED-MODEL STORE — the promotion pipeline between the Hugging Face
// agent and every other agent mode.
//
// The other providers ship a fixed menu: whatever src/anthropic.js and
// src/openai.js list is what the dropdown offers, the same for every account.
// Hugging Face is different by design (src/hf-inference.js): its router serves
// an open catalog nobody curated, at prices that span two orders of magnitude.
// So an HF model reaches the dropdown by a DECISION rather than by existing —
// the user browses the catalog in the Hugging Face agent, reads the cost, and
// accepts it. This module is where that acceptance rests, and it is what makes
// "found it in the HF agent" turn into "available in Deep Research,
// Introspection, Agent Studio and Orchestrator too".
//
// Storage: the `hf_models` key of `users.settings_json` — the additive D1
// column the feature knobs already live in, so no migration. settings.js
// preserves non-knob keys when it writes a knob (mergeStoredSettings), which is
// what keeps a settings PUT from wiping an account's accepted models.
//
// A stored entry is a SNAPSHOT taken at acceptance time (name, both prices, the
// serving provider, vision) rather than a pointer into the live catalog. Two
// reasons, both load-bearing:
//   1. Billing must not depend on a third-party fetch. src/billing.js prices a
//      finished request off the catalog entry; if that entry only existed while
//      router.huggingface.co answered, an outage would silently bill the
//      request at zero.
//   2. The price the user AGREED TO is the price they keep until they say
//      otherwise. A provider raising its rate does not silently raise this
//      account's bill — the agent re-checks and offers the new price instead.
// The staleness that buys is real and deliberate; hfRefreshNotes() below is how
// the UI surfaces it.

import { getDb } from "./db.js";
import { hfModelId, parseHfModelId } from "./hf-inference.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./settings.js').Identity} Identity */

/** The settings_json key holding the list. WIRE NAME — do not change. */
export const ACCEPTED_KEY = "hf_models";

/** A hard structural cap, above any admin allowance: a settings_json row is
 * not a database table, and an unbounded list would bloat every identity load
 * on every request. The allowance (src/hf-inference.js hfAllowance) is the
 * product limit; this is the safety one. */
export const MAX_STORED = 24;

/**
 * One accepted model, as stored and as served to the client.
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
 * Tolerant parse of one stored entry — the same discipline as
 * settings.js parseSettings: an unreadable or malformed row is dropped, never
 * thrown over. Returns null when the entry can't be trusted to price a request.
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
 * The accepted list out of a stored settings_json value. Always an array.
 * @param {unknown} json the stored settings_json string (or a pre-parsed object)
 * @returns {AcceptedModel[]}
 */
export function parseAcceptedModels(json) {
  /** @type {any} */
  let raw = {};
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    return [];
  }
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

/**
 * The identity's accepted models ([] for the break-glass operator, which has no
 * D1 row to hang a per-account decision on).
 * @param {Identity | null | undefined} identity
 * @returns {AcceptedModel[]}
 */
export function acceptedModels(identity) {
  if (!identity?.user) return [];
  return parseAcceptedModels(identity.user.settings_json);
}

/**
 * Build a storable entry from a browse row (src/hf-inference.js hfBrowseItem).
 * Returns null when the row can't be priced — an entry with no rate would bill
 * every request at zero, which is the one failure mode this store must not
 * have.
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
 * Persist a whole list against a user row, preserving the knob half of
 * settings_json. Writes through src/settings.js so there is ONE place that
 * knows how the column is laid out.
 * @param {Env} env
 * @param {Identity} identity
 * @param {AcceptedModel[]} list
 * @returns {Promise<AcceptedModel[]>} the stored list
 */
export async function saveAcceptedModels(env, identity, list) {
  const db = await getDb(env);
  if (!db || !identity.user) throw new Error("Database not configured.");
  const trimmed = list.slice(0, MAX_STORED);
  const { mergeStoredSettings } = await import("./settings.js");
  const merged = mergeStoredSettings(identity.user.settings_json, { [ACCEPTED_KEY]: trimmed });
  await db
    .prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(merged), identity.user.id)
    .run();
  // Keep the in-request identity consistent with what was just written, so a
  // handler that answers with the fresh catalog doesn't re-read D1.
  identity.user.settings_json = JSON.stringify(merged);
  return trimmed;
}

/**
 * Accept a model (idempotent: re-accepting refreshes the snapshot in place, so
 * "the price changed, take the new one" is the same call as "enable it").
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
 * Drop an accepted model. Matches on the full catalog id OR the bare repo id,
 * so "remove Qwen3.6-27B" works without the caller reconstructing the pinned
 * provider suffix.
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
 * Which accepted models the live catalog now prices differently (or no longer
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
