// @ts-check
// OUTROSPECTION — the Worker façade over the ONE shared core
// public/js/outrospect-core.js (the lens registry, the item shape, the delta,
// the merge), plus the three endpoints the domain owns.
//
// Introspection answers "what am I made of" from a committed snapshot of this
// repo. Outrospection answers the opposite question — "what is everyone else
// building, and does it change what I should be" — from the live web, through
// seven fixed lenses (see the core's header for why each one exists).
//
//   GET  /api/outrospect/feed      the live stream: every item a scan or a
//                                  visitor refresh has ever added, newest
//                                  first. ?lens= ?since= ?limit= ?format=text
//   POST /api/outrospect/refresh   run the searches for ONE lens on behalf of
//                                  the visiting user, store the delta, return
//                                  the genuinely new items. This is the
//                                  "while you are here, go look" call the view
//                                  fires on load.
//   GET  /api/admin/outrospect     the operator read surface (admin-gated in
//                                  admin-api.js): the feed plus the run log,
//                                  chatlogs-style, with ?format=text for the
//                                  agent loop.
//
// The feed the user READS is the merge of two streams (core mergeFeed):
// the committed artifact public/outrospect/feed.json — written by
// scripts/outrospect-scan.mjs, so the feed is never empty and works with no
// D1 at all — and the D1 `outrospect_items` rows added since. The client does
// that merge (it already has the artifact as a static asset), which keeps the
// Worker out of the asset-reading business and puts the merge in the pure,
// unit-tested core.
//
// Privacy posture (invariant 4): a refresh sends a QUERY to the search
// provider and nothing else — no identity, no conversation, no note the user
// wrote. The queries are the literal strings committed in the lens registry,
// so what leaves the site is auditable in git. The stored row carries the
// article, never the reader: `outrospect_items` has NO user column at all.
// The run log records who spent a search only because the rate limit needs
// it, and carries no query text beyond the lens id.
//
// Fail posture (invariant 2): every search is fail-soft — a dead provider
// yields zero new items and an ok response, never a 500. No D1 → 503 on the
// two D1-backed endpoints and the VIEW keeps working off the committed
// artifact; only the live half degrades.

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { webSearch } from "./exa.js";
import {
  FRESH_WINDOW_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeItemUrl,
  normalizeLens,
  refreshQueries,
  stalestLens,
  validateFeedItem,
} from "../public/js/outrospect-core.js";

export {
  FRESH_WINDOW_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeItemUrl,
  normalizeLens,
  refreshQueries,
  stalestLens,
  validateFeedItem,
};

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/** @typedef {import('../public/js/outrospect-core.js').FeedItem} FeedItem */
/**
 * A D1 `outrospect_items` row. Deliberately identity-free.
 * @typedef {{ id: number, key: string, lens: string, title: string, url: string, teaser?: string | null, source?: string | null, first_seen: number, query?: string | null }} ItemRow
 */

// A refresh body is a lens id and a list of keys the client already holds;
// anything larger is not a refresh body.
const BODY_MAX = 200_000;

// How often ONE lens may be searched, across all visitors. A lens whose
// newest item is minutes old has nothing to gain from searching again, and
// every refresh is real money at the search provider — so a visit rides the
// last visitor's results when it arrives inside the window. This is what
// makes "refresh on every visit" affordable rather than reckless.
export const LENS_COOLDOWN_MS = 30 * 60 * 1000;

// How many refreshes one user may trigger per hour. The view fires ONE on
// load, so this only bites on someone holding the manual button down.
export const USER_RUNS_PER_HOUR = 8;

// The search depth a refresh runs at. Deliberately shallow: a feed wants
// headlines across many queries, not a deep read of any one of them (that is
// what the research pipeline is for — an item's URL is a normal chat away).
export const REFRESH_DEPTH = { numResults: 6, type: "auto" };

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/outrospect.test.js
// ---------------------------------------------------------------------------

/**
 * Validate a refresh body: an optional lens (clamped to the registry, or
 * "auto" to let the server pick the stalest) and the client's known keys.
 * @param {unknown} body
 * @returns {{ error: string } | { error?: undefined, lens: string | null, known: string[] }}
 */
export function validateRefreshBody(body) {
  const o = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const rawLens = typeof o.lens === "string" ? o.lens.trim() : "";
  if (rawLens && rawLens !== "auto" && !LENS_IDS.includes(rawLens)) {
    return { error: `Unknown lens "${rawLens}".` };
  }
  const rawKnown = Array.isArray(o.known) ? o.known : [];
  if (rawKnown.length > OUTROSPECT_CAPS.known) {
    return { error: `Too many known keys (max ${OUTROSPECT_CAPS.known}).` };
  }
  const known = [];
  for (const k of rawKnown) {
    const key = normalizeItemUrl(k);
    if (key) known.push(key);
  }
  return { lens: rawLens && rawLens !== "auto" ? rawLens : null, known };
}

/**
 * Project a D1 row to the wire shape the core validates.
 * @param {ItemRow} row
 * @returns {FeedItem | null}
 */
export function projectItem(row) {
  const v = validateFeedItem({
    lens: row.lens,
    title: row.title,
    url: row.url || row.key,
    teaser: row.teaser || "",
    source: row.source || "",
    first_seen: row.first_seen,
    query: row.query || "",
  });
  return v.ok ? v.value : null;
}

/**
 * The lenses currently on cooldown, from the run log.
 * @param {{ lens: string, ts: number }[]} runs
 * @param {number} now
 * @param {number} [cooldownMs]
 * @returns {string[]}
 */
export function lensesOnCooldown(runs, now, cooldownMs = LENS_COOLDOWN_MS) {
  const out = new Set();
  for (const r of runs || []) {
    if (now - Number(r.ts) < cooldownMs) out.add(String(r.lens));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Every stored item, newest first.
 * @param {D1Database} db
 * @param {{ lens?: string | null, since?: number, limit?: number }} [opts]
 * @returns {Promise<FeedItem[]>}
 */
export async function loadItems(db, { lens = null, since = 0, limit = OUTROSPECT_CAPS.items } = {}) {
  const where = ["first_seen > ?"];
  /** @type {(string | number)[]} */
  const binds = [Number(since) || 0];
  if (lens) {
    where.push("lens = ?");
    binds.push(lens);
  }
  const { results } = await db
    .prepare(
      `SELECT id, key, lens, title, url, teaser, source, first_seen, query FROM outrospect_items
       WHERE ${where.join(" AND ")} ORDER BY first_seen DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, Math.max(1, Math.min(OUTROSPECT_CAPS.items, limit)))
    .all();
  /** @type {FeedItem[]} */
  const items = [];
  for (const row of /** @type {ItemRow[]} */ (results || [])) {
    const item = projectItem(row);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Insert the delta. The `key` column is UNIQUE and the insert is OR IGNORE, so
 * two visitors refreshing the same lens at once cannot double-file an article
 * and the earliest first_seen always wins.
 * @param {D1Database} db
 * @param {FeedItem[]} items
 * @returns {Promise<number>} rows actually written
 */
export async function storeItems(db, items) {
  let written = 0;
  for (const i of items) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO outrospect_items (key, lens, title, url, teaser, source, first_seen, query)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(i.key, i.lens, i.title, i.url, i.teaser || null, i.source || null, i.first_seen, i.query || null)
      .run();
    if (res?.meta?.changes) written += res.meta.changes;
  }
  return written;
}

// ---------------------------------------------------------------------------
// GET /api/outrospect/feed
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleOutrospectFeed(env, url) {
  const db = await getDb(env);
  if (!db) {
    // No D1: the view still renders the committed artifact. Say so plainly
    // instead of erroring, so the client can show "live half unavailable"
    // rather than a broken page.
    return jsonResponse({ items: [], tally: lensTally([]), live: false, lenses: OUTROSPECT_LENSES });
  }
  const lens = url.searchParams.get("lens");
  const items = mergeFeed([
    await loadItems(db, {
      lens: lens && LENS_IDS.includes(lens) ? lens : null,
      since: Number(url.searchParams.get("since")) || 0,
      limit: Number(url.searchParams.get("limit")) || OUTROSPECT_CAPS.items,
    }),
  ]);
  if (url.searchParams.get("format") === "text") {
    return textResponse(formatFeedText(items, { title: "OUTROSPECTION FEED — live items (newest first)" }));
  }
  return jsonResponse({ items, tally: lensTally(items), live: true, lenses: OUTROSPECT_LENSES });
}

// ---------------------------------------------------------------------------
// POST /api/outrospect/refresh — the look-outward-on-your-behalf call
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleOutrospectRefresh(request, env, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "The live feed is not available (no database configured)." }, 503);

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: "Unreadable body." }, 400);
  }
  if (raw.length > BODY_MAX) return jsonResponse({ error: "Body too large." }, 413);
  let body = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }
  }
  const parsed = validateRefreshBody(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const v = /** @type {{ lens: string | null, known: string[] }} */ (parsed);

  const now = Date.now();
  const userId = String(identity?.id || identity?.email || "anon");

  // Rate limit + cooldown, both read off the run log in one query.
  const { results: runRows } = await db
    .prepare("SELECT lens, ts, user_id FROM outrospect_runs WHERE ts > ? ORDER BY ts DESC LIMIT 500")
    .bind(now - Math.max(LENS_COOLDOWN_MS, 3600_000))
    .all();
  const runs = /** @type {{ lens: string, ts: number, user_id: string }[]} */ (runRows || []);
  const mine = runs.filter((r) => r.user_id === userId && now - Number(r.ts) < 3600_000);
  if (mine.length >= USER_RUNS_PER_HOUR) {
    return jsonResponse(
      { error: "You have refreshed the outward feed enough times this hour — it will keep updating on its own.", fresh: [], limited: true },
      429,
    );
  }

  const cooling = lensesOnCooldown(runs, now);
  // An explicit pick is honoured unless it is the one thing on cooldown; with
  // no pick the server chooses the lens whose newest item is oldest, so
  // repeat visits heal the feed's thin spots instead of re-searching whatever
  // is already busiest.
  let lens = v.lens;
  if (lens && cooling.includes(lens)) {
    return jsonResponse({ lens, fresh: [], cooled: true, retry_after_ms: LENS_COOLDOWN_MS }, 200);
  }
  if (!lens) {
    const stored = await loadItems(db, {});
    const eligible = LENS_IDS.filter((id) => !cooling.includes(id));
    if (!eligible.length) {
      return jsonResponse({ lens: null, fresh: [], cooled: true, retry_after_ms: LENS_COOLDOWN_MS }, 200);
    }
    lens = stalestLens(stored, { skip: cooling });
  }

  // Walk the lens's queries across successive runs so every one gets its turn
  // rather than the first N being the only ones ever issued.
  const offset = runs.filter((r) => r.lens === lens).length;
  const queries = refreshQueries(lens, { offset });

  /** @type {any[]} */
  const found = [];
  let failures = 0;
  for (const query of queries) {
    // Fail-soft per query (invariant 2): a dead provider costs this query's
    // results, never the request. webSearch already returns errors as content
    // strings rather than throwing, but a rejection here must not escape either.
    try {
      const res = await webSearch(env, log, query, REFRESH_DEPTH);
      for (const item of res.items || []) {
        const fi = feedItemFromSearch(lens, item, { now, query });
        if (fi) found.push(fi);
      }
      if (!res.resultCount) failures++;
    } catch (err) {
      failures++;
      log.warn("outrospect.search_failed", { lens, error: String(err) });
    }
  }

  // The DELTA: what neither the client nor the store already had. The client's
  // `known` covers the committed artifact (which the server never reads), the
  // store covers everything a previous visitor's refresh added.
  const stored = await loadItems(db, { lens });
  const fresh = deltaItems([...v.known, ...stored.map((i) => i.key)], found);
  const written = fresh.length ? await storeItems(db, fresh) : 0;

  await db
    .prepare("INSERT INTO outrospect_runs (ts, user_id, lens, queries, found) VALUES (?, ?, ?, ?, ?)")
    .bind(now, userId, lens, queries.length, fresh.length)
    .run();

  log.info("outrospect.refresh", {
    lens,
    queries: queries.length,
    found: found.length,
    fresh: fresh.length,
    written,
    failures,
  });
  return jsonResponse({ lens, fresh, searched: queries.length, degraded: failures > 0 && !fresh.length });
}

// ---------------------------------------------------------------------------
// GET /api/admin/outrospect — the operator/agent-loop view
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAdminOutrospect(env, url) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database is not configured." }, 503);
  const lens = url.searchParams.get("lens");
  const items = mergeFeed([
    await loadItems(db, {
      lens: lens && LENS_IDS.includes(lens) ? lens : null,
      limit: Number(url.searchParams.get("limit")) || OUTROSPECT_CAPS.items,
    }),
  ]);
  const { results: runRows } = await db
    .prepare("SELECT id, ts, user_id, lens, queries, found FROM outrospect_runs ORDER BY id DESC LIMIT 50")
    .all();
  const runs = runRows || [];
  if (url.searchParams.get("format") === "text") {
    const head = formatFeedText(items, { title: "OUTROSPECTION — live feed (newest first)" });
    const lines = ["", "RECENT REFRESH RUNS", ""];
    for (const r of runs) {
      lines.push(
        `#${r.id} ${new Date(Number(r.ts)).toISOString()} ${String(r.lens).padEnd(18)} ` +
          `${r.queries} queries → ${r.found} new`,
      );
    }
    if (!runs.length) lines.push("(no refresh has run yet)");
    return textResponse(head + lines.join("\n") + "\n");
  }
  return jsonResponse({ items, tally: lensTally(items), runs, lenses: OUTROSPECT_LENSES });
}
